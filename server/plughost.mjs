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

/** CLAP bundles under some folders (a .clap is a folder on macOS, a file elsewhere), two levels deep. */
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
      if (e.name.toLowerCase().endsWith('.clap')) out.push(p);
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
        resolve(plugins.map((p) => ({ format: 'clap', ...p, kind: kindOf(p.features), path: bundle })));
      } catch {
        reject(new Error('the scan returned something that is not a plugin list'));
      }
    });
    scanning.add(child);
  });
}

/**
 * Scan the folders, reusing what didn't change (cache by path + modification time). Bundles that hang or
 * crash go on the ignore list with the reason, until `retry` names them.
 */
export async function scanPlugins({ host = hostBinary(), dirs = clapDirs(), cacheFile = null, timeoutMs = 10000, retry = [] } = {}) {
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
  if (cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(next));
  }
  return { plugins, failed };
}

// ---------------------------------------------------------------- one plugin in a host process

const T = { LOAD: 1, PROCESS: 2, PARAM: 3, GET_STATE: 4, SET_STATE: 5, QUIT: 6 };
const R = { LOADED: 1, BLOCK: 2, STATE: 4, STATE_SET: 5, LATENCY: 7, ERROR: 8 };

function frame(type, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(5 + payload.length);
  b.writeUInt32LE(1 + payload.length, 0);
  b.writeUInt8(type, 4);
  payload.copy(b, 5);
  return b;
}

/**
 * A host process serving one plugin. Events: 'block' {seq, channels}, 'latency' n, 'exit' {code, signal,
 * crashed}. Blocks are sent and received as planar Float32Arrays.
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

  /** Send a block (planar channels); the answer comes as a 'block' event with the same seq. */
  process(seq, channels) {
    const frames = channels[0]?.length ?? 0;
    const b = Buffer.alloc(12 + channels.length * frames * 4);
    b.writeUInt32LE(seq, 0);
    b.writeUInt32LE(frames, 4);
    b.writeUInt32LE(channels.length, 8);
    channels.forEach((c, i) => Buffer.from(c.buffer, c.byteOffset, frames * 4).copy(b, 12 + i * frames * 4));
    this.write(frame(T.PROCESS, b));
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
