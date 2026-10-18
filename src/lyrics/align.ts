// Put syllables on melody notes, in order. A melisma syllable takes the following note(s) too.
import type { LyricLine } from '../types';

export interface MelodyNote {
  id: string;
  /** Song beats. */
  start: number;
  duration: number;
}

export interface AlignResult {
  lines: LyricLine[];
  /** Syllables left without a note (line id → count). */
  orphanSyllables: { line_id: string; count: number }[];
  /** Notes left without a syllable. */
  orphanNotes: string[];
}

/** Notes grouped as phrases: a rest of at least `gap` beats starts a new phrase. */
export function phrasesOf(notes: MelodyNote[], gap = 1): MelodyNote[][] {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const out: MelodyNote[][] = [];
  for (const n of sorted) {
    const cur = out[out.length - 1];
    const last = cur?.[cur.length - 1];
    if (!cur || n.start - (last!.start + last!.duration) >= gap - 1e-6) out.push([n]);
    else cur.push(n);
  }
  return out;
}

/**
 * Align lines to notes in order. Each line starts at the next melodic phrase when line and phrase
 * counts match, otherwise syllables simply follow the notes. Returns new lines (input untouched).
 */
export function alignLines(lines: LyricLine[], notes: MelodyNote[]): AlignResult {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const phrases = phrasesOf(sorted);
  const byPhrase = phrases.length === lines.length;
  const out: LyricLine[] = [];
  const orphanSyllables: AlignResult['orphanSyllables'] = [];
  const used = new Set<string>();
  let cursor = 0;
  lines.forEach((line, li) => {
    const pool = byPhrase ? phrases[li] : sorted.slice(cursor);
    let k = 0;
    const syllables = line.syllables.map((s) => {
      const copy = { ...s };
      delete copy.beat;
      delete copy.noteId;
      const n = pool[k];
      if (n) {
        copy.beat = n.start;
        copy.noteId = n.id;
        used.add(n.id);
        k++;
        // A melisma holds the vowel over the next note as well.
        if (s.melisma && pool[k]) used.add(pool[k++].id);
      }
      return copy;
    });
    const missing = syllables.filter((s) => s.noteId === undefined).length;
    if (missing) orphanSyllables.push({ line_id: line.id, count: missing });
    if (!byPhrase) cursor += k;
    out.push({ ...line, syllables });
  });
  return { lines: out, orphanSyllables, orphanNotes: sorted.filter((n) => !used.has(n.id)).map((n) => n.id) };
}
