import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeMp3 } from './mp3';

const ffprobe = spawnSync('ffprobe', ['-version']).status === 0;

describe('MP3', () => {
  it('3 s of stereo at 320 kbit/s: an MP3 any player reads', async () => {
    const sr = 44100;
    const n = sr * 3;
    const l = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr));
    const r = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 660 * i) / sr));
    const mp3 = await encodeMp3([l, r], sr);
    // 320 kbit/s × 3 s ≈ 120 kB.
    expect(mp3.length).toBeGreaterThan(100_000);
    expect(mp3.length).toBeLessThan(140_000);
    if (!ffprobe) return;
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ob-mp3-')), 'x.mp3');
    fs.writeFileSync(f, mp3);
    const s = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f], { encoding: 'utf8' }));
    expect(s.streams[0]).toMatchObject({ codec_name: 'mp3', sample_rate: '44100', channels: 2 });
    expect(Number(s.format.duration)).toBeCloseTo(3, 1);
    expect(Math.round(Number(s.streams[0].bit_rate) / 1000)).toBe(320);
  });
});
