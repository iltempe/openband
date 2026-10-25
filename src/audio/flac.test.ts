// The FLAC encoder (G6): lossless, the reference decoder agrees, and the tags are there.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeFlac } from './flac';

const has = (cmd: string) => {
  try {
    execFileSync('which', [cmd]);
    return true;
  } catch {
    return false;
  }
};

describe('FLAC encoder', () => {
  const sr = 44100;
  const n = 30000;
  const left = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr) + 0.05 * Math.sin(i * 0.37));
  const right = Float32Array.from({ length: n }, (_, i) => (i % 1000 < 3 ? 0.6 : 0) + 0.3 * Math.sin((2 * Math.PI * 330 * i) / sr));
  const flac = encodeFlac([left, right], sr, { bitsPerSample: 24, tags: { TITLE: 'Notte a Trastevere', ARTIST: 'Iltempe', LICENSE: 'https://creativecommons.org/licenses/by/4.0/' } });

  it('starts as FLAC and is smaller than the PCM', () => {
    expect(new TextDecoder().decode(flac.subarray(0, 4))).toBe('fLaC');
    expect(flac.length).toBeLessThan(n * 2 * 3);
  });

  it.runIf(has('flac') && has('metaflac'))('the reference decoder verifies it, sample for sample, with its tags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-flac-'));
    const file = path.join(dir, 'x.flac');
    fs.writeFileSync(file, flac);
    execFileSync('flac', ['-t', '-s', file]);
    execFileSync('flac', ['-d', '-s', '-f', '--force-raw-format', '--endian=little', '--sign=signed', '-o', path.join(dir, 'x.raw'), file]);
    const raw = fs.readFileSync(path.join(dir, 'x.raw'));
    const scale = 2 ** 23 - 1;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const l = raw.readIntLE(i * 6, 3);
      const r = raw.readIntLE(i * 6 + 3, 3);
      worst = Math.max(worst, Math.abs(l - Math.round(left[i] * scale)), Math.abs(r - Math.round(right[i] * scale)));
    }
    expect(worst).toBe(0);
    const tags = execFileSync('metaflac', ['--export-tags-to=-', file]).toString();
    expect(tags).toContain('TITLE=Notte a Trastevere');
    expect(tags).toContain('LICENSE=https://creativecommons.org/licenses/by/4.0/');
    // 16-bit too (dithered), and an odd rate.
    const f16 = path.join(dir, 'y.flac');
    fs.writeFileSync(f16, encodeFlac([left], 22050, { bitsPerSample: 16 }));
    execFileSync('flac', ['-t', '-s', f16]);
  });
});
