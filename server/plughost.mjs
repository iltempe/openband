// The Node side of openband-plughost (G8): finding the installed native plugins (each bundle scanned in
// a process of its own, with a timeout: a plugin that hangs or crashes only lands on the ignore list),
// and one host process per plugin instance, spoken to over its stdin/stdout (see native/plughost/src).
// Used by the desktop app's main process. Plugins are only loaded from the standard folders or from
// folders the user adds, never from a URL.
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The "path" of every Audio Unit (G8.6): they live in the system's registry, not in files. */
export const AU = 'au:';
const EXE = process.platform === 'win32' ? 'openband-plughost.exe' : 'openband-plughost';

/** Where the host binary is: OPENBAND_PLUGHOST, the app's resources, or a development build. */
export function hostBinary(extra = []) {
  const candidates = [process.env.OPENBAND_PLUGHOST, ...extra, path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'plughost', EXE)].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** The standard CLAP folders of a platform (SPEC v0.6 G8). */
export function clapDirs(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return [path.join(home, 'Library/Audio/Plug-Ins/CLAP'), '/Library/Audio/Plug-Ins/CLAP'];
  if (platform === 'win32') return [path.join(env.COMMONPROGRAMFILES ?? 'C:\\Program Files\\Common Files', 'CLAP'), path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'Common', 'CLAP')];
  return [path.join(home, '.clap'), '/usr/lib/clap', '/usr/local/lib/clap'];
}

/** The standard VST3 folders of a platform (G8.5). */
export function vst3Dirs(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return [path.join(home, 'Library/Audio/Plug-Ins/VST3'), '/Library/Audio/Plug-Ins/VST3'];
  if (platform === 'win32') return [path.join(env.COMMONPROGRAMFILES ?? 'C:\\Program Files\\Common Files', 'VST3'), path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'Common', 'VST3')];
  return [path.join(home, '.vst3'), '/usr/lib/vst3', '/usr/local/lib/vst3'];
}

/** Every standard plugin folder of a platform: CLAP and VST3. */
export const pluginDirs = (platform = process.platform, env = process.env, home = os.homedir()) => [...clapDirs(platform, env, home), ...vst3Dirs(platform, env, home)];

/**
 * Plugin bundles under some folders, two levels deep: .clap (a folder on macOS, a file elsewhere) and .vst3
 * (a folder, or a single file on Windows). A bundle is never looked into.
 */
export function findBundles(dirs) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (/\.(clap|vst3)$/i.test(e.name)) out.push(p);
      else if (e.isDirectory() && depth < 2) walk(p, depth + 1);
    }
  };
  for (const d of dirs) walk(d, 0);
  return [...new Set(out)].sort();
}

const kindOf = (features = []) => (features.includes('instrument') ? 'instrument' : features.includes('note-effect') ? 'note-effect' : 'effect');

/** Scans in progress, killed by stopScans() (an app quitting mid-scan must not leave a hung plugin behind). */
const scanning = new Set();
export function stopScans() {
  for (const c of scanning) c.kill('SIGKILL');
  scanning.clear();
}

/** Scan one bundle in its own process; rejects on timeout, crash or bad output. */
export function scanBundle(host, bundle, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = execFile(host, ['scan', bundle], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 << 20, windowsHide: true }, (err, stdout, stderr) => {
      scanning.delete(child);
      if (err) {
        const why = err.killed || err.signal === 'SIGKILL' ? `did not answer in ${Math.round(timeoutMs / 1000)} s` : err.signal ? `crashed (${err.signal})` : String(stderr || err.message).trim().split('\n')[0];
        return reject(new Error(why));
      }
      try {
        const { plugins } = JSON.parse(stdout);
        resolve(plugins.map((p) => ({ format: bundle === AU ? 'au' : /\.vst3$/i.test(bundle) ? 'vst3' : 'clap', ...p, kind: kindOf(p.features), path: bundle })));
      } catch {
        reject(new Error('the scan returned something that is not a plugin list'));
      }
    });
    scanning.add(child);
  });
}

/**
 * Scan the folders, reusing what didn't change (cache by path + modification time). Bundles that hang or
 * crash go on the ignore list with the reason, until `retry` names them. On macOS the Audio Units come from
 * the system's registry (path "au:"), listed without being loaded, every time.
 */
export async function scanPlugins({ host = hostBinary(), dirs = pluginDirs(), cacheFile = null, timeoutMs = 10000, retry = [], audioUnits = process.platform === 'darwin' } = {}) {
  if (!host) throw new Error('The plugin host (openband-plughost) is not installed');
  let cache = { bundles: {} };
  if (cacheFile)
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {}
  const next = { bundles: {} };
  const plugins = [];
  const failed = [];
  for (const b of findBundles(dirs)) {
    let mtime = 0;
    try {
      mtime = fs.statSync(b).mtimeMs;
    } catch {}
    const old = cache.bundles?.[b];
    let entry = old && old.mtime === mtime && !retry.includes(b) ? old : null;
    if (!entry) {
      try {
        entry = { mtime, plugins: await scanBundle(host, b, timeoutMs) };
      } catch (e) {
        entry = { mtime, failed: e.message };
      }
    }
    next.bundles[b] = entry;
    if (entry.failed) failed.push({ path: b, reason: entry.failed });
    else plugins.push(...entry.plugins);
  }
  if (audioUnits)
    try {
      plugins.push(...(await scanBundle(host, AU, timeoutMs)));
    } catch (e) {
      failed.push({ path: AU, reason: e.message });
    }
  if (cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(next));
  }
  return { plugins, failed };
}

// ---------------------------------------------------------------- one plugin in a host process

const T = { LOAD: 1, PROCESS: 2, PARAM: 3, GET_STATE: 4, SET_STATE: 5, QUIT: 6, GUI_OPEN: 7, GUI_CLOSE: 8, GET_VALUES: 10, RENDER_MODE: 11, MONITOR: 12, LIVE: 13 };
const R = { LOADED: 1, BLOCK: 2, STATE: 4, STATE_SET: 5, LATENCY: 7, ERROR: 8, PARAM_CHANGED: 9, GESTURE: 10, STATE_DIRTY: 11, GUI: 12, VALUES: 13, MONITOR: 14, HEARD: 15 };
/** Event kinds inside a block (see native/plughost/src/plughost.c). */
export const EVENT = { NOTE_ON: 0, NOTE_OFF: 1, PARAM: 2, ALL_NOTES_OFF: 3 };

function writeEvent(b, o, e, frames) {
  b.writeUInt32LE(Math.max(0, Math.min(frames - 1, e.offset | 0)), o);
  b.writeUInt8(e.kind, o + 4);
  b.writeUInt8((e.key ?? 0) & 127, o + 5);
  b.writeUInt32LE(e.id ?? 0, o + 8);
  b.writeDoubleLE(e.value ?? 0, o + 12);
}

function frame(type, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(5 + payload.length);
  b.writeUInt32LE(1 + payload.length, 0);
  b.writeUInt8(type, 4);
  payload.copy(b, 5);
  return b;
}

/**
 * A host process serving one plugin. Events: 'block' {seq, channels}, 'latency' n, 'param' {id, value}
 * (moved in the plugin's window), 'gesture' {id, begin}, 'dirty' (its state changed), 'gui' {open}
 * (its window opened or closed), 'heard' {wait, offset, buffer, total} (a live note reached the output, in
 * frames — monitoring only), 'exit' {code, signal, crashed}. Blocks are planar Float32Arrays.
 */
export class PlugHostSession extends EventEmitter {
  constructor(host = hostBinary()) {
    super();
    if (!host) throw new Error('The plugin host (openband-plughost) is not installed');
    this.proc = spawn(host, ['host'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.buf = Buffer.alloc(0);
    this.waiting = [];
    this.closing = false;
    this.alive = true;
    this.stderr = '';
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    this.proc.stdin.on('error', () => {});
    this.proc.on('exit', (code, signal) => {
      this.alive = false;
      const crashed = !this.closing;
      for (const w of this.waiting.splice(0)) w.reject(new Error(crashed ? `the plugin host stopped (${signal ?? code})` : 'closed'));
      this.emit('exit', { code, signal, crashed, stderr: this.stderr });
    });
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      const type = this.buf.readUInt8(4);
      const payload = this.buf.subarray(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      if (type === R.BLOCK) {
        const seq = payload.readUInt32LE(0);
        const frames = payload.readUInt32LE(4);
        const nch = payload.readUInt32LE(8);
        const all = new Float32Array(payload.buffer.slice(payload.byteOffset + 12, payload.byteOffset + 12 + nch * frames * 4));
        const channels = Array.from({ length: nch }, (_, c) => all.slice(c * frames, (c + 1) * frames));
        this.emit('block', { seq, channels });
      } else if (type === R.LATENCY) this.emit('latency', JSON.parse(payload.toString('utf8')).latency);
      else if (type === R.PARAM_CHANGED) this.emit('param', JSON.parse(payload.toString('utf8')));
      else if (type === R.GESTURE) this.emit('gesture', JSON.parse(payload.toString('utf8')));
      else if (type === R.STATE_DIRTY) this.emit('dirty');
      else if (type === R.HEARD) this.emit('heard', JSON.parse(payload.toString('utf8')));
      else if (type === R.GUI && !this.waiting.some((x) => x.type === R.GUI)) this.emit('gui', JSON.parse(payload.toString('utf8')));
      else {
        const w = this.waiting.find((x) => x.type === type || type === R.ERROR);
        if (w) {
          this.waiting.splice(this.waiting.indexOf(w), 1);
          w.resolve(type === R.STATE ? Buffer.from(payload) : JSON.parse(payload.toString('utf8')));
        }
      }
    }
  }

  request(type, payload, reply, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const w = { type: reply, resolve, reject };
      this.waiting.push(w);
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(w);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new Error('the plugin host did not answer'));
      }, timeoutMs);
      const done = (fn) => (v) => (clearTimeout(timer), fn(v));
      w.resolve = done(resolve);
      w.reject = done(reject);
      this.write(frame(type, payload));
    });
  }

  write(b) {
    if (this.alive) this.proc.stdin.write(b);
  }

  /** Load a plugin: {path, id, sampleRate, maxBlock} → {name, latency, inputs, outputs, params}. */
  async load({ path: p, id, sampleRate = 48000, maxBlock = 128 }) {
    const r = await this.request(T.LOAD, Buffer.from(`${p}\0${id}\0${sampleRate}\0${maxBlock}\0`, 'utf8'), R.LOADED);
    if (!r.ok) throw new Error(r.error ?? 'the plugin did not load');
    return r;
  }

  /**
   * Send a block (planar channels) with its events — notes and parameter changes at a sample offset, in
   * time order: {offset, kind (EVENT), key?, id?, value?}. The answer comes as a 'block' event, same seq.
   */
  process(seq, channels, events = []) {
    const frames = channels[0]?.length ?? 128;
    const ev = events.length;
    const b = Buffer.alloc(16 + ev * 20 + channels.length * frames * 4);
    b.writeUInt32LE(seq, 0);
    b.writeUInt32LE(frames, 4);
    b.writeUInt32LE(channels.length, 8);
    b.writeUInt32LE(ev, 12);
    events.forEach((e, i) => writeEvent(b, 16 + i * 20, e, frames));
    const at = 16 + ev * 20;
    channels.forEach((c, i) => Buffer.from(c.buffer, c.byteOffset, frames * 4).copy(b, at + i * frames * 4));
    this.write(frame(T.PROCESS, b));
  }

  /**
   * Low-latency monitoring (G8.7): the host plays the plugin on the computer's audio output itself, with a
   * buffer of `period` frames (`nullDevice`: no sound, real timing — tests). While it is on, blocks come
   * back silent and their events play `lead` frames later there, at `gain` and `pan`; live() notes play at
   * the next period. → {on, backend, device, period, periods, deviceRate} or {on: false, error}.
   */
  monitor({ on = true, period = 128, nullDevice = false, lead = 0, gain = 1, pan = 0 } = {}) {
    const b = Buffer.alloc(18);
    b.writeUInt8(on ? 1 : 0, 0);
    b.writeUInt32LE(period, 1);
    b.writeUInt8(nullDevice ? 1 : 0, 5);
    b.writeUInt32LE(lead, 6);
    b.writeFloatLE(gain, 10);
    b.writeFloatLE(pan, 14);
    return this.request(T.MONITOR, b, R.MONITOR);
  }

  /** A note (or parameter) played now, on the host's own output (monitoring): {kind, key?, id?, value?}. */
  live(e) {
    const b = Buffer.alloc(20);
    writeEvent(b, 0, { ...e, offset: 0 }, 1);
    this.write(frame(T.LIVE, b));
  }

  /** Offline rendering (exports): the plugin may work faster than real time, at its best quality. */
  setRenderMode(offline) {
    this.write(frame(T.RENDER_MODE, Buffer.from([offline ? 1 : 0])));
  }

  /**
   * Process blocks [{n, data, events}] in order and resolve with their outputs [{n, data}] — the offline
   * path of exports, where every block must come back before the render goes on.
   */
  processBatch(blocks, timeoutMs = 30000) {
    if (!blocks.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const want = new Set(blocks.map((b) => b.n));
      const out = new Map();
      const onBlock = ({ seq, channels }) => {
        if (!want.has(seq)) return;
        out.set(seq, channels);
        if (out.size === want.size) done(null);
      };
      const onExit = () => done(new Error('the plugin host stopped during the export'));
      const timer = setTimeout(() => done(new Error('the plugin host did not answer during the export')), timeoutMs);
      const done = (err) => {
        clearTimeout(timer);
        this.off('block', onBlock);
        this.off('exit', onExit);
        if (err) reject(err);
        else resolve(blocks.map((b) => ({ n: b.n, data: out.get(b.n) })));
      };
      this.on('block', onBlock);
      this.once('exit', onExit);
      for (const b of blocks) this.process(b.n, b.data, b.events ?? []);
    });
  }

  /** Open the plugin's own window (floating above the app) → {open, supported?, error?}. */
  openGui(title) {
    return this.request(T.GUI_OPEN, Buffer.from(String(title), 'utf8'), R.GUI);
  }

  closeGui() {
    return this.request(T.GUI_CLOSE, Buffer.alloc(0), R.GUI).catch(() => ({ open: false }));
  }

  /** Current values of every parameter → [{id, value}]. */
  values() {
    return this.request(T.GET_VALUES, Buffer.alloc(0), R.VALUES);
  }

  setParam(id, value) {
    const b = Buffer.alloc(12);
    b.writeUInt32LE(id, 0);
    b.writeDoubleLE(value, 4);
    this.write(frame(T.PARAM, b));
  }

  getState() {
    return this.request(T.GET_STATE, Buffer.alloc(0), R.STATE);
  }

  async setState(bytes) {
    const r = await this.request(T.SET_STATE, Buffer.from(bytes), R.STATE_SET);
    return !!r.ok;
  }

  close() {
    this.closing = true;
    this.write(frame(T.QUIT));
    setTimeout(() => this.alive && this.proc.kill('SIGKILL'), 2000).unref();
  }
}
