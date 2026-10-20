import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { searchLoops, validateManifest, type LoopManifest } from './loops';
import { keyShift } from './loopsLive';

const dir = path.join(__dirname, '..', 'public', 'loops');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) as LoopManifest;

describe('CC0 loop library', () => {
  it('every loop is CC0 with author and source, and its file is there (total ≤ 5 MB)', () => {
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.loops.length).toBeGreaterThanOrEqual(12);
    let total = 0;
    for (const l of manifest.loops) {
      expect(l.license).toBe('CC0');
      if (l.url.startsWith('https://')) continue;
      const f = path.join(dir, '..', l.url);
      expect(fs.existsSync(f), l.url).toBe(true);
      const b = fs.readFileSync(f);
      expect(b.toString('ascii', 0, 4)).toBe('RIFF');
      // Exactly `bars` bars at its tempo (it loops seamlessly).
      const sr = b.readUInt32LE(24);
      const frames = (b.length - 44) / (2 * b.readUInt16LE(22));
      expect(Math.abs(frames / sr - (l.bars * 4 * 60) / l.bpm)).toBeLessThan(0.001);
      total += b.length;
    }
    expect(total).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(fs.readFileSync(path.join(dir, 'LICENSE.txt'), 'utf8')).toMatch(/CC0 1\.0/);
  });

  it('refuses entries that are not CC0 or lack a source', () => {
    const bad = { version: 1, loops: [{ ...manifest.loops[0], license: 'CC-BY' }, { ...manifest.loops[1], source: '' }, { ...manifest.loops[2], id: manifest.loops[0].id }] };
    const errs = validateManifest(bad);
    expect(errs.some((e) => /license must be CC0/.test(e))).toBe(true);
    expect(errs.some((e) => /source missing/.test(e))).toBe(true);
    expect(errs.some((e) => /duplicate id/.test(e))).toBe(true);
  });

  it('search by words (also Italian), tempo and key', () => {
    expect(searchLoops(manifest, { query: 'funk drums' })[0].id).toBe('drums-funk-100');
    expect(searchLoops(manifest, { query: 'batteria lofi' })[0].id).toBe('drums-lofi-82');
    const near = searchLoops(manifest, { query: 'drums', bpm: 98 });
    expect(near.every((l) => Math.abs(l.bpm - 98) / 98 <= 0.15)).toBe(true);
    expect(near[0].bpm).toBe(100);
    expect(searchLoops(manifest, { query: 'bass', key: 'Cm' })[0].key).toBe('Cm');
    expect(searchLoops(manifest, { query: 'nothing-like-this' })).toEqual([]);
  });

  it('transposes a loop to the song key, only in the same mode', () => {
    expect(keyShift('Am', 'Cm')).toBe(3);
    expect(keyShift('Am', 'C')).toBe(0); // minor loop in a major song: left alone
    expect(keyShift(undefined, 'C')).toBe(0);
    expect(keyShift('G', 'E')).toBe(-3);
  });
});
