// Harmony from MIDI notes: chord recognition, Roman-numeral degrees in the song key, cadences.
// Pure; used by analyze_harmony, chord sheets (F10), explanations (F14) and the linter.

export interface HNote {
  pitch: number;
  /** Song beats. */
  start: number;
  duration: number;
  velocity: number;
}

export interface ChordAt {
  bar: number;
  /** 1-based beat inside the bar where the chord starts. */
  beat: number;
  /** Song beats. */
  start: number;
  length: number;
  chord: string;
  root: number;
  quality: string;
  bass: number;
  roman: string;
  function: 'tonic' | 'subdominant' | 'dominant' | 'secondary' | 'borrowed' | 'chromatic';
  confidence: number;
}

export interface Cadence {
  type: 'authentic' | 'plagal' | 'ii-V-I' | 'deceptive' | 'half';
  bar: number;
  chords: string[];
  /** Section the cadence closes, when it falls at a section end. */
  section?: string;
}

const QUALITIES: { q: string; iv: number[] }[] = [
  { q: '', iv: [0, 4, 7] },
  { q: 'm', iv: [0, 3, 7] },
  { q: 'dim', iv: [0, 3, 6] },
  { q: 'aug', iv: [0, 4, 8] },
  { q: 'sus2', iv: [0, 2, 7] },
  { q: 'sus4', iv: [0, 5, 7] },
  { q: '7', iv: [0, 4, 7, 10] },
  { q: 'maj7', iv: [0, 4, 7, 11] },
  { q: 'm7', iv: [0, 3, 7, 10] },
  { q: 'm7b5', iv: [0, 3, 6, 10] },
  { q: 'dim7', iv: [0, 3, 6, 9] },
  { q: 'add9', iv: [0, 2, 4, 7] },
  { q: '6', iv: [0, 4, 7, 9] },
  { q: 'm6', iv: [0, 3, 7, 9] },
];

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);

export function parseKey(key: string): { tonic: number; minor: boolean; flats: boolean } {
  const minor = key.endsWith('m');
  const root = key.replace(/m$/, '');
  const alias: Record<string, string> = { Db: 'C#', Gb: 'F#', 'A#': 'Bb', 'D#': 'Eb', 'G#': 'Ab' };
  const r = alias[root] ?? root;
  let tonic = SHARP.indexOf(r);
  if (tonic < 0) tonic = FLAT.indexOf(r);
  return { tonic: Math.max(0, tonic), minor, flats: FLAT_KEYS.has(key) || /b/.test(root) };
}

const pcName = (pc: number, flats: boolean) => (flats ? FLAT : SHARP)[((pc % 12) + 12) % 12];

/** Weighted pitch-class profile and lowest pitch of the notes sounding in [from, to). */
function windowProfile(notes: HNote[], from: number, to: number) {
  const w = new Array(12).fill(0);
  let bass = Infinity;
  for (const n of notes) {
    const o = Math.min(n.start + n.duration, to) - Math.max(n.start, from);
    if (o <= 0) continue;
    w[n.pitch % 12] += o * (0.4 + n.velocity);
    if (n.pitch < bass) bass = n.pitch;
  }
  return { w, bass: Number.isFinite(bass) ? bass % 12 : -1, total: w.reduce((a, b) => a + b, 0) };
}

/** Best chord for a pitch-class profile (template matching, bass breaks ties such as C6 / Am7). */
export function matchChord(w: number[], bass: number): { root: number; quality: string; score: number; confidence: number } | null {
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let best: { root: number; quality: string; score: number; confidence: number } | null = null;
  for (let root = 0; root < 12; root++) {
    for (const { q, iv } of QUALITIES) {
      // A 4-note chord needs its added tone (7th, 6th, 9th) to really be there, not just a passing note.
      if (iv.length > 3) {
        const ext = q === 'add9' ? iv[1] : iv[3];
        if (w[(root + ext) % 12] < 0.12 * total) continue;
      }
      const pcs = iv.map((i) => (root + i) % 12);
      const covered = pcs.reduce((s, pc) => s + w[pc], 0);
      const extra = total - covered;
      const missing = pcs.filter((pc) => w[pc] < 0.04 * total).length;
      // Missing the root or the third is worse than missing the fifth.
      const missingCore = (w[root] < 0.04 * total ? 1 : 0) + (iv.length > 1 && w[(root + iv[1]) % 12] < 0.04 * total ? 1 : 0);
      const score = covered - 0.9 * extra - 0.25 * total * missing - 0.3 * total * missingCore + (bass === root ? 0.06 * total : 0) - 0.03 * total * (iv.length - 3);
      if (!best || score > best.score + 1e-9) best = { root, quality: q, score, confidence: +Math.max(0, Math.min(1, (covered - extra) / total - 0.15 * missing)).toFixed(2) };
    }
  }
  return best;
}

const MAJOR_DEG: Record<number, string> = { 0: 'I', 2: 'II', 4: 'III', 5: 'IV', 7: 'V', 9: 'VI', 11: 'VII' };
const MINOR_DEG: Record<number, string> = { 0: 'I', 2: 'II', 3: 'III', 5: 'IV', 7: 'V', 8: 'VI', 10: 'VII' };
const ACC_DEG: Record<number, string> = { 1: 'bII', 3: 'bIII', 6: '#IV', 8: 'bVI', 10: 'bVII' };
const MINORISH = new Set(['m', 'dim', 'm7', 'm7b5', 'dim7', 'm6']);
const suffix = (q: string) => ({ '': '', m: '', dim: '°', aug: '+', sus2: 'sus2', sus4: 'sus4', '7': '7', maj7: 'maj7', m7: '7', m7b5: 'ø7', dim7: '°7', add9: 'add9', '6': '6', m6: '6' })[q] ?? q;

/** Roman numeral and harmonic function of a chord in a key. */
export function romanFor(root: number, quality: string, key: string): { roman: string; fn: ChordAt['function'] } {
  const k = parseKey(key);
  const deg = (((root - k.tonic) % 12) + 12) % 12;
  const table = k.minor ? MINOR_DEG : MAJOR_DEG;
  const isMinorQ = MINORISH.has(quality);
  const dominantQ = quality === '' || quality === '7';
  const numeral = (base: string, lower: boolean) => (lower ? base.toLowerCase() : base);
  // Diatonic chord qualities per degree (natural minor, plus the harmonic-minor V).
  const diatonicMajor: Record<number, 'M' | 'm' | 'd'> = { 0: 'M', 2: 'm', 4: 'm', 5: 'M', 7: 'M', 9: 'm', 11: 'd' };
  const diatonicMinor: Record<number, 'M' | 'm' | 'd'> = { 0: 'm', 2: 'd', 3: 'M', 5: 'm', 7: 'm', 8: 'M', 10: 'M' };
  const dia = (k.minor ? diatonicMinor : diatonicMajor)[deg];
  const kind: 'M' | 'm' | 'd' = quality.startsWith('dim') || quality === 'm7b5' ? 'd' : isMinorQ ? 'm' : 'M';

  if (table[deg] && (dia === kind || (k.minor && deg === 7 && kind === 'M'))) {
    const roman = numeral(table[deg], kind !== 'M') + suffix(quality);
    const fn: ChordAt['function'] = k.minor
      ? deg === 0 || deg === 3 || deg === 8 ? 'tonic' : deg === 5 || deg === 2 ? 'subdominant' : 'dominant'
      : deg === 0 || deg === 9 || deg === 4 ? 'tonic' : deg === 5 || deg === 2 ? 'subdominant' : 'dominant';
    return { roman, fn };
  }
  // Secondary dominant: a major/dominant-7th chord a fifth above a diatonic degree other than the tonic.
  if (dominantQ) {
    const target = (deg + 5) % 12; // the chord it resolves to (a fourth up)
    const targetDia = (k.minor ? diatonicMinor : diatonicMajor)[target];
    if (target !== 0 && table[target] && targetDia && targetDia !== 'd') {
      return { roman: `V${quality === '7' ? '7' : ''}/${numeral(table[target], targetDia === 'm')}`, fn: 'secondary' };
    }
  }
  // Borrowed from the parallel mode (bIII, bVI, bVII, iv in major; IV, major I… in minor).
  const parallel = k.minor ? diatonicMajor : diatonicMinor;
  const parTable = k.minor ? MAJOR_DEG : MINOR_DEG;
  if (parTable[deg] && parallel[deg] === kind) {
    const base = !k.minor && ACC_DEG[deg] ? ACC_DEG[deg] : parTable[deg];
    return { roman: numeral(base, kind !== 'M') + suffix(quality), fn: 'borrowed' };
  }
  const base = ACC_DEG[deg] ?? table[deg] ?? `?${deg}`;
  return { roman: numeral(base, kind !== 'M') + suffix(quality), fn: 'chromatic' };
}

/**
 * Chords of a passage: one per bar, or one per half bar when the two halves clearly differ.
 * Bars without notes produce no chord; repeated identical chords are merged.
 */
export function analyzeChords(notes: HNote[], key: string, fromBeat: number, toBeat: number, beatsPerBar = 4): ChordAt[] {
  const flats = parseKey(key).flats;
  const out: ChordAt[] = [];
  const push = (from: number, to: number) => {
    const { w, bass, total } = windowProfile(notes, from, to);
    if (total <= 0) return;
    const m = matchChord(w, bass);
    if (!m) return;
    // A sixth chord with its sixth in the bass is the relative minor seventh: C6/A → Am7, Cm6/A → Am7b5.
    if ((m.quality === '6' || m.quality === 'm6') && bass === (m.root + 9) % 12) {
      m.quality = m.quality === '6' ? 'm7' : 'm7b5';
      m.root = bass;
    }
    const name = pcName(m.root, flats) + m.quality + (bass >= 0 && bass !== m.root ? `/${pcName(bass, flats)}` : '');
    const { roman, fn } = romanFor(m.root, m.quality, key);
    const prev = out[out.length - 1];
    if (prev && prev.chord === name && Math.abs(prev.start + prev.length - from) < 1e-6) {
      prev.length += to - from;
      prev.confidence = +Math.min(prev.confidence, m.confidence).toFixed(2);
      return;
    }
    const bar = Math.floor(from / beatsPerBar) + 1;
    out.push({ bar, beat: +(from - (bar - 1) * beatsPerBar + 1).toFixed(2), start: from, length: to - from, chord: name, root: m.root, quality: m.quality, bass, roman, function: fn, confidence: m.confidence });
  };
  for (let b = Math.floor(fromBeat / beatsPerBar) * beatsPerBar; b < toBeat; b += beatsPerBar) {
    const mid = b + beatsPerBar / 2;
    const whole = windowProfile(notes, b, b + beatsPerBar);
    const first = windowProfile(notes, b, mid);
    const second = windowProfile(notes, mid, b + beatsPerBar);
    const fm = first.total ? matchChord(first.w, first.bass) : null;
    const sm = second.total ? matchChord(second.w, second.bass) : null;
    const wm = whole.total ? matchChord(whole.w, whole.bass) : null;
    // Split only when one chord doesn't explain the bar (a walking bass alone shouldn't split it).
    const split = fm && sm && (fm.root !== sm.root || fm.quality !== sm.quality) && fm.confidence > 0.55 && sm.confidence > 0.55 && (!wm || wm.confidence < 0.8);
    if (split) {
      push(b, mid);
      push(mid, b + beatsPerBar);
    } else if (whole.total) push(b, b + beatsPerBar);
  }
  return out;
}

const isV = (c: ChordAt) => /^V7?$/.test(c.roman);
const isI = (c: ChordAt) => /^[Ii](maj7|7|6)?$/.test(c.roman);

/** Cadences in a chord sequence; with section ends given, only those closing a section. */
export function findCadences(chords: ChordAt[], sectionEnds?: { beat: number; name: string }[]): Cadence[] {
  const out: Cadence[] = [];
  for (let i = 1; i < chords.length; i++) {
    const a = chords[i - 1];
    const b = chords[i];
    let type: Cadence['type'] | null = null;
    let seq = [a.chord, b.chord];
    if (isV(a) && isI(b)) {
      const pre = chords[i - 2];
      if (pre && /^ii7?$/.test(pre.roman)) {
        type = 'ii-V-I';
        seq = [pre.chord, a.chord, b.chord];
      } else type = 'authentic';
    } else if (/^(IV|iv)$/.test(a.roman.replace(/(maj7|7|6)$/, '')) && isI(b)) type = 'plagal';
    else if (isV(a) && /^(vi|VI)7?$/.test(b.roman)) type = 'deceptive';
    if (!type) continue;
    // It closes a section when its arrival chord is the last chord of that section.
    const next = chords[i + 1];
    const sec = sectionEnds?.find((s) => b.start < s.beat - 1e-6 && (!next || next.start >= s.beat - 1e-6));
    if (sectionEnds && sectionEnds.length && !sec) continue;
    out.push({ type, bar: b.bar, chords: seq, ...(sec ? { section: sec.name } : {}) });
  }
  // A section that stops on V is a half cadence.
  for (const s of sectionEnds ?? []) {
    const last = [...chords].reverse().find((c) => c.start < s.beat);
    if (last && isV(last) && Math.abs(last.start + last.length - s.beat) < 1e-6) out.push({ type: 'half', bar: last.bar, chords: [last.chord], section: s.name });
  }
  return out;
}
