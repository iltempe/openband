import { describe, expect, it } from 'vitest';
import { buildLines, buildSyllables } from './lines';
import { alignLines, type MelodyNote } from './align';
import { beatStrength, checkProsody, suggestRhythm } from './prosody';
import { toChordPro, toChordText } from './chordpro';
import { syllabifyEn } from './syllabify.en';

let n = 0;
const id = () => `l${++n}`;
const notes = (starts: number[], dur = 0.5): MelodyNote[] => starts.map((s, i) => ({ id: `m${i}`, start: s, duration: dur }));

describe('lines and alignment', () => {
  it('builds metric syllables with stress', () => {
    const [line] = buildLines('Canto e ballo', 'it', id);
    expect(line.syllables.map((s) => `${s.text}${s.stressed ? '*' : ''}`)).toEqual(['Can*', 'to‿e', 'bal*', 'lo']);
  });
  it('aligns syllables to notes in order and reports orphans', () => {
    const lines = buildLines('canto e ballo\nla notte', 'it', id);
    const res = alignLines(lines, notes([0, 1, 2, 3, 8, 9]));
    expect(res.lines[0].syllables.map((s) => s.beat)).toEqual([0, 1, 2, 3]);
    expect(res.lines[1].syllables.map((s) => s.beat)).toEqual([8, 9, undefined]);
    expect(res.orphanSyllables).toEqual([{ line_id: lines[1].id, count: 1 }]);
  });
  it('a melisma takes the next note too', () => {
    const lines = buildLines('a_ mo re', 'it', id);
    const res = alignLines(lines, notes([0, 0.5, 1, 1.5]));
    expect(res.lines[0].syllables.map((s) => s.noteId)).toEqual(['m0', 'm2', 'm3']);
    expect(res.orphanNotes).toEqual([]);
  });
});

describe('prosody', () => {
  it('knows strong and weak beats', () => {
    expect([0, 1, 2, 3, 0.5, 0.25].map((b) => beatStrength(b))).toEqual([4, 2, 3, 2, 1, 0]);
  });
  it('flags a stressed syllable on a weak beat next to an unstressed one on the downbeat', () => {
    // a-MO-re with "a" on the downbeat and "mo" on the off-beat
    const line = alignLines(buildLines('amore', 'it', id), notes([0, 0.5, 1])).lines;
    const issues = checkProsody(line, notes([0, 0.5, 1]));
    expect(issues.map((i) => i.code)).toContain('weak_stress');
    // shifted so "mo" lands on the beat: fine
    const good = notes([0.5, 1, 1.5]);
    expect(checkProsody(alignLines(buildLines('amore', 'it', id), good).lines, good).map((i) => i.code)).not.toContain('weak_stress');
  });
  it('flags long unstressed endings, words cut by rests and count mismatches', () => {
    const nn: MelodyNote[] = [
      { id: 'a', start: 0, duration: 1 },
      { id: 'b', start: 1, duration: 2 }, // "sole": long unstressed "le" mid-line
      { id: 'c', start: 3, duration: 0.5 },
      { id: 'd', start: 5, duration: 0.5 }, // rest of 1.5 beats inside "mare"
    ];
    const lines = alignLines(buildLines('sole mare', 'it', id), nn).lines;
    const codes = checkProsody(lines, nn).map((i) => i.code);
    expect(codes).toContain('long_unstressed');
    expect(codes).toContain('split_word');
    const two = buildLines('uno\ndue tre quattro', 'it', id);
    const ph = notes([0, 0.5, 4, 4.5]);
    expect(checkProsody(alignLines(two, ph).lines, ph).find((i) => i.code === 'syllable_count')).toBeTruthy();
  });
  it('suggests a rhythm with stressed syllables on beats', () => {
    const r = suggestRhythm(buildSyllables('la mia canzone', 'it'));
    for (const x of r.filter((s) => s.stressed)) expect(Number.isInteger(x.start)).toBe(true);
    expect(r[r.length - 1].duration).toBe(2);
  });
});

describe('English', () => {
  it('splits common words', () => {
    expect(syllabifyEn('music')).toEqual(['mu', 'sic']);
    expect(syllabifyEn('love')).toEqual(['love']);
    expect(syllabifyEn('table')).toEqual(['ta', 'ble']);
    expect(syllabifyEn('together').length).toBe(3);
    expect(buildSyllables('tonight', 'en').map((s) => s.stressed)).toEqual([false, true]);
  });
});

describe('chord sheets', () => {
  const sections = [
    { id: 's1', name: 'Verse 1', kind: 'verse' as const, start: 0, length: 8 },
    { id: 's2', name: 'Chorus', kind: 'chorus' as const, start: 8, length: 8 },
  ];
  const chords = [{ start: 0, chord: 'Am' }, { start: 4, chord: 'F' }, { start: 8, chord: 'C' }, { start: 12, chord: 'G' }];
  const v = alignLines(buildLines('la luna sale', 'it', id, 's1'), notes([0, 1, 2, 4, 5])).lines;
  const c = alignLines(buildLines('canto e ballo', 'it', id, 's2'), notes([8, 9, 12, 13])).lines;
  const sheet = { title: 'Luna', key: 'Am', bpm: 90, sections, chords, lines: [...v, ...c], length: 16 };

  it('exports ChordPro with sections and chords before the right syllables', () => {
    expect(toChordPro(sheet)).toBe(
      ['{title: Luna}', '{key: Am}', '{tempo: 90}', '', '{start_of_verse: Verse 1}', '[Am]la luna [F]sale', '{end_of_verse}', '', '{start_of_chorus: Chorus}', '[C]canto e [G]ballo', '{end_of_chorus}', ''].join('\n'),
    );
  });
  it('puts chord changes after the last syllable at the end of the line', () => {
    const one = alignLines(buildLines('la luna', 'it', id, 's1'), notes([0, 1, 2])).lines;
    expect(toChordPro({ ...sheet, lines: one })).toContain('[Am]la luna [F]');
  });
  it('exports chords over lyrics', () => {
    const txt = toChordText(sheet).split('\n');
    expect(txt).toContain('Am      F'); // F sits over "sale", column 8
    expect(txt).toContain('la luna sale');
    expect(txt).toContain('[Chorus]');
  });
});
