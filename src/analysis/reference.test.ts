import { describe, expect, it } from 'vitest';
import { compareProfiles, masterProfile, matchGain } from './reference';

const FS = 44100;

/** A little "mix": bass + mid tone + seeded noise for the highs, slightly different per channel. */
function song(seconds: number, { bass = 0.3, air = 0.05, gain = 1 } = {}) {
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const n = Math.round(seconds * FS);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let hp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const w = rnd();
    const hi = w - hp; // crude high-pass of white noise
    hp = w;
    const base = bass * Math.sin(2 * Math.PI * 80 * t) + 0.15 * Math.sin(2 * Math.PI * 1000 * t);
    l[i] = gain * (base + air * hi);
    r[i] = gain * (base * 0.9 + air * hi * 0.8);
  }
  return [l, r];
}

describe('reference matching', () => {
  it('a mix compared with itself has no differences', () => {
    const p = masterProfile(song(6), FS);
    const c = compareProfiles(p, p, [{ id: 'trk', name: 'Bass', bands_db: p.bands_db }]);
    expect(c.loudness_diff_lu).toBe(0);
    expect(c.crest_diff_db).toBe(0);
    expect(c.width_diff).toBe(0);
    for (const v of Object.values(c.tonal_diff_db)) expect(Math.abs(v)).toBeLessThanOrEqual(0.2);
    expect(c.suggestions).toEqual([]);
  });

  it('matches loudness before comparing the tone', () => {
    const mix = masterProfile(song(6), FS);
    const ref = masterProfile(song(6, { gain: 2 }), FS); // same song, 6 dB louder
    const c = compareProfiles(mix, ref);
    expect(c.loudness_diff_lu).toBeCloseTo(-6, 0);
    for (const v of Object.values(c.tonal_diff_db)) expect(Math.abs(v)).toBeLessThanOrEqual(0.2);
    expect(c.suggestions.map((s) => s.action)).toEqual(['gain']);
    expect(c.suggestions[0].gain_db).toBe(6);
    expect(matchGain(mix.lufs_integrated, ref.lufs_integrated)).toBeCloseTo(0.5, 1);
  });

  it('finds a darker mix and too much bass, and blames the right track', () => {
    const mix = masterProfile(song(6, { bass: 0.9, air: 0.01 }), FS);
    const ref = masterProfile(song(6), FS);
    const stems = [
      { id: 'trk_bass', name: 'Bass', bands_db: { ...mix.bands_db, bass: -10 } },
      { id: 'trk_keys', name: 'Keys', bands_db: { ...mix.bands_db, bass: -40 } },
    ];
    const c = compareProfiles(mix, ref, stems);
    expect(c.tonal_diff_db.air).toBeLessThan(-6);
    expect(c.tonal_diff_db.bass).toBeGreaterThan(1.5);
    const air = c.suggestions.find((s) => s.band === 'air')!;
    expect(air).toMatchObject({ action: 'eq', target: 'master' });
    expect(air.gain_db).toBeGreaterThan(0);
    const bass = c.suggestions.find((s) => s.band === 'bass')!;
    expect(bass.target).toBe('trk_bass');
    expect(bass.gain_db).toBeLessThan(0);
  });
});

describe('reference gating', () => {
  it('ignores silence around the music', () => {
    // 10 s of music with short fades (as songs have), then 1 s of silence before and 2 s after.
    const [l, r] = song(10).map((x) => x.map((v, i) => v * Math.min(1, i / (0.05 * FS), (x.length - i) / (0.05 * FS))));
    const pad = (x: Float32Array) => {
      const y = new Float32Array(x.length + FS * 3);
      y.set(x, FS);
      return y;
    };
    const c = compareProfiles(masterProfile([pad(l), pad(r)], FS), masterProfile([l, r], FS));
    expect(Math.abs(c.loudness_diff_lu)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(c.crest_diff_db)).toBeLessThanOrEqual(0.2);
    for (const v of Object.values(c.tonal_diff_db)) expect(Math.abs(v)).toBeLessThanOrEqual(0.2);
  });
});
