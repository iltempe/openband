import { describe, expect, it } from 'vitest';
import { mixStems, packName, partMix, partOf } from './parts';

describe('parts', () => {
  it.each([['Soprano', 'Soprano'], ['Sop', 'Soprano'], ['S', 'Soprano'], ['Alto', 'Contralto'], ['A', 'Contralto'], ['Contralto 2', 'Contralto 2'], ['Tenore', 'Tenore'], ['T', 'Tenore'], ['Basso', 'Basso'], ['B', 'Basso'], ['Baritono', 'Baritono'], ['Voce 2', 'Voce 2'], ['Clarinetto 1', 'Clarinetto 1'], ['tromba 2', 'Tromba 2']])('%s is %s', (name, part) => expect(partOf(name)).toBe(part));
  it.each(['Pianoforte', 'Batteria', 'Voce'])('%s is accompaniment', (name) => expect(partOf(name)).toBeNull());
  it('gives the mix of each mode', () => {
    expect(partMix('highlight', 'T', 'T')).toEqual({ db: 6, pan: 0 });
    expect(partMix('highlight', 'B', 'T')).toEqual({ db: -9, pan: 0 });
    expect(partMix('mute', 'T', 'T').db).toBe(-Infinity);
    expect(partMix('left', 'T', 'T').pan).toBe(-1);
    expect(partMix('left', 'B', 'T').pan).toBe(1);
    expect(partMix('highlight', 'B', null).db).toBe(0);
  });
  it('names the classic pack in order', () => expect(packName(3, 'Signore delle cime', 'Tenore', 'highlight')).toBe('03 Signore delle cime – Tenore – in evidenza.m4a'));
  it('mixes: muted is gone, left is left', () => {
    const one = new Float32Array([1, 1]);
    const stems = [{ part: 'T', channels: [one] }, { part: 'B', channels: [one] }];
    expect([...mixStems(stems, 'mute', 'T')[0]]).toEqual([1, 1]);
    const [l, r] = mixStems(stems, 'left', 'T');
    expect([l[0], r[0]]).toEqual([1, 1]);
  });
});
