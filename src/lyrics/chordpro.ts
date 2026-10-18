// Chord sheets: ChordPro and plain "chords over lyrics" text, from sections, chords and lyrics.
import type { LyricLine, Section } from '../types';

export interface SheetChord {
  start: number;
  chord: string;
}

export interface SheetInput {
  title: string;
  key: string;
  bpm: number;
  sections: Section[];
  chords: SheetChord[];
  lines: LyricLine[];
  /** Song length in beats (for sections without lyrics). */
  length: number;
}

const ENV: Partial<Record<Section['kind'], string>> = { verse: 'verse', chorus: 'chorus', bridge: 'bridge' };

const chordAt = (chords: SheetChord[], beat: number) => [...chords].reverse().find((c) => c.start <= beat + 1e-6)?.chord;

/** One lyric line with [Chord] marks before the syllables where the harmony changes. */
function chordproLine(line: LyricLine, chords: SheetChord[], state: { last?: string }): string {
  let out = '';
  const words = line.text.split(/\s+/);
  // Re-spell the line from its words, inserting chords at syllable boundaries.
  let sIdx = 0;
  const syl = line.syllables;
  for (let w = 0; w < words.length; w++) {
    let word = words[w];
    let piece = '';
    while (sIdx < syl.length && word.length) {
      const parts = syl[sIdx].text.split('‿');
      const own = parts[0];
      const at = syl[sIdx].beat;
      const c = at !== undefined ? chordAt(chords, at) : undefined;
      if (c && c !== state.last) {
        piece += `[${c}]`;
        state.last = c;
      }
      // Take the syllable's letters from the word (keeps punctuation in place).
      const letters = own.replace(/[^\p{L}']/gu, '').length;
      let taken = '';
      let count = 0;
      while (word.length && (count < letters || !/\p{L}/u.test(word[0]))) {
        if (/[\p{L}']/u.test(word[0])) count++;
        taken += word[0];
        word = word.slice(1);
        if (count >= letters && word.length && !/\p{L}/u.test(word[0]) && !/['’]/.test(word[0])) {
          // trailing punctuation stays with this syllable
          while (word.length && !/\p{L}/u.test(word[0])) {
            taken += word[0];
            word = word.slice(1);
          }
        }
      }
      piece += taken;
      if (parts.length > 1) {
        // synalepha: the next word's first syllable was merged into this one
        out += piece + ' ';
        piece = '';
        w++;
        word = words[w] ?? '';
        const restLetters = parts.slice(1).join('').replace(/[^\p{L}']/gu, '').length;
        let n = 0;
        while (word.length && n < restLetters) {
          if (/\p{L}/u.test(word[0])) n++;
          piece += word[0];
          word = word.slice(1);
        }
      }
      sIdx++;
    }
    out += piece + word + (w < words.length - 1 ? ' ' : '');
  }
  return out.trim();
}

export function toChordPro(s: SheetInput): string {
  const out = [`{title: ${s.title}}`, `{key: ${s.key}}`, `{tempo: ${Math.round(s.bpm)}}`, ''];
  const state: { last?: string } = {};
  const sections = [...s.sections].sort((a, b) => a.start - b.start);
  const blocks = sections.length ? sections : [{ id: '', name: '', kind: 'custom' as const, start: 0, length: s.length }];
  for (const sec of blocks) {
    const env = ENV[sec.kind];
    if (env) out.push(`{start_of_${env}: ${sec.name}}`);
    else if (sec.name) out.push(`{comment: ${sec.name}}`);
    const lines = s.lines.filter((l) => (sections.length ? l.sectionId === sec.id || (!l.sectionId && l.syllables[0]?.beat !== undefined && l.syllables[0].beat >= sec.start && l.syllables[0].beat < sec.start + sec.length) : true));
    if (lines.length) {
      lines.forEach((l, i) => {
        let text = chordproLine(l, s.chords, state);
        // Chord changes after the last sung syllable (held notes, rests) go at the end of the line.
        const beats = l.syllables.map((x) => x.beat).filter((x): x is number => x !== undefined);
        if (beats.length) {
          const nextFirst = lines[i + 1]?.syllables.find((x) => x.beat !== undefined)?.beat ?? sec.start + sec.length;
          for (const c of s.chords.filter((c) => c.start > Math.max(...beats) + 1e-6 && c.start < nextFirst - 1e-6)) {
            if (c.chord === state.last) continue;
            text += ` [${c.chord}]`;
            state.last = c.chord;
          }
        }
        out.push(text);
      });
    }
    else {
      const cs = s.chords.filter((c) => c.start >= sec.start && c.start < sec.start + sec.length).map((c) => `[${c.chord}]`);
      if (cs.length) out.push(cs.join(' '));
    }
    if (env) out.push(`{end_of_${env}}`);
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

/** Monospaced "chords above the lyrics" text. */
export function toChordText(s: SheetInput): string {
  return toChordPro(s)
    .split('\n')
    .flatMap((line) => {
      const meta = line.match(/^\{(\w+)(?::\s*(.*))?\}$/);
      if (meta) {
        const [, k, v] = meta;
        if (k === 'title') return [v.toUpperCase()];
        if (k === 'key') return [`Key: ${v}`];
        if (k === 'tempo') return [`Tempo: ${v} BPM`];
        if (k.startsWith('start_of_') || k === 'comment') return [`[${v || k.replace('start_of_', '')}]`];
        return [];
      }
      if (!line.includes('[')) return [line];
      let chordsLine = '';
      let lyric = '';
      for (const m of line.matchAll(/\[([^\]]+)\]|([^[]+)/g)) {
        if (m[1]) {
          if (chordsLine.length > lyric.length) lyric = lyric.padEnd(chordsLine.length + 1);
          chordsLine = chordsLine.padEnd(lyric.length) + m[1] + ' ';
        } else lyric += m[2];
      }
      return lyric.trim() ? [chordsLine.trimEnd(), lyric] : [chordsLine.trimEnd()];
    })
    .join('\n');
}
