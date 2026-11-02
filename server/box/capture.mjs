// Native capture for the rehearsal Box (R2.3): ffmpeg (or arecord) as a child process gives PCM s24le 48 kHz;
// Node keeps a 5 s pre-roll, asks the gate, and writes one WAV per channel in segments of 5 minutes, so a
// power cut costs at most what wasn't flushed. ffmpeg is never bundled: it is found on the PATH.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Gate } from './gate.mjs';

export const SAMPLE_RATE = 48000;
const BYTES = 3;
export const SEGMENT_S = 300;
const HEADER = 44;

/** Which capture tool this machine has. */
export function findTool(run = spawnSync) {
  const has = (cmd, arg) => {
    const r = run(cmd, [arg], { stdio: 'ignore' });
    return !r.error;
  };
  if (has('ffmpeg', '-version')) return 'ffmpeg';
  if (process.platform === 'linux' && has('arecord', '--version')) return 'arecord';
  return null;
}

export const installHint = (platform = process.platform) => (platform === 'darwin' ? 'brew install ffmpeg' : platform === 'win32' ? 'winget install ffmpeg' : 'sudo apt install ffmpeg');

/** The command that captures `channels` channels from a device of this platform. */
export function captureCommand({ tool = 'ffmpeg', platform = process.platform, device = 'default', channels = 2 }) {
  if (tool === 'arecord') return { cmd: 'arecord', args: ['-q', '-D', device, '-f', 'S24_3LE', '-r', String(SAMPLE_RATE), '-c', String(channels), '-t', 'raw'] };
  const input = platform === 'linux' ? ['-f', 'alsa', '-i', device] : platform === 'darwin' ? ['-f', 'avfoundation', '-i', `:${device}`] : ['-f', 'dshow', '-i', `audio=${device}`];
  return { cmd: 'ffmpeg', args: ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ac', String(channels), '-ar', String(SAMPLE_RATE), ...input, '-ac', String(channels), '-ar', String(SAMPLE_RATE), '-f', 's24le', '-'] };
}

/** Stable ids out of `ffmpeg -list_devices` on macOS/Windows and `arecord -L` on Linux. */
export function parseDevices(text, platform = process.platform) {
  if (platform === 'linux') {
    const out = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) if (/^(hw|plughw):CARD=/.test(lines[i])) out.push({ id: lines[i].trim(), name: (lines[i + 1] ?? '').trim() });
    return out;
  }
  if (platform === 'darwin') {
    const at = text.indexOf('audio devices');
    return [...text.slice(at < 0 ? 0 : at).matchAll(/\[(\d+)\] (.+)/g)].map((m) => ({ id: m[1], name: m[2].trim() }));
  }
  // Windows: the device's alternative name does not change when the order does.
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /"(.+)" \(audio\)/.exec(lines[i]);
    const alt = /Alternative name "(.+)"/.exec(lines[i + 1] ?? '');
    if (m) out.push({ id: alt?.[1] ?? m[1], name: m[1] });
  }
  return out;
}

function wavHeader(dataBytes, channels = 1) {
  const h = Buffer.alloc(HEADER);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * channels * BYTES, 28);
  h.writeUInt16LE(channels * BYTES, 32);
  h.writeUInt16LE(BYTES * 8, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** One session on disk: <dir>/ch<N>/seg-000.wav… Sample-accurate position in frames from the session's start. */
export class SessionWriter {
  constructor(dir, channels, segmentFrames = SEGMENT_S * SAMPLE_RATE) {
    this.dir = dir;
    this.channels = channels;
    this.segmentFrames = segmentFrames;
    this.frames = 0;
    this.segment = -1;
    this.fds = [];
    this.inSegment = 0;
    for (let c = 0; c < channels; c++) fs.mkdirSync(path.join(dir, `ch${c + 1}`), { recursive: true });
    this.nextSegment();
  }

  segPath = (c, n) => path.join(this.dir, `ch${c + 1}`, `seg-${String(n).padStart(3, '0')}.wav`);

  closeSegment() {
    for (const fd of this.fds) {
      fs.writeSync(fd, wavHeader(this.inSegment * BYTES), 0, HEADER, 0);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }
    this.fds = [];
  }

  nextSegment() {
    this.closeSegment();
    this.segment++;
    this.inSegment = 0;
    for (let c = 0; c < this.channels; c++) {
      const fd = fs.openSync(this.segPath(c, this.segment), 'w');
      fs.writeSync(fd, wavHeader(0));
      this.fds.push(fd);
    }
  }

  /** @param {Buffer} pcm interleaved s24le, whole frames */
  write(pcm) {
    const step = this.channels * BYTES;
    let at = 0;
    while (at < pcm.length) {
      const frames = Math.min((pcm.length - at) / step, this.segmentFrames - this.inSegment);
      const planes = Array.from({ length: this.channels }, () => Buffer.allocUnsafe(frames * BYTES));
      for (let f = 0; f < frames; f++) {
        const src = at + f * step;
        for (let c = 0; c < this.channels; c++) pcm.copy(planes[c], f * BYTES, src + c * BYTES, src + (c + 1) * BYTES);
      }
      planes.forEach((p, c) => fs.writeSync(this.fds[c], p));
      this.inSegment += frames;
      this.frames += frames;
      at += frames * step;
      if (this.inSegment === this.segmentFrames) this.nextSegment();
    }
  }

  close() {
    this.closeSegment();
  }
}

/** Mend a session cut short: each segment's header is set from what really reached the disk. */
export function recoverSession(dir) {
  let frames = Infinity;
  const chans = fs.readdirSync(dir).filter((d) => /^ch\d+$/.test(d));
  for (const ch of chans) {
    let total = 0;
    for (const f of fs.readdirSync(path.join(dir, ch)).filter((x) => x.endsWith('.wav')).sort()) {
      const file = path.join(dir, ch, f);
      const size = fs.statSync(file).size;
      const data = Math.max(0, size - HEADER);
      const whole = data - (data % BYTES);
      if (whole !== data) fs.truncateSync(file, HEADER + whole);
      const fd = fs.openSync(file, 'r+');
      fs.writeSync(fd, wavHeader(whole), 0, HEADER, 0);
      fs.closeSync(fd);
      total += whole / BYTES;
    }
    frames = Math.min(frames, total);
  }
  return { frames: frames === Infinity ? 0 : frames, channels: chans.length };
}

/** Sew a channel's segments back into one WAV. Stops at `frames` when given (channels cut at different points). */
export function stitchChannel(dir, channel, out, frames) {
  const cdir = path.join(dir, `ch${channel}`);
  const files = fs.readdirSync(cdir).filter((x) => x.endsWith('.wav')).sort();
  const dataSizes = files.map((f) => fs.statSync(path.join(cdir, f)).size - HEADER);
  const total = Math.min(dataSizes.reduce((a, b) => a + b, 0), frames === undefined ? Infinity : frames * BYTES);
  const fd = fs.openSync(out, 'w');
  fs.writeSync(fd, wavHeader(total));
  let left = total;
  for (const f of files) {
    if (left <= 0) break;
    const data = fs.readFileSync(path.join(cdir, f)).subarray(HEADER, HEADER + left);
    fs.writeSync(fd, data);
    left -= data.length;
  }
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return total / BYTES;
}

/** Interleaved s24le → float, for the gate. */
export function toFloat(pcm) {
  const out = new Float32Array(pcm.length / BYTES);
  for (let i = 0; i < out.length; i++) out[i] = pcm.readIntLE(i * BYTES, BYTES) / 8388608;
  return out;
}

/**
 * The always-on recorder: feed it PCM. It keeps the pre-roll, opens a session when the gate says so and tells
 * `on` about starts, song cuts and ends, with positions in frames from the session's first frame.
 */
export class Recorder {
  constructor({ dir, channels = 2, sampleRate = SAMPLE_RATE, gate = {}, on = () => {}, now = () => Date.now(), segmentFrames }) {
    Object.assign(this, { dir, channels, on, now, segmentFrames });
    this.gate = new Gate({ ...gate, channels, sampleRate });
    this.step = channels * BYTES;
    this.ring = [];
    this.ringBytes = 0;
    // The gate speaks only after startMs of sound: the ring has to reach back past that too.
    this.preBytes = Math.round((this.gate.preRollS + this.gate.startMs / 1000 + 1) * sampleRate) * this.step;
    this.session = null;
    this.carry = Buffer.alloc(0);
    this.total = 0;
  }

  feed(chunk) {
    const pcm = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = pcm.length - (pcm.length % this.step);
    this.carry = Buffer.from(pcm.subarray(whole));
    const data = pcm.subarray(0, whole);
    this.total += whole / this.step;
    const events = this.gate.push(toFloat(data));
    for (const e of events) if (e.type === 'start') this.open(e);
    if (this.session) this.session.writer.write(this.session.fresh ? this.fromRing(data) : data);
    else {
      this.ring.push(Buffer.from(data));
      this.ringBytes += data.length;
      while (this.ring.length && this.ringBytes - this.ring[0].length >= this.preBytes) this.ringBytes -= this.ring.shift().length;
    }
    if (this.session) this.session.fresh = false;
    for (const e of events) if (e.type !== 'start') this.event(e);
  }

  fromRing(data) {
    const all = Buffer.concat([...this.ring, data]);
    this.ring = [];
    this.ringBytes = 0;
    const firstInRing = this.total - all.length / this.step;
    const skip = Math.max(0, this.session.origin - firstInRing);
    this.session.origin = firstInRing + skip;
    return all.subarray(skip * this.step);
  }

  open(e) {
    const id = `s${new Date(this.now()).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
    const dir = path.join(this.dir, id);
    fs.mkdirSync(dir, { recursive: true });
    this.session = { id, dir, origin: e.at, fresh: true, cuts: [], marks: [], writer: new SessionWriter(dir, this.channels, this.segmentFrames), startedAt: this.now() };
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id, channels: this.channels, startedAt: this.session.startedAt, cuts: [], marks: [] }));
    this.on({ type: 'start', session: id });
  }

  writeInfo(extra = {}) {
    const s = this.session;
    fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify({ id: s.id, channels: this.channels, startedAt: s.startedAt, cuts: s.cuts, marks: s.marks, ...extra }));
  }

  event(e) {
    const s = this.session;
    if (!s) return;
    if (e.type === 'split') {
      s.cuts.push(e.at - s.origin);
      this.writeInfo();
      this.on({ type: 'split', session: s.id, at: e.at - s.origin });
    } else if (e.type === 'end') this.close(e.at - s.origin);
  }

  close(endFrame) {
    const s = this.session;
    s.writer.close();
    this.writeInfo({ endFrame, closed: true });
    this.session = null;
    this.on({ type: 'end', session: s.id, frames: endFrame, cuts: s.cuts, marks: s.marks, dir: s.dir });
  }

  /** A MARK: "there's a mistake here", now. */
  mark() {
    if (!this.session) return null;
    const at = this.total - this.session.origin;
    this.session.marks.push(at);
    this.writeInfo();
    return at;
  }

  force(on) {
    const e = this.gate.force(on);
    if (!e) return;
    if (e.type === 'start') this.open(e);
    else this.event(e);
  }

  stop() {
    if (this.session) this.close(this.session.writer.frames);
  }
}

/** Sessions cut by a crash: mended, with what they had. */
export function pendingSessions(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const id of fs.readdirSync(dir)) {
    const file = path.join(dir, id, 'session.json');
    if (!fs.existsSync(file)) continue;
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (info.closed) continue;
    const { frames } = recoverSession(path.join(dir, id));
    const mended = { ...info, endFrame: frames, closed: true, recovered: true };
    fs.writeFileSync(file, JSON.stringify(mended));
    out.push({ ...mended, dir: path.join(dir, id) });
  }
  return out;
}

/** Run the capture tool and feed the recorder until it stops. */
export function startCapture(recorder, command, { spawnFn = spawn, onError = () => {} } = {}) {
  const child = spawnFn(command.cmd, command.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stdout.on('data', (d) => recorder.feed(d));
  child.stderr.on('data', (d) => (errors = `${errors}${d}`.slice(-2000)));
  child.on('error', (e) => onError(e.message));
  child.on('exit', (code) => code && onError(errors.trim() || `exit ${code}`));
  return child;
}
