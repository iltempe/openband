// Parametric synths and sounds from words (SPEC v0.6 G5).
import { describe, expect, it } from 'vitest';
import { soundFromWords } from './words';
import { changedParams, fromUnit, synthSchema, toUnit, voiceOptions } from '../audio/synthParams';
import { PRESETS } from '../audio/instruments';

describe('parametric synths', () => {
  it('every melodic preset has its parameters, with the preset’s own values as defaults', () => {
    for (const p of PRESETS.filter((x) => x.kind === 'instrument')) {
      const s = synthSchema(p.id)!;
      expect(s.map((d) => d.id)).toEqual(expect.arrayContaining(['attack', 'decay', 'sustain', 'release', 'cutoff', 'level']));
      for (const d of s) {
        expect(d.default).toBeGreaterThanOrEqual(d.min);
        expect(d.default).toBeLessThanOrEqual(d.max);
        expect(fromUnit(d, toUnit(d, d.default))).toBeCloseTo(d.default, 3);
      }
    }
    expect(synthSchema('kit-studio')).toBeNull();
    expect(synthSchema('acid-bass')!.map((d) => d.id)).toEqual(expect.arrayContaining(['filter_env', 'filter_decay', 'resonance', 'wave']));
    expect(synthSchema('crystal-bells')!.map((d) => d.id)).toEqual(expect.arrayContaining(['fm_index', 'fm_ratio']));
    expect(synthSchema('aurora-pad')!.map((d) => d.id)).toEqual(expect.arrayContaining(['unison', 'detune']));
  });

  it('parameters reach the voice; only changes are kept', () => {
    const v = voiceOptions('acid-bass', { cutoff: 900, attack: 0.05, wave: 3 });
    expect(v.options.filterEnvelope.baseFrequency).toBe(900);
    expect(v.options.envelope.attack).toBe(0.05);
    expect(v.options.oscillator.type).toBe('square');
    expect(voiceOptions('felt-piano', { cutoff: 2000 }).filter.frequency).toBe(2000);
    expect(changedParams('acid-bass', { cutoff: 160, attack: 0.05, nope: 3 })).toEqual({ attack: 0.05 });
  });
});

describe('a sound from words', () => {
  it('"basso caldo plucky": a bass with almost no attack and a cutoff below its preset’s', () => {
    const w = soundFromWords('basso caldo plucky');
    expect(w.family).toBe('bass');
    const def = synthSchema(w.preset)!.find((d) => d.id === 'cutoff')!;
    expect(w.params.attack ?? synthSchema(w.preset)!.find((d) => d.id === 'attack')!.default).toBeLessThan(0.01);
    expect(w.params.cutoff).toBeLessThan(def.default);
    expect(w.params.sustain).toBe(0);
    expect(w.why.join(' ')).toMatch(/warm.*plucky|plucky.*warm/);
  });

  it('other words, other presets and parameters', () => {
    expect(soundFromWords('bright wide pad')).toMatchObject({ family: 'pad', preset: 'aurora-pad' });
    expect(soundFromWords('bright wide pad').params.unison).toBeGreaterThan(3);
    expect(soundFromWords('campane metalliche').preset).toBe('crystal-bells');
    expect(soundFromWords('acid bass, aggressive').preset).toBe('acid-bass');
    expect(soundFromWords('archi morbidi e lenti').params.attack).toBeGreaterThan(0.3);
    expect(soundFromWords('lead', 'lead').preset).toBe('neon-lead');
  });
});
