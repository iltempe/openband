// The guide voice (voice.sing builtin): it sings the notes' pitches with the vowels' formants, places
// syllables on their notes, and keeps the vowel through a melisma.
import { describe, expect, it } from 'vitest';
import { singGuide } from './voice';
import { sungSyllables } from './engine';
import type { Manifest, Scp } from '../ensemble/types';
import { route } from '../ensemble/router';
import { builtinEngines } from '../ensemble/engines';

const SR = 22050;

/** Magnitude spectrum of a stretch of samples (naive DFT on a few bins is enough here). */
function energyAt(x: Float32Array, from: number, to: number, f: number) {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - from)) / (to - from));
    re += x[i] * w * Math.cos((2 * Math.PI * f * i) / SR);
    im += x[i] * w * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return Math.hypot(re, im);
}
/** The strongest frequency in a band, in steps. */
const peak = (x: Float32Array, from: number, to: number, lo: number, hi: number, step = 10) => {
  let best = lo;
  let e = 0;
  for (let f = lo; f <= hi; f += step) {
    const v = energyAt(x, from, to, f);
    if (v > e) [e, best] = [v, f];
  }
  return best;
};
/** Mean energy over a band, for comparing formant regions. */
const band = (x: Float32Array, from: number, to: number, lo: number, hi: number) => {
  let s = 0;
  let n = 0;
  for (let f = lo; f <= hi; f += 25, n++) s += energyAt(x, from, to, f);
  return s / n;
};

describe('the guide voice', () => {
  it('sings the pitch of the note', () => {
    const x = singGuide([{ text: 'la', start: 0.1, end: 1.1, midi: 57, phonemes: ['l', 'a'] }], 1.3, { sampleRate: SR });
    // A3 = 220 Hz: the fundamental, within vibrato.
    expect(Math.abs(peak(x, Math.round(0.4 * SR), Math.round(0.9 * SR), 180, 260, 2) - 220)).toBeLessThan(8);
  });

  it('an /a/ and an /i/ have their formants: F1 high for a, F2 high for i', () => {
    const a = singGuide([{ text: 'a', start: 0, end: 1, midi: 55, phonemes: ['a'] }], 1, { sampleRate: SR });
    const i = singGuide([{ text: 'i', start: 0, end: 1, midi: 55, phonemes: ['i'] }], 1, { sampleRate: SR });
    const w = [Math.round(0.3 * SR), Math.round(0.8 * SR)] as const;
    // F1 region (600–1000 Hz) stronger in a; F2 region (2000–2600 Hz) stronger in i, relative to their own F1.
    expect(band(a, ...w, 650, 950) / band(a, ...w, 200, 400)).toBeGreaterThan(band(i, ...w, 650, 950) / band(i, ...w, 200, 400));
    expect(band(i, ...w, 2000, 2600) / band(i, ...w, 650, 950)).toBeGreaterThan(2 * (band(a, ...w, 2000, 2600) / band(a, ...w, 650, 950)));
  });

  it('places syllables on their notes; a melisma keeps the vowel; no words sings on "a"', () => {
    const scp: Scp = {
      scp: '1.0',
      song: { bpm: 120, meter: '4/4', key: 'C', length_bars: 2 },
      scope: { from_bar: 1, to_bar: 3 },
      melody: { notes: [{ pitch: 60, start: 0, duration: 1 }, { pitch: 62, start: 1, duration: 1 }, { pitch: 64, start: 2, duration: 2 }] },
      lyrics: { language: 'it', lines: [{ text: 'ciao', syllables: [{ text: 'cia', start_beat: 0, dur: 1, phonemes: ['tS', 'a'] }, { text: 'o', start_beat: 2, dur: 2, phonemes: ['o'] }] }] },
    };
    const s = sungSyllables(scp);
    expect(s.map((x) => [x.text, x.phonemes.join(' '), x.midi, x.start])).toEqual([
      ['cia', 'tS a', 60, 0],
      ['', 'a', 62, 0.5],
      ['o', 'o', 64, 1],
    ]);
    const bare = sungSyllables({ ...scp, lyrics: undefined });
    expect(bare.every((x) => x.phonemes.join() === 'a')).toBe(true);
  });

  it('stands in: a singing engine the user installed sings first', () => {
    expect(route({ capability: 'voice.sing' }, builtinEngines()).candidates.map((c) => c.id)).toEqual(['openband-voice']);
    const diffsinger = { id: 'diffsinger', transport: 'bridge' as const, status: 'ready' as const, manifest: { omep: '1.0', engine: { id: 'diffsinger', name: 'DiffSinger', version: '2.0.0' }, license: { code: 'Apache-2.0', weights: 'CC-BY-4.0', commercial: 'yes', attribution: 'x' }, runtime: { where: 'local' }, capabilities: { 'voice.sing': {} }, outputs: ['audio/wav'], determinism: 'seeded' } as Manifest };
    expect(route({ capability: 'voice.sing' }, [...builtinEngines(), diffsinger]).candidates.map((c) => c.id)).toEqual(['diffsinger', 'openband-voice']);
  });
});
