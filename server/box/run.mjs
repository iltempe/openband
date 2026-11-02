// `openband box`: the store, the rooms, the studio on the LAN and the recorder, in one always-on process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recorder, SAMPLE_RATE, captureCommand, findTool, installHint, parseDevices, pendingSessions, recoverSession, startCapture, stitchChannel } from './capture.mjs';
import { applyFlags, dataDir, newPin, parseArgs, readBox, toForget, writeBox } from './config.mjs';
import { importSession } from './project.mjs';
import { installService, uninstallService } from './service.mjs';
import { spawnSync } from 'node:child_process';

const sizeOf = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? sizeOf(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
const lanUrls = (port) =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${port}`);

export function listDevices(platform = process.platform) {
  if (platform === 'linux') {
    const a = spawnSync('arecord', ['-L'], { encoding: 'utf8' });
    return a.error ? [] : parseDevices(a.stdout, 'linux');
  }
  const args = platform === 'darwin' ? ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''] : ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  return r.error ? [] : parseDevices(`${r.stdout}${r.stderr}`, platform);
}

/** What a running Box is: sessions on disk, the recorder, and the actions of the panel and the buttons. */
export class Box {
  constructor({ dir, cfg, store, emit = () => {}, log = () => {} }) {
    Object.assign(this, { dir, cfg, store, emit, log });
    this.sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.error = null;
    this.level = -120;
    this.recorder = new Recorder({
      dir: this.sessionsDir,
      channels: cfg.channels,
      gate: { thresholdDb: cfg.threshold, endMs: cfg.endMs },
      on: (e) => this.onRecorder(e),
    });
  }

  onRecorder(e) {
    this.emit({ kind: 'box_state', state: e.type, session: e.session });
    if (e.type === 'end') this.finish(path.join(this.sessionsDir, e.session));
  }

  /** Into the song, and the retention rule. A failure leaves the WAVs: the next start tries again. */
  finish(dir) {
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    try {
      const r = importSession({ store: this.store, dir, info, names: this.cfg.names, projectId: this.cfg.projectId, projectName: this.cfg.project, emit: this.emit });
      if (r.projectId !== this.cfg.projectId) {
        this.cfg.projectId = r.projectId;
        writeBox(this.dir, this.cfg);
      }
      fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ ...info, imported: r.versionId, projectId: r.projectId }));
    } catch (e) {
      this.error = `Session ${info.id} not imported: ${e.message}`;
      this.log(this.error);
    }
    this.applyRetention();
  }

  /** At start: sessions cut by a power failure, and any left unimported. */
  recover() {
    for (const s of pendingSessions(this.sessionsDir)) this.finish(s.dir);
    for (const s of this.sessions()) if (!s.imported) this.finish(path.join(this.sessionsDir, s.id));
  }

  sessions() {
    if (!fs.existsSync(this.sessionsDir)) return [];
    return fs
      .readdirSync(this.sessionsDir)
      .map((id) => {
        const file = path.join(this.sessionsDir, id, 'session.json');
        if (!fs.existsSync(file)) return null;
        const i = JSON.parse(fs.readFileSync(file, 'utf8'));
        return i.closed ? { id, at: i.startedAt, seconds: (i.endFrame ?? 0) / SAMPLE_RATE, songs: (i.cuts?.length ?? 0) + 1, channels: i.channels, marks: i.marks?.length ?? 0, imported: i.imported, projectId: i.projectId, starred: !!i.starred, recovered: !!i.recovered, bytes: sizeOf(path.join(this.sessionsDir, id)) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at);
  }

  applyRetention() {
    for (const s of toForget(this.sessions(), this.cfg.keep)) fs.rmSync(path.join(this.sessionsDir, s.id), { recursive: true, force: true });
  }

  star(id, on = true) {
    const file = path.join(this.sessionsDir, id.replace(/[^\w]/g, ''), 'session.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), starred: on }));
  }

  /** One channel of a session as a WAV, for the download. */
  channelFile(id, channel) {
    const dir = path.join(this.sessionsDir, id.replace(/[^\w]/g, ''));
    const out = path.join(dir, `ch${Number(channel)}.wav`);
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    if (!fs.existsSync(out)) stitchChannel(dir, Number(channel), out, info.endFrame);
    return out;
  }

  /** The privacy switch: nothing is recorded until it is on again. */
  arm(on) {
    this.cfg.armed = on;
    writeBox(this.dir, this.cfg);
    if (!on) this.recorder.force(false);
  }

  status() {
    const r = this.recorder;
    let disk = null;
    try {
      const s = fs.statfsSync(this.dir);
      disk = { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    } catch {
      // older Node
    }
    return { state: !this.cfg.armed ? 'off' : r.session ? 'recording' : 'armed', level: r.gate.level ?? -120, session: r.session?.id ?? null, channels: this.cfg.channels, names: this.cfg.names, project: this.cfg.project, keep: this.cfg.keep, error: this.error, disk };
  }
}

function report(cfg) {
  const urls = [`http://openband.local:${cfg.port}`, ...lanUrls(cfg.port)];
  return `OpenBand Box\n  studio:  ${urls.join('\n           ')}\n  PIN:     ${cfg.pin}\n  This records everyone in the room. Turn it off with: openband box off, or a long press on REC.`;
}

async function serve(dir, cfg, sourceFile) {
  process.env.OPENBAND_STDIO = '0';
  process.env.OPENBAND_OPEN_BROWSER ??= '0';
  process.env.OPENBAND_HOST ??= '0.0.0.0';
  process.env.OPENBAND_COLLAB ??= '1';
  process.env.OPENBAND_STORE = '1';
  process.env.OPENBAND_DATA = path.join(dir, 'library');
  process.env.OPENBAND_PORT = String(cfg.port);
  process.env.OPENBAND_PAIR_CODE = cfg.pin;
  const { storeApi } = await import('../mcp-server.mjs');
  if (!storeApi) throw new Error('The project store could not start');
  const box = new Box({ dir, cfg, store: storeApi.store, emit: storeApi.emit, log: console.error });
  storeApi.box = box;
  box.recover();
  console.error(report(cfg));
  const stop = () => {
    box.recorder.stop();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // Tests and demos: a raw PCM file instead of a device.
  if (sourceFile) {
    const feed = fs.createReadStream(sourceFile, { highWaterMark: 48000 * 3 * cfg.channels });
    feed.on('data', (d) => cfg.armed && box.recorder.feed(d));
    return box;
  }
  const tool = findTool();
  if (!tool) {
    box.error = `No capture tool: install ffmpeg (${installHint()}). The studio works; nothing is being recorded.`;
    console.error(box.error);
    return box;
  }
  const start = () => {
    const child = startCapture({ feed: (d) => cfg.armed && box.recorder.feed(d) }, captureCommand({ tool, device: cfg.device, channels: cfg.channels }), { onError: (m) => (box.error = `Capture: ${m}`) });
    child.on('exit', () => setTimeout(start, 3000));
  };
  start();
  return box;
}

export async function boxCli(args) {
  const { sub, flags } = parseArgs(args);
  const dir = flags.data ? String(flags.data) : dataDir();
  const saved = readBox(dir);
  const cfg = applyFlags(saved, flags);
  cfg.pin ??= newPin();
  const bin = path.resolve(new URL('../../bin/openband.mjs', import.meta.url).pathname);
  switch (sub) {
    case undefined:
    case null:
      writeBox(dir, cfg);
      await serve(dir, cfg, flags.source ? String(flags.source) : undefined);
      return;
    case 'devices': {
      const list = listDevices();
      if (!list.length) console.log(`No input found. Is ffmpeg installed? (${installHint()})`);
      for (const d of list) console.log(`${d.id}\t${d.name}`);
      return;
    }
    case 'install': {
      writeBox(dir, cfg);
      console.log(installService({ bin, data: dir }));
      console.log(report(cfg));
      return;
    }
    case 'uninstall':
      uninstallService({});
      console.log('Service removed. Your recordings stay in', dir);
      return;
    case 'status': {
      const r = await fetch(`http://127.0.0.1:${cfg.port}/api/store/v1/box/status`).catch(() => null);
      if (!r?.ok) {
        console.log(`Not running. Data in ${dir}.`);
        return;
      }
      const s = await r.json();
      console.log(`${s.state}, level ${Math.round(s.level)} dB, project "${s.project}"${s.session ? `, session ${s.session}` : ''}`);
      if (s.disk) console.log(`disk: ${(s.disk.free / 1e9).toFixed(1)} GB free`);
      if (s.error) console.log(s.error);
      return;
    }
    case 'on':
    case 'off': {
      const r = await fetch(`http://127.0.0.1:${cfg.port}/api/store/v1/box/${sub === 'on' ? 'arm' : 'disarm'}`, { method: 'POST' }).catch(() => null);
      if (!r?.ok) writeBox(dir, { ...cfg, armed: sub === 'on' });
      console.log(sub === 'on' ? 'Recording is on.' : 'Recording is off.');
      return;
    }
    default:
      throw new Error(`Unknown: openband box ${sub}`);
  }
}

export { recoverSession };
