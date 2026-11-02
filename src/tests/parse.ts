// The text form of song tests, for people and AIs, in Italian and English. Pure. format() gives back a line
// that parses to the same test.
import type { SectionKind } from '../types';
import { parsePitch } from '../music';
import type { Assertion, Measure, Metric, SongTest, TrackRef } from './types';

export class TestParseError extends Error {
  constructor(message: string, readonly column: number) {
    super(`${message} (column ${column + 1})`);
  }
}

const KINDS: Record<string, SectionKind> = { ritornello: 'chorus', ritornelli: 'chorus', chorus: 'chorus', choruses: 'chorus', strofa: 'verse', strofe: 'verse', verse: 'verse', verses: 'verse', ponte: 'bridge', bridge: 'bridge', intro: 'intro', outro: 'outro', finale: 'outro', solo: 'solo', pre: 'prechorus', prechorus: 'prechorus', breakdown: 'breakdown' };
const ROLES: Record<string, Exclude<TrackRef, 'master' | { track: string }> extends { role: infer R } ? R : never> = { voce: 'vocal', voci: 'vocal', voice: 'vocal', vocals: 'vocal', vocal: 'vocal', batteria: 'drums', drums: 'drums', cassa: 'kick', kick: 'kick', basso: 'bass', bass: 'bass', armonia: 'harmony', harmony: 'harmony', lead: 'lead', solista: 'lead' };
const MEASURES: Record<string, Measure> = { lufs: 'lufs_i', lufs_i: 'lufs_i', lufs_s_max: 'lufs_s_max', true_peak: 'true_peak', truepeak: 'true_peak', rms: 'rms', plr: 'plr', width: 'width', larghezza: 'width', correlation: 'correlation', correlazione: 'correlation' };

const ref = (word: string): TrackRef => {
  const w = word.trim().toLowerCase();
  if (w === 'master') return 'master';
  const role = ROLES[w];
  return role ? { role } : { track: word.trim() };
};
const refName = (r: TrackRef) => (r === 'master' ? 'master' : 'role' in r ? r.role : r.track);
const num = (s: string) => Number(s.replace(',', '.').replace('−', '-'));
const hz = (n: string, unit: string) => num(n) * (/k/i.test(unit) ? 1000 : 1);

function metric(text: string, at: number): Metric {
  const m = /^(.+?)\.([a-z_]+)$/i.exec(text.trim());
  if (!m) throw new TestParseError(`"${text.trim()}" is not a measure like voce.lufs`, at);
  const measure = MEASURES[m[2].toLowerCase()];
  if (!measure) throw new TestParseError(`Unknown measure "${m[2]}"`, at + m[1].length + 1);
  return { of: ref(m[1]), measure };
}

/** The right side: "-1", "chitarre.lufs + 3 dB", "chitarre.lufs". */
function side(text: string, at: number): { right: Metric | number; margin?: number } {
  const t = text.trim().replace(/\s*dB\s*$/i, '');
  if (/^[-−]?\d+([.,]\d+)?$/.test(t)) return { right: num(t) };
  const m = /^(.+?)\s*([+−-])\s*(\d+(?:[.,]\d+)?)$/.exec(t);
  if (m && /\./.test(m[1])) return { right: metric(m[1], at), margin: (m[2] === '+' ? 1 : -1) * num(m[3]) };
  return { right: metric(t, at) };
}

function body(text: string, offset: number, prefix: string | null): Assertion {
  const t = text.trim();
  let m = /^mono\s+(?:sotto|below)\s+(\d+(?:[.,]\d+)?)\s*(k?hz)$/i.exec(t);
  if (m) {
    if (!prefix) throw new TestParseError('Say which track: "basso: mono sotto 120 Hz"', offset);
    return { kind: 'compare', left: { of: ref(prefix), measure: 'mono_below', band: [0, hz(m[1], m[2])] }, op: '>=', right: 0.9 };
  }
  m = /^note\s+(?:tra|between)\s+(\S+)\s+(?:e|and)\s+(\S+)$/i.exec(t) ?? /^notes\s+between\s+(\S+)\s+and\s+(\S+)$/i.exec(t);
  if (m) {
    if (!prefix) throw new TestParseError('Say which track: "basso: note tra E1 e G3"', offset);
    return { kind: 'symbolic', rule: 'pitch_range', track: prefix, args: { low: parsePitch(m[1]), high: parsePitch(m[2]) } };
  }
  if (prefix && /^(in tonalit[aà]|in key)$/i.test(t)) return { kind: 'symbolic', rule: 'in_key', track: prefix };
  if (prefix && /^(niente sovrapposizioni|no overlaps?)$/i.test(t)) return { kind: 'symbolic', rule: 'no_overlap', track: prefix };
  m = /^(?:polifonia|polyphony)\s*<=\s*(\d+)$/i.exec(t);
  if (prefix && m) return { kind: 'symbolic', rule: 'max_polyphony', track: prefix, args: { max: Number(m[1]) } };
  m = /^masking\s+(\d+(?:[.,]\d+)?)\s*(k?hz)?\s*[–—-]\s*(\d+(?:[.,]\d+)?)\s*(k?hz)\s*(<=|>=|<|>)\s*(\d+(?:[.,]\d+)?)$/i.exec(t);
  if (m) {
    const against = prefix?.split(/\s+vs\s+/i);
    if (against?.length !== 2) throw new TestParseError('Masking needs two tracks: "voce vs chitarre: masking 1–4 kHz <= 0.3"', offset);
    return { kind: 'compare', left: { of: ref(against[0]), measure: 'masking', band: [hz(m[1], m[2] || m[4]), hz(m[3], m[4])], against: ref(against[1]) }, op: m[5] as '<=', right: num(m[6]) };
  }
  m = /^(\S+)\s+(?:tra|between)\s+(\S+)\s+(?:e|and)\s+(\S+)$/i.exec(t);
  if (m) return { kind: 'compare', left: metric(m[1], offset), op: 'between', right: [num(m[2]), num(m[3])] };
  m = /^(.+?)\s*(<=|>=|<|>)\s*(.+)$/.exec(t);
  if (m) return { kind: 'compare', left: metric(m[1], offset), op: m[2] as '<=', ...side(m[3], offset + t.indexOf(m[3])) };
  throw new TestParseError(`I don't understand "${t}"`, offset);
}

export function parseTest(line: string, id = ''): SongTest {
  const text = line.trim();
  if (!text) throw new TestParseError('Empty test', 0);
  const base = { id, name: text, enabled: true, severity: 'error' as const, source: text };
  const cmp = /^(?:rispetto a|compared to)\s+(.+?):\s*(?:ogni traccia|every track)\s*[±+-]+\s*(\d+(?:[.,]\d+)?)\s*dB(?:\s+(?:per sezione|per section))?$/i.exec(text);
  if (cmp) {
    const name = cmp[1].trim();
    return { ...base, assert: { kind: 'baseline', metric: { of: 'master', measure: 'lufs_i' }, tolerance: num(cmp[2]), baseline: /^(approvata|approved)$/i.test(name) ? 'approved' : name } };
  }
  const colon = text.indexOf(':');
  const head = colon > 0 ? text.slice(0, colon).trim() : null;
  const rest = colon > 0 ? text.slice(colon + 1) : text;
  const inSection = head && /^in\s+(.+)$/i.exec(head);
  if (inSection) {
    const kind = KINDS[inSection[1].trim().toLowerCase()];
    // "in ritornello: basso: note tra E1 e G3": a track after the section.
    const inner = rest.indexOf(':');
    const scoped = inner > 0 ? body(rest.slice(inner + 1), colon + inner + 2, rest.slice(0, inner).trim()) : body(rest, colon + 1, null);
    return { ...base, scope: { sections: [kind ?? inSection[1].trim()] }, assert: scoped };
  }
  return { ...base, assert: body(rest, colon + 1, head) };
}

const signed = (n: number) => `${n >= 0 ? '+' : '-'} ${Math.abs(n)} dB`;
const metricText = (m: Metric) => `${refName(m.of)}.${m.measure}`;

/** One canonical line (English keywords). parseTest(format(t)) gives the same assertion. */
export function format(t: SongTest): string {
  const a = t.assert;
  const section = t.scope?.sections?.[0];
  const pre = section ? `in ${section}: ` : '';
  if (a.kind === 'baseline') return `compared to ${a.baseline}: every track ± ${a.tolerance} dB per section`;
  if (a.kind === 'symbolic') {
    if (a.rule === 'pitch_range') return `${pre}${a.track}: notes between ${a.args?.low} and ${a.args?.high}`;
    if (a.rule === 'in_key') return `${pre}${a.track}: in key`;
    if (a.rule === 'no_overlap') return `${pre}${a.track}: no overlaps`;
    return `${pre}${a.track}: polyphony <= ${a.args?.max}`;
  }
  const l = a.left;
  if (l.measure === 'mono_below') return `${pre}${refName(l.of)}: mono below ${l.band?.[1]} Hz`;
  if (l.measure === 'masking') return `${pre}${refName(l.of)} vs ${refName(l.against!)}: masking ${l.band?.[0]} Hz - ${l.band?.[1]} Hz ${a.op} ${a.right}`;
  if (a.op === 'between') {
    const [lo, hi] = a.right as [number, number];
    return `${pre}${metricText(l)} between ${lo} and ${hi}`;
  }
  const r = typeof a.right === 'number' ? a.right : `${metricText(a.right as Metric)}${a.margin ? ` ${signed(a.margin)}` : ''}`;
  return `${pre}${metricText(l)} ${a.op} ${r}`;
}
