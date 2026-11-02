import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Recorder, SAMPLE_RATE, SessionWriter, captureCommand, parseDevices, pendingSessions, recoverSession, startCapture, stitchChannel, toFloat } from './capture.mjs';

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openband-box-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const SR = SAMPLE_RATE;
/** s24le interleaved; each channel holds its own constant (with a sign flip for RMS). */
const pcm = (seconds: number, amp: number, channels = 2) => {
  const frames = Math.round(seconds * SR);
  const b = Buffer.alloc(frames * channels * 3);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) b.writeIntLE(Math.round((f % 2 ? -1 : 1) * amp * (c + 1) * 8e6) | 0, (f * channels + c) * 3, 3);
  return b;
};
const data = (file: string) => fs.readFileSync(file).length - 44;
const header = (file: string) => {
  const b = fs.readFileSync(file);
  return { rate: b.readUInt32LE(24), bits: b.readUInt16LE(34), channels: b.readUInt16LE(22), bytes: b.readUInt32LE(40) };
};

describe('capture commands', () => {
  it('asks each platform in its own way', () => {
    expect(captureCommand({ platform: 'linux', device: 'hw:1', channels: 4 }).args).toEqual(expect.arrayContaining(['alsa', 'hw:1', 's24le']));
    expect(captureCommand({ platform: 'darwin', device: '2' }).args).toEqual(expect.arrayContaining(['avfoundation', ':2']));
    expect(captureCommand({ platform: 'win32', device: 'Mic' }).args).toEqual(expect.arrayContaining(['dshow', 'audio=Mic']));
    expect(captureCommand({ tool: 'arecord', device: 'hw:1', channels: 2 }).args).toEqual(expect.arrayContaining(['-f', 'S24_3LE', '-r', '48000']));
  });
  it('reads device lists, with stable ids on Windows', () => {
    expect(parseDevices('hw:CARD=USB,DEV=0\n    Scarlett 2i2\nnull\n', 'linux')).toEqual([{ id: 'hw:CARD=USB,DEV=0', name: 'Scarlett 2i2' }]);
    expect(parseDevices('video devices:\n[0] Cam\naudio devices:\n[0] MacBook Mic\n[1] Scarlett\n', 'darwin').map((d) => d.id)).toEqual(['0', '1']);
    expect(parseDevices('"Mic (USB)" (audio)\n  Alternative name "@device_cm_{abc}"\n', 'win32')[0]).toEqual({ id: '@device_cm_{abc}', name: 'Mic (USB)' });
  });
});

describe('the session on disk', () => {
  it('splits channels into segments and sews them back exactly', () => {
    const w = new SessionWriter(dir, 2, SR);
    const a = pcm(2.5, 0.1);
    w.write(a);
    w.close();
    expect(fs.readdirSync(path.join(dir, 'ch1')).sort()).toEqual(['seg-000.wav', 'seg-001.wav', 'seg-002.wav']);
    expect(header(path.join(dir, 'ch1/seg-000.wav'))).toMatchObject({ rate: SR, bits: 24, channels: 1, bytes: SR * 3 });
    const out = path.join(dir, 'ch2.wav');
    expect(stitchChannel(dir, 2, out)).toBe(2.5 * SR);
    const got = fs.readFileSync(out).subarray(44);
    const want = Buffer.alloc(got.length);
    for (let f = 0; f < 2.5 * SR; f++) a.copy(want, f * 3, f * 6 + 3, f * 6 + 6);
    expect(Buffer.compare(got, want)).toBe(0);
  });
  it('a power cut mid-segment loses nothing that reached the disk', () => {
    const w = new SessionWriter(dir, 2, SR * 300);
    w.write(pcm(1, 0.1));
    expect(header(path.join(dir, 'ch1/seg-000.wav')).bytes).toBe(0);
    // no close: the machine goes dark, half a sample in the last write on one channel
    fs.appendFileSync(path.join(dir, 'ch1/seg-000.wav'), Buffer.from([1]));
    expect(recoverSession(dir)).toEqual({ frames: SR, channels: 2 });
    expect(header(path.join(dir, 'ch1/seg-000.wav')).bytes).toBe(SR * 3);
    expect(data(path.join(dir, 'ch1/seg-000.wav'))).toBe(SR * 3);
  });
});

describe('the recorder', () => {
  const recorder = (seen: unknown[], gate = {}) => new Recorder({ dir, channels: 2, gate: { startMs: 500, endMs: 1500, splitMs: 500, preRollS: 1, ...gate }, on: (e: unknown) => seen.push(e), now: () => Date.UTC(2026, 10, 3, 21, 14) });
  const inChunks = (r: Recorder, b: Buffer) => {
    for (let i = 0; i < b.length; i += 7001) r.feed(b.subarray(i, i + 7001));
  };
  it('keeps the attack through the pre-roll, cuts songs and closes', () => {
    const seen: { type: string; frames?: number; cuts?: number[]; session?: string }[] = [];
    const r = recorder(seen);
    inChunks(r, pcm(2, 0));
    inChunks(r, pcm(1, 0.1));
    inChunks(r, pcm(1, 0));
    inChunks(r, pcm(1, 0.1));
    inChunks(r, pcm(2, 0));
    expect(seen.map((e) => e.type)).toEqual(['start', 'split', 'end']);
    const end = seen[2];
    // 1 s of pre-roll + 1 s of song: the first song starts one second into the file
    expect(Math.abs(end.frames! - 4 * SR)).toBeLessThan(0.1 * SR);
    expect(Math.abs(end.cuts![0] - 2.5 * SR)).toBeLessThan(0.1 * SR);
    const out = path.join(dir, 'one.wav');
    stitchChannel(path.join(dir, end.session!), 1, out, end.frames);
    const f = toFloat(fs.readFileSync(out).subarray(44));
    const peak = (a: number, b: number) => Math.max(...f.subarray(a, b).map(Math.abs));
    expect(peak(0, 0.9 * SR)).toBe(0);
    expect(peak(1.05 * SR, 1.1 * SR)).toBeGreaterThan(0.05);
  });
  it('a session across several segments stays whole', () => {
    const seen: { type: string; session?: string; frames?: number }[] = [];
    const r = new Recorder({ dir, channels: 2, segmentFrames: SR / 2, gate: { startMs: 200, endMs: 800, preRollS: 0 }, on: (e: unknown) => seen.push(e) });
    inChunks(r, pcm(3, 0.1));
    inChunks(r, pcm(1, 0));
    const end = seen.find((e) => e.type === 'end')!;
    expect(fs.readdirSync(path.join(dir, end.session!, 'ch1')).length).toBeGreaterThan(4);
    expect(stitchChannel(path.join(dir, end.session!), 1, path.join(dir, 'o.wav'), end.frames)).toBe(end.frames);
    expect(Math.abs(end.frames! - 3 * SR)).toBeLessThan(0.1 * SR);
  });
  it('a crash leaves a session that is found and mended at the next start', () => {
    const r = recorder([]);
    inChunks(r, pcm(2, 0.1));
    expect(pendingSessions(dir)).toHaveLength(1);
    const again = pendingSessions(dir);
    expect(again).toHaveLength(0);
  });
  it('the session file survives with what was known', () => {
    const r = recorder([]);
    inChunks(r, pcm(2, 0.1));
    const at = r.mark();
    expect(at).toBeGreaterThan(0);
    const [p] = pendingSessions(dir);
    expect(p).toMatchObject({ recovered: true, marks: [at] });
    expect(p.endFrame).toBeGreaterThan(SR);
  });
  it('a mark is where the musician is, to within the chunk', () => {
    const r = recorder([]);
    inChunks(r, pcm(2, 0.1));
    expect(Math.abs(r.mark()! - 2 * SR - 0)).toBeLessThan(1.1 * SR);
  });
});

const hasFfmpeg = !spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error;
describe.skipIf(!hasFfmpeg)('with the real ffmpeg', () => {
  it('records a generated tone through a child process', async () => {
    const seen: { type: string; session?: string; frames?: number }[] = [];
    const r = new Recorder({ dir, channels: 2, gate: { startMs: 300, endMs: 100000, preRollS: 0 }, on: (e: unknown) => seen.push(e) });
    const cmd = { cmd: 'ffmpeg', args: ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000', '-ac', '2', '-ar', '48000', '-f', 's24le', '-'] };
    const child = startCapture(r, cmd);
    await new Promise((res) => child.on('close', res));
    r.stop();
    expect(seen.map((e) => e.type)).toEqual(['start', 'end']);
    expect(Math.abs(seen[1].frames! - 2 * SR)).toBeLessThan(0.15 * SR);
  });
});
