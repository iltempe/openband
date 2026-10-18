// English syllables (heuristic) and stress (small dictionary of common lyric words + rules).

const VOW = 'aeiouy';
const isV = (c: string, i: number, _w?: string) => VOW.includes(c) && !(c === "y" && i === 0);

/** Common words whose stress the rules get wrong; value = stressed syllable index. */
const STRESS: Record<string, number> = {
  again: 1, alone: 1, away: 1, about: 1, above: 1, along: 1, around: 1, before: 1, begin: 1, behind: 1, believe: 1, below: 1, beside: 1, between: 1, beyond: 1, forget: 1, forgive: 1,
  tonight: 1, today: 1, tomorrow: 1, together: 1, inside: 1, outside: 0, myself: 1, yourself: 1, without: 1, within: 1, become: 1, because: 1, remember: 1, receive: 1, return: 1,
  hotel: 1, guitar: 1, machine: 1, police: 1, July: 1, December: 1, November: 1, September: 1, October: 1, eternity: 1, forever: 1, whatever: 1, however: 1, surrender: 1, desire: 1,
};

/** Syllables of an English word (vowel groups, silent final e, consonant+le). */
export function syllabifyEn(word: string): string[] {
  const w = word.toLowerCase().replace(/[^a-z']/g, '');
  if (!w) return [word];
  const groups: number[] = []; // start index of each vowel group
  for (let i = 0; i < w.length; i++) if (isV(w[i], i, w) && (i === 0 || !isV(w[i - 1], i - 1, w))) groups.push(i);
  let n = groups.length;
  // Silent final e (love, time), but not consonant + le (ta-ble) and not the only vowel (the, me).
  if (n > 1 && w.endsWith('e') && !w.endsWith('le') && !isV(w[w.length - 2], w.length - 2, w)) n--;
  if (n > 1 && /[^aeiou]ed$/.test(w) && !/[td]ed$/.test(w)) n--; // walked, loved
  if (n > 1 && w.endsWith('es') && !/(ses|zes|ches|shes|ges|ces|xes)$/.test(w)) n--; // lives, makes
  n = Math.max(1, n);
  if (n === 1) return [word];
  // Cut before the consonant preceding each later vowel group (V-CV), keeping digraphs together.
  const cuts: number[] = [];
  for (let g = 1; g < n; g++) {
    let i = groups[g];
    let c = i - 1;
    while (c > 0 && !isV(w[c - 1], c - 1, w) && i - c < 2) c--;
    const cluster = w.slice(c, i);
    const cut = cluster.length >= 2 && !/^(th|sh|ch|ph|wh|ck|ng|qu|bl|br|cl|cr|dr|fl|fr|gl|gr|pl|pr|tr|sc|sk|sp|st)$/.test(cluster) ? c + 1 : cluster.length >= 2 ? c : i - (cluster.length ? 1 : 0);
    cuts.push(Math.max(cuts[cuts.length - 1] ?? 1, cut));
  }
  const out: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    out.push(word.slice(prev, c));
    prev = c;
  }
  out.push(word.slice(prev));
  return out.filter(Boolean);
}

export function stressEn(syllables: string[], word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w in STRESS) return Math.min(STRESS[w], syllables.length - 1);
  const n = syllables.length;
  if (n <= 1) return 0;
  if (/(tion|sion|ic|ical|ity)$/.test(w)) return Math.max(0, n - (w.endsWith('ity') || w.endsWith('ical') ? 3 : 2));
  if (/^(a|be|de|re|un|in|ex|for)/.test(w) && n === 2) return 1;
  return 0;
}
