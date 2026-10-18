// Turning lyric text into lines of syllables (Italian metric syllables, or English word syllables).
import type { LyricLine, Syllable } from '../types';
import { metricSyllables } from './syllabify.it';
import { stressEn, syllabifyEn } from './syllabify.en';

/** "_" (or "~") after a syllable makes it a melisma: it carries on over the next note. */
const MELISMA = /[_~]+$/;

export function buildSyllables(text: string, language: 'it' | 'en'): Syllable[] {
  if (language === 'it') {
    return metricSyllables(text).map((s) => ({ text: s.text.replace(MELISMA, ''), stressed: s.stressed, ...(MELISMA.test(s.text) ? { melisma: true } : {}) }));
  }
  const out: Syllable[] = [];
  for (const w of text.split(/\s+/).filter((x) => /[a-z]/i.test(x))) {
    const clean = w.replace(/[^A-Za-z'’_~]/g, '');
    const sy = syllabifyEn(clean.replace(MELISMA, ''));
    const st = stressEn(sy, clean);
    sy.forEach((s, i) => out.push({ text: s, stressed: sy.length === 1 ? !/^(a|an|the|of|to|in|on|and|or|but|i|my|your|is|it)$/i.test(s) : i === st, ...(i === sy.length - 1 && MELISMA.test(clean) ? { melisma: true } : {}) }));
  }
  return out;
}

export function buildLines(text: string, language: 'it' | 'en', id: () => string, sectionId?: string): LyricLine[] {
  return text
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ id: id(), ...(sectionId ? { sectionId } : {}), text: t, syllables: buildSyllables(t, language) }));
}
