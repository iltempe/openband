// Does the melody respect the words? Checks on aligned lyrics, reported as lint issues.
import type { LyricLine } from '../types';
import type { MelodyNote } from './align';
import { phrasesOf } from './align';

export interface ProsodyIssue {
  code: 'syllable_count' | 'weak_stress' | 'long_unstressed' | 'split_word';
  line_id: string;
  message: string;
  note_ids: string[];
  from_beat?: number;
  params: Record<string, string | number>;
}

/** Metric strength of a position in 4/4: 4 = downbeat … 0 = sixteenth. */
export function beatStrength(beat: number, beatsPerBar = 4): number {
  const b = ((beat % beatsPerBar) + beatsPerBar) % beatsPerBar;
  const near = (x: number) => Math.abs(b - x) < 1e-3;
  if (near(0)) return 4;
  if (near(2)) return 3;
  if (near(1) || near(3)) return 2;
  if (Math.abs(b * 2 - Math.round(b * 2)) < 1e-3) return 1;
  return 0;
}

const clean = (t: string) => t.replace(/[^\p{L}‿']/gu, '');

export function checkProsody(lines: LyricLine[], notes: MelodyNote[]): ProsodyIssue[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const out: ProsodyIssue[] = [];
  const phrases = phrasesOf(notes);
  lines.forEach((line, li) => {
    const sy = line.syllables;
    // 1. Syllables vs notes of the matching phrase.
    const phrase = phrases.length === lines.length ? phrases[li] : undefined;
    const needed = sy.reduce((n, s) => n + (s.melisma ? 2 : 1), 0);
    if (phrase && phrase.length !== needed) {
      out.push({ code: 'syllable_count', line_id: line.id, note_ids: phrase.map((n) => n.id), from_beat: phrase[0].start, params: { line: line.text, syllables: sy.length, notes: phrase.length }, message: `“${line.text}”: ${sy.length} syllables but the phrase has ${phrase.length} notes` });
    } else if (!phrase && sy.some((s) => !s.noteId)) {
      out.push({ code: 'syllable_count', line_id: line.id, note_ids: [], params: { line: line.text, syllables: sy.length, notes: sy.filter((s) => s.noteId).length }, message: `“${line.text}”: ${sy.filter((s) => !s.noteId).length} syllables have no note` });
    }
    for (let i = 0; i < sy.length; i++) {
      const s = sy[i];
      const n = s.noteId ? byId.get(s.noteId) : undefined;
      if (!n) continue;
      const str = beatStrength(n.start);
      // 2. Stressed syllable on a weak position while a neighbouring unstressed one takes a strong beat.
      if (s.stressed) {
        const neighbours = [sy[i - 1], sy[i + 1]].filter((x) => x && !x.stressed && x.noteId).map((x) => byId.get(x!.noteId!)!);
        const stronger = neighbours.find((m) => beatStrength(m.start) > str && beatStrength(m.start) >= 2);
        if (stronger) out.push({ code: 'weak_stress', line_id: line.id, note_ids: [n.id, stronger.id], from_beat: n.start, params: { syllable: clean(s.text), line: line.text }, message: `“${clean(s.text)}” is stressed but falls on a weak beat, while an unstressed syllable takes the strong one` });
      }
      // 3. Long note on an unstressed word ending (not at the end of the line).
      if (!s.stressed && i < sy.length - 1 && n.duration >= 1 && !s.melisma && isWordEnd(line, i)) {
        out.push({ code: 'long_unstressed', line_id: line.id, note_ids: [n.id], from_beat: n.start, params: { syllable: clean(s.text), beats: n.duration }, message: `Unstressed “${clean(s.text)}” is held ${n.duration} beats` });
      }
      // 4. A rest of a beat or more inside a word.
      const next = sy[i + 1];
      const nn = next?.noteId ? byId.get(next.noteId) : undefined;
      if (nn && !isWordEnd(line, i) && nn.start - (n.start + n.duration) >= 1 - 1e-6) {
        out.push({ code: 'split_word', line_id: line.id, note_ids: [n.id, nn.id], from_beat: n.start, params: { syllables: `${clean(s.text)}-${clean(next.text)}` }, message: `The word is cut by a rest between “${clean(s.text)}” and “${clean(next.text)}”` });
      }
    }
  });
  return out;
}

/** Whether syllable i ends a word: compare the line's words with the syllables' letters. */
function isWordEnd(line: LyricLine, i: number): boolean {
  const words = line.text.split(/\s+/).map((w) => w.replace(/[^\p{L}']/gu, '').toLowerCase()).filter(Boolean);
  let wi = 0;
  let acc = '';
  for (let k = 0; k <= i; k++) {
    for (const part of line.syllables[k].text.toLowerCase().split('‿')) {
      acc += part.replace(/[^\p{L}']/gu, '');
      while (wi < words.length && acc.length >= words[wi].length && acc.startsWith(words[wi])) {
        acc = acc.slice(words[wi].length);
        wi++;
      }
    }
    if (k === i) return acc === '';
  }
  return true;
}

/** Durations for the syllables of a line: stressed ones land on beats, the last one is long. */
export function suggestRhythm(syllables: { text: string; stressed: boolean }[]): { syllable: string; start: number; duration: number; stressed: boolean }[] {
  const out: { syllable: string; start: number; duration: number; stressed: boolean }[] = [];
  let t = 0;
  // Pick-up: unstressed syllables before the first stress go before the downbeat.
  const firstStress = Math.max(0, syllables.findIndex((s) => s.stressed));
  t = -0.5 * firstStress;
  syllables.forEach((s, i) => {
    const last = i === syllables.length - 1;
    if (s.stressed && Math.abs(t - Math.round(t)) > 1e-6) t = Math.ceil(t); // stressed syllables start on a beat
    const nextStressed = syllables[i + 1]?.stressed;
    const duration = last ? 2 : s.stressed ? (nextStressed ? 1 : 0.5) : 0.5;
    out.push({ syllable: s.text, start: +t.toFixed(3), duration, stressed: s.stressed });
    t += duration;
  });
  // Shift so the line starts at 0 (pick-ups become positive offsets inside the first bar).
  // A whole number of beats, so syllables placed on beats stay on beats.
  const shift = out.length ? Math.ceil(-Math.min(0, out[0].start)) : 0;
  return out.map((x) => ({ ...x, start: +(x.start + shift).toFixed(3) }));
}
