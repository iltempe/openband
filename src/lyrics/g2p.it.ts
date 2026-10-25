// Italian grapheme-to-phoneme by rule (SPEC v0.6 §10): OpenBand gives singing engines the phonemes of
// every syllable, already computed, so their adapters stay language-agnostic. The phoneme set is
// X-SAMPA-like and small:
//   vowels      a e E i o O u          (E, O open: only where the spelling says so — è, ò)
//   semivowels  j w
//   consonants  p b t d k g f v s z ts dz tS dZ S J L m n l r
// Spelling rules: c/g soft before e/i (and the i after them is silent before a vowel: cia, gio), ch/gh
// hard, gn → J, gli → L, sc(i) → S, qu → k w, h silent, s voiced between vowels and before voiced
// consonants, z → dz at the start of a word and ts elsewhere (the usual default; dictionaries differ).
// Double consonants fall on both sides of the syllable break, as the syllabifier splits them.

export const IT_PHONEMES = ['a', 'e', 'E', 'i', 'o', 'O', 'u', 'j', 'w', 'p', 'b', 't', 'd', 'k', 'g', 'f', 'v', 's', 'z', 'ts', 'dz', 'tS', 'dZ', 'S', 'J', 'L', 'm', 'n', 'l', 'r'] as const;
export const IT_VOWELS = new Set(['a', 'e', 'E', 'i', 'o', 'O', 'u']);

const VOWEL_CHARS = 'aeiouàèéìíòóùú';
const isV = (c: string | undefined) => !!c && VOWEL_CHARS.includes(c);
const FRONT = (c: string | undefined) => !!c && 'eiéèìí'.includes(c);
const VOICED = (c: string | undefined) => !!c && 'bdglmnrv'.includes(c);
const VOWEL: Record<string, string> = { a: 'a', à: 'a', e: 'e', é: 'e', è: 'E', i: 'i', ì: 'i', í: 'i', o: 'o', ó: 'o', ò: 'O', u: 'u', ù: 'u', ú: 'u' };

/**
 * The phonemes of one syllable. ctx: the letter before it (for s between vowels) and whether it starts
 * a word (for z). Merged syllables ("to‿e") and melisma marks are handled.
 */
export function phonemesOfSyllable(syllable: string, ctx: { prev?: string; wordStart?: boolean } = {}): string[] {
  const s = syllable.toLowerCase().replace(/[_~ˈ'’]/g, '').replace(/‿/g, '');
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    const prev = i === 0 ? ctx.prev : s[i - 1];
    if (isV(c)) {
      // i/u before another vowel in the same syllable glide (pie → p j e, uo → w o) — unless they carry the stress mark.
      if ((c === 'i' || c === 'u') && isV(n) && i + 1 < s.length) out.push(c === 'i' ? 'j' : 'w');
      else out.push(VOWEL[c] ?? c);
      continue;
    }
    switch (c) {
      case 'h':
        break;
      case 'c':
      case 'g': {
        const hard = c === 'c' ? 'k' : 'g';
        const soft = c === 'c' ? 'tS' : 'dZ';
        if (n === 'h') {
          out.push(hard);
          i++;
        } else if (c === 'g' && n === 'n') {
          out.push('J');
          i++;
        } else if (c === 'g' && n === 'l' && s[i + 2] === 'i') {
          out.push('L');
          i += 2;
          if (!isV(s[i + 1])) out.push('i');
        } else if (FRONT(n)) {
          out.push(soft);
          // cia, gio: the i only softens.
          if ((n === 'i' || n === 'ì') && isV(s[i + 2]) && n === 'i') i++;
        } else if (c === 'g' && n === 'u' && isV(s[i + 2])) {
          out.push('g', 'w');
          i++;
        } else out.push(hard);
        break;
      }
      case 'q':
        out.push('k');
        if (n === 'u') {
          out.push('w');
          i++;
        }
        break;
      case 's':
        if (n === 'c' && FRONT(s[i + 2])) {
          out.push('S');
          i++;
          if (s[i + 1] === 'i' && isV(s[i + 2])) i++;
        } else out.push((isV(prev) && isV(n)) || VOICED(n) ? 'z' : 's');
        break;
      case 'z':
        out.push(i === 0 && ctx.wordStart ? 'dz' : 'ts');
        break;
      case 'x':
        out.push('k', 's');
        break;
      case 'j':
        out.push('j');
        break;
      case 'y':
        out.push('i');
        break;
      case 'k':
        out.push('k');
        break;
      case 'w':
        out.push('w');
        break;
      default:
        if ('pbtdfvmnlr'.includes(c)) out.push(c);
    }
  }
  return out;
}

/** Phonemes for a line's syllables (as the syllabifier gives them, with word starts). */
export function phonemizeSyllables(syllables: { text: string; wordStart?: boolean }[]): string[][] {
  let prev: string | undefined;
  const out = syllables.map((sy) => {
    const ph = phonemesOfSyllable(sy.text, { prev: sy.wordStart ? undefined : prev, wordStart: sy.wordStart });
    const t = sy.text.replace(/[^\p{L}]/gu, '');
    prev = t.at(-1)?.toLowerCase();
    return ph;
  });
  // A doubled affricate holds its stop on the first side: piz-za → p i t | ts a, fac-cia → f a t | tS a.
  const STOP: Record<string, string> = { ts: 't', dz: 'd', tS: 't', dZ: 'd' };
  for (let i = 0; i + 1 < out.length; i++) {
    const last = out[i].at(-1);
    const next = out[i + 1][0];
    if (!last || !next || syllables[i + 1].wordStart) continue;
    if (STOP[next] && (last === next || last === 'k' || last === 'g' || last === 'ts')) out[i][out[i].length - 1] = STOP[next];
  }
  return out;
}

/** Where a syllable's vowel is (its nucleus): what sits on the note's onset when it is sung. */
export const nucleusIndex = (ph: string[]) => {
  const i = ph.findIndex((p) => IT_VOWELS.has(p));
  return i < 0 ? 0 : i;
};
