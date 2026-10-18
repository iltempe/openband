import { describe, expect, it } from 'vitest';
import { analyzeChords, findCadences, romanFor, type HNote } from './harmony';
import { parseChord } from '../music';

/** One chord per bar: chord tones at octave 4 plus the bass note (root, or the slash bass) at octave 2. */
function progression(symbols: string[], beatsPerChord = 4): HNote[] {
  return symbols.flatMap((sym, i) => {
    const [main, slash] = sym.split('/');
    const tones = parseChord(main, 4);
    const bassPc = slash ? parseChord(slash, 2)[0] : tones[0] - 24;
    return [...tones, bassPc].map((pitch) => ({ pitch, start: i * beatsPerChord, duration: beatsPerChord, velocity: 0.8 }));
  });
}
const names = (n: HNote[], key: string, bars: number) => analyzeChords(n, key, 0, bars * 4).map((c) => [c.chord, c.roman]);

describe('chord recognition and degrees', () => {
  it('I–V–vi–IV in C', () => {
    expect(names(progression(['C', 'G', 'Am', 'F']), 'C', 4)).toEqual([['C', 'I'], ['G', 'V'], ['Am', 'vi'], ['F', 'IV']]);
  });
  it('ii–V–I in C with sevenths', () => {
    expect(names(progression(['Dm7', 'G7', 'Cmaj7']), 'C', 3)).toEqual([['Dm7', 'ii7'], ['G7', 'V7'], ['Cmaj7', 'Imaj7']]);
  });
  it('A minor with the harmonic-minor E7', () => {
    expect(names(progression(['Am', 'Dm', 'E7', 'Am']), 'Am', 4)).toEqual([['Am', 'i'], ['Dm', 'iv'], ['E7', 'V7'], ['Am', 'i']]);
  });
  it('recognises the other templates', () => {
    const syms = ['Bdim', 'Caug', 'Dsus2', 'Gsus4', 'Bm7b5', 'Cdim7', 'Cadd9', 'C6', 'Am6'];
    const got = analyzeChords(progression(syms), 'C', 0, syms.length * 4).map((c) => c.chord);
    expect(got).toEqual(syms);
  });
  it('uses the bass for inversions and to tell C6 from Am7', () => {
    expect(names(progression(['C/E', 'G/B']), 'C', 2).map((x) => x[0])).toEqual(['C/E', 'G/B']);
    expect(names(progression(['Am7']), 'C', 1)[0][0]).toBe('Am7');
    expect(names(progression(['C6']), 'C', 1)[0][0]).toBe('C6');
    expect(names(progression(['C6/A']), 'C', 1)[0][0]).toBe('Am7');
  });
  it('splits a bar with two chords and merges repeated bars', () => {
    const n = progression(['C', 'G'], 2);
    expect(analyzeChords(n, 'C', 0, 4).map((c) => [c.chord, c.beat])).toEqual([['C', 1], ['G', 3]]);
    expect(analyzeChords(progression(['F', 'F', 'C']), 'C', 0, 12).map((c) => [c.chord, c.length])).toEqual([['F', 8], ['C', 4]]);
  });
  it('is not fooled by a walking bass', () => {
    // Am7 stabs over A–A–E–A–G (the demo's bass line).
    const notes: HNote[] = [57, 60, 64, 67].map((pitch) => ({ pitch, start: 0, duration: 4, velocity: 0.6 }));
    for (const [pitch, start, duration] of [[33, 0, 1.5], [33, 1.5, 0.5], [40, 2, 1], [45, 3, 0.5], [43, 3.5, 0.5]]) notes.push({ pitch, start, duration, velocity: 0.9 });
    expect(analyzeChords(notes, 'Am', 0, 4).map((c) => c.chord)).toEqual(['Am7']);
  });
  it('names secondary dominants and borrowed chords', () => {
    expect(romanFor(2, '7', 'C')).toEqual({ roman: 'V7/V', fn: 'secondary' }); // D7
    expect(romanFor(4, '', 'C')).toEqual({ roman: 'V/vi', fn: 'secondary' }); // E
    expect(romanFor(10, '', 'C')).toEqual({ roman: 'bVII', fn: 'borrowed' }); // Bb
    expect(romanFor(5, 'm', 'C')).toEqual({ roman: 'iv', fn: 'borrowed' }); // Fm
  });
});

describe('cadences', () => {
  it('finds ii–V–I, plagal and deceptive cadences', () => {
    const c = (syms: string[]) => findCadences(analyzeChords(progression(syms), 'C', 0, syms.length * 4)).map((x) => x.type);
    expect(c(['Dm7', 'G7', 'C'])).toEqual(['ii-V-I']);
    expect(c(['F', 'C'])).toEqual(['plagal']);
    expect(c(['G', 'Am'])).toEqual(['deceptive']);
  });
  it('keeps only cadences that close a section, and spots half cadences', () => {
    const chords = analyzeChords(progression(['C', 'G', 'C', 'F', 'C', 'G']), 'C', 0, 24);
    const out = findCadences(chords, [{ beat: 12, name: 'Verse' }, { beat: 24, name: 'Chorus' }]);
    expect(out).toEqual([
      { type: 'authentic', bar: 3, chords: ['G', 'C'], section: 'Verse' },
      { type: 'half', bar: 6, chords: ['G'], section: 'Chorus' },
    ]);
  });
});
