// The parts cassette (D4): which tracks are parts, and the mixes for learning one. Pure.
export type PartMode = 'all' | 'highlight' | 'mute' | 'left';
export const PART_MODES: PartMode[] = ['all', 'highlight', 'mute', 'left'];
export const ACCOMPANIMENT = 'Accompagnamento';

const RULES: [RegExp, string][] = [
  [/^(soprano|sop\.?|s)( *\d+)?$/i, 'Soprano'],
  [/^(contralto|alto|a)( *\d+)?$/i, 'Contralto'],
  [/^(tenore|tenor|ten\.?|t)( *\d+)?$/i, 'Tenore'],
  [/^(basso|bass|b)( *\d+)?$/i, 'Basso'],
  [/^(baritono|baritone|bar\.?)( *\d+)?$/i, 'Baritono'],
  [/^(voce|voice)( *\d+)$/i, 'Voce'],
  [/^(clarinetto|clarinet|tromba|trumpet|sax|flauto|flute|violino|violin|corno|horn|trombone|oboe|fagotto|viola)( *\d+)?$/i, ''],
];

/** "Sop", "T", "Voce 2", "Tromba 2" → the part's name; anything else is accompaniment. */
export function partOf(trackName: string): string | null {
  const name = trackName.trim();
  for (const [re, part] of RULES) {
    const m = re.exec(name);
    if (!m) continue;
    const num = (m[2] ?? '').trim();
    if (!part) return name.charAt(0).toUpperCase() + name.slice(1);
    return num ? `${part} ${num}` : part;
  }
  return null;
}

/** A gain in dB and a pan for each stem. */
export function partMix(mode: PartMode, part: string, mine: string | null, db = { up: 6, down: -9 }) {
  const me = part === mine;
  if (mode === 'all' || !mine) return { db: 0, pan: 0 };
  if (mode === 'highlight') return { db: me ? db.up : db.down, pan: 0 };
  if (mode === 'mute') return { db: me ? -Infinity : 0, pan: 0 };
  return { db: 0, pan: me ? -1 : 1 };
}

export const MODE_NAMES: Record<Exclude<PartMode, 'all'>, string> = { highlight: 'in evidenza', mute: 'muta', left: 'a sinistra' };

/** "03 Signore delle cime – Tenore – in evidenza.m4a". */
export const packName = (index: number, title: string, part: string | null, mode?: Exclude<PartMode, 'all'>) => `${String(index).padStart(2, '0')} ${title}${part ? ` – ${part}` : ''}${mode ? ` – ${MODE_NAMES[mode]}` : ''}.m4a`;

/** Mix stems into a stereo pair. */
export function mixStems(stems: { part: string; channels: Float32Array[] }[], mode: PartMode, mine: string | null) {
  const n = Math.max(...stems.map((s) => s.channels[0].length));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (const s of stems) {
    const m = partMix(mode, s.part, mine);
    if (m.db === -Infinity) continue;
    const g = 10 ** (m.db / 20);
    const [gl, gr] = m.pan < 0 ? [g, 0] : m.pan > 0 ? [0, g] : [g, g];
    const [a, b] = [s.channels[0], s.channels[1] ?? s.channels[0]];
    for (let i = 0; i < a.length; i++) {
      if (m.pan === 0) (L[i] += a[i] * gl), (R[i] += b[i] * gr);
      else if (m.pan < 0) L[i] += ((a[i] + b[i]) / 2) * g;
      else R[i] += ((a[i] + b[i]) / 2) * g;
    }
  }
  return [L, R];
}
