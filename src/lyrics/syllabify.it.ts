// Italian syllabification by rule (orthographic syllables) and metric syllables with synalepha.
import { HIATUS, stressIndex } from './stress.it';

const VOWELS = 'aeiouàèéìíòóùú';
const STRONG = 'aeoàèéìíòóùú'; // accented i/u count as strong (they carry the stress)
const isV = (c: string) => VOWELS.includes(c);

/** Consonant groups that can begin a syllable (they never split). */
const ONSETS = new Set([
  'bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'tr', 'vr',
  'ch', 'gh', 'gn', 'sc', 'sch', 'sb', 'sd', 'sf', 'sg', 'sl', 'sm', 'sn', 'sp', 'sq', 'sr', 'st', 'sv', 'sz',
  'spr', 'str', 'scr', 'spl', 'sfr', 'sgr', 'sbr', 'sdr', 'scl', 'sgl', 'sfl', 'sbl',
  // qu/gu before a vowel: the u is part of the consonant sound.
  'qu', 'gu', 'squ', 'sgu',
]);

/** Split a run of vowels into syllable nuclei (diphthongs and triphthongs stay together). */
function nuclei(vs: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < vs.length; i++) {
    const c = vs[i];
    const next = vs[i + 1];
    const weak = !STRONG.includes(c);
    // An unstressed i between two vowels starts the next syllable (gio-ia, a-iuo-la, bu-io, gua-io).
    if (c === 'i' && cur && next !== undefined) {
      out.push(cur);
      cur = c;
      continue;
    }
    if (!cur) {
      cur = c;
      continue;
    }
    const curHasStrong = [...cur].some((x) => STRONG.includes(x));
    // Two strong vowels are always in hiatus (pa-e-se, po-e-ta).
    if (!weak && curHasStrong) {
      out.push(cur);
      cur = c;
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function splitCluster(cluster: string, initial: boolean): [string, string] {
  if (cluster.length <= 1) return ['', cluster];
  if (initial) return ['', cluster];
  for (let k = 0; k < cluster.length; k++) {
    const tail = cluster.slice(k);
    if (tail.length === 1 || ONSETS.has(tail)) {
      // Double consonants always split (gat-to, mag-gio).
      if (k > 0 && cluster[k - 1] === cluster[k] && tail.length > 1 && !ONSETS.has(tail)) continue;
      return [cluster.slice(0, k), tail];
    }
  }
  return [cluster.slice(0, -1), cluster.slice(-1)];
}

/** Orthographic syllables of one word, keeping the original letters (case, accents, apostrophes). */
export function syllabifyWord(word: string): string[] {
  const letters = [...word];
  const lower = word.toLowerCase();
  const clean = lower.replace(/[^a-zàèéìíòóùú]/g, '');
  if (!clean) return [word];
  let parts: string[];
  if (HIATUS[clean]) parts = HIATUS[clean].split('-');
  else {
    // Tokenise into consonant clusters and vowel runs. "qu" and the diacritic i of ci/gi/sci are glides.
    const runs: { v: boolean; s: string }[] = [];
    const chars = [...clean];
    for (let ci = 0; ci < chars.length; ci++) {
      const ch = chars[ci];
      // The u of qu/gu followed by a vowel is a glide of the consonant (quie-to, gua-io, lin-gua).
      const glideU = ch === 'u' && (chars[ci - 1] === 'q' || chars[ci - 1] === 'g') && isV(chars[ci + 1] ?? '');
      const v = isV(ch) && !glideU;
      const last = runs[runs.length - 1];
      if (last && last.v === v) last.s += ch;
      else runs.push({ v, s: ch });
    }
    // "gli" + vowel: the i belongs to the onset sound (fi-glio, fo-glia): keep i with the vowel run.
    const sylls: string[] = [];
    let onset = '';
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (!r.v) {
        if (i === 0) onset = r.s;
        continue;
      }
      const ns = nuclei(r.s);
      ns.forEach((n, j) => {
        if (j === 0) {
          sylls.push(onset + n);
          onset = '';
        } else sylls.push(n);
      });
      const after = runs[i + 1];
      if (!after) break;
      const isLast = i + 2 >= runs.length;
      if (isLast) {
        sylls[sylls.length - 1] += after.s; // final consonants (per, con, non)
        break;
      }
      const [left, right] = splitCluster(after.s, false);
      sylls[sylls.length - 1] += left;
      onset = right;
    }
    if (!sylls.length) return [word];
    // Word-initial clusters (ps-, pn-) go with the first syllable via `onset`.
    parts = sylls;
  }
  // Map back onto the original spelling (keeps case, accents and apostrophes).
  const out: string[] = [];
  let pos = 0;
  for (const p of parts) {
    let taken = '';
    let need = p.length;
    while (pos < letters.length && need > 0) {
      const ch = letters[pos++];
      taken += ch;
      if (/[a-zàèéìíòóùú]/i.test(ch)) need--;
    }
    out.push(taken);
  }
  if (pos < letters.length) out[out.length - 1] += letters.slice(pos).join('');
  return out;
}

export interface ItSyllable {
  text: string;
  stressed: boolean;
  /** Index of the word in the line. */
  word: number;
  /** Last syllable of its word. */
  wordEnd: boolean;
}

/** Words of a line: letters, apostrophes and accents; punctuation is dropped. */
export const words = (line: string) => line.split(/\s+/).map((w) => w.replace(/[^\p{L}'’ˈ_~]/gu, '')).filter((w) => /\p{L}/u.test(w));

/** Syllables of a line with stress marks (one entry per orthographic syllable). */
export function syllabifyLine(line: string): ItSyllable[] {
  const out: ItSyllable[] = [];
  words(line).forEach((w, wi) => {
    // l'amore, dell'anima: the elided article joins the next syllable.
    const sy = syllabifyWord(w);
    const stress = stressIndex(sy, w);
    sy.forEach((s, i) => out.push({ text: s.replace(/ˈ/g, ''), stressed: i === stress && sy.length > 0 && !isClitic(w, sy.length), word: wi, wordEnd: i === sy.length - 1 }));
  });
  return out;
}

/** Unstressed function words (articles, clitics, prepositions) carry no stress in a line. */
const CLITICS = new Set('il lo la i gli le un uno una di a da in con su per tra fra e o ma se che mi ti si ci vi ne non del dello della dei degli delle al allo alla ai agli alle dal dalla nel nella sul sulla col'.split(' '));
const isClitic = (w: string, n: number) => n === 1 && CLITICS.has(w.toLowerCase().replace(/[^a-zà-ú]/g, ''));

const endsWithVowel = (s: string) => /[aeiouàèéìíòóùú]$/i.test(s);
const startsWithVowel = (s: string) => /^h?[aeiouàèéìíòóùú]/i.test(s);

/**
 * Metric syllables: with synalepha, a word ending in a vowel merges with the next word starting
 * with a vowel ("canto e ballo" → can-to‿e-bal-lo = 4).
 */
export function metricSyllables(line: string, synalepha = true): ItSyllable[] {
  const sy = syllabifyLine(line);
  if (!synalepha) return sy;
  const out: ItSyllable[] = [];
  for (const s of sy) {
    const prev = out[out.length - 1];
    if (prev && prev.wordEnd && s.word !== prev.word && endsWithVowel(prev.text) && startsWithVowel(s.text) && !/[_~]$/.test(prev.text)) {
      prev.text = `${prev.text}‿${s.text}`;
      prev.stressed = prev.stressed || s.stressed;
      prev.wordEnd = s.wordEnd;
      prev.word = s.word;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}
