// Running song tests. Pure: the numbers come from `measure` (src/tests/measure.ts in the browser). Symbolic
// tests need no audio: they run on every change, here and on the command line.
import { scalePitchClasses } from '../analysis/key';
import { noteFacts, roleOf } from '../pilot/roles';
import type { Note, Project, Region, Section, Track } from '../types';
import { parseTest } from './parse';
import type { Assertion, Metric, SongTest, TestResult, TestRun, TrackRef } from './types';

/** Stems differ between singular and plural: "chitarre" finds "Chitarra 2". */
const stem = (s: string) => s.trim().toLowerCase().replace(/[aeio]$/, '');

export function tracksOf(p: Project, r: TrackRef): Track[] {
  if (r === 'master') return [];
  if ('track' in r) {
    const exact = p.tracks.filter((t) => t.id === r.track);
    return exact.length ? exact : p.tracks.filter((t) => stem(t.name).startsWith(stem(r.track)) || t.name.toLowerCase().includes(r.track.toLowerCase()));
  }
  return p.tracks.filter((t) => roleOf(t, noteFacts(p, t.id)) === r.role || (r.role === 'drums' && roleOf(t, noteFacts(p, t.id)) === 'kick'));
}

export function sectionsOf(t: SongTest, p: Project): (Section | null)[] {
  const want = t.scope?.sections;
  if (!want?.length) return [null];
  return (p.sections ?? []).filter((s) => want.includes(s.kind) || want.some((x) => x.toLowerCase() === s.name.toLowerCase() || x === s.id));
}

const inSection = (r: Region, n: Note, s: Section | null) => !s || (r.start + n.start >= s.start && r.start + n.start < s.start + s.length);
const notesOf = (p: Project, track: string, s: Section | null) => {
  const ids = new Set(tracksOf(p, { track }).concat(tracksOf(p, parseRef(track))).map((t) => t.id));
  return p.regions.filter((r) => ids.has(r.trackId) && !r.audio).flatMap((r) => r.notes.filter((n) => inSection(r, n, s)).map((n) => ({ r, n, at: r.start + n.start })));
};
const parseRef = (word: string): TrackRef => {
  const a = parseTest(`${word}.rms >= 0`).assert;
  return a.kind === 'compare' ? a.left.of : { track: word };
};

/** A symbolic test on one section. */
function symbolic(a: Extract<Assertion, { kind: 'symbolic' }>, p: Project, s: Section | null): Omit<TestResult, 'testId'> {
  const notes = notesOf(p, a.track, s);
  const where = (beat?: number) => (beat === undefined ? (s ? { section_id: s.id } : undefined) : { from_beat: beat, to_beat: beat + 1, ...(s ? { section_id: s.id } : {}) });
  if (a.rule === 'pitch_range') {
    const low = Number(a.args?.low);
    const high = Number(a.args?.high);
    const bad = notes.find((x) => x.n.pitch < low || x.n.pitch > high);
    return { pass: !bad, ...(bad ? { value: bad.n.pitch, where: where(bad.at) } : {}), expected: `${low}–${high}` };
  }
  if (a.rule === 'in_key') {
    const scale = scalePitchClasses(p.key);
    const bad = notes.filter((x) => !scale.has(x.n.pitch % 12));
    return { pass: !bad.length, value: bad.length, expected: `no notes outside ${p.key}`, ...(bad[0] ? { where: where(bad[0].at) } : {}) };
  }
  const sorted = [...notes].sort((x, y) => x.at - y.at);
  if (a.rule === 'no_overlap') {
    const i = sorted.findIndex((x, k) => k > 0 && x.at < sorted[k - 1].at + sorted[k - 1].n.duration - 1e-6);
    return { pass: i < 0, expected: 'one note at a time', ...(i >= 0 ? { where: where(sorted[i].at) } : {}) };
  }
  let most = 0;
  let at: number | undefined;
  for (const x of sorted) {
    const n = sorted.filter((y) => y.at <= x.at && y.at + y.n.duration > x.at).length;
    if (n > most) (most = n), (at = x.at);
  }
  const max = Number(a.args?.max);
  return { pass: most <= max, value: most, expected: `≤ ${max}`, ...(most > max ? { where: where(at) } : {}) };
}

export type MeasureFn = (m: Metric, section: Section | null, project: Project) => number | undefined;

function compare(a: Extract<Assertion, { kind: 'compare' }>, p: Project, s: Section | null, measure: MeasureFn): Omit<TestResult, 'testId'> {
  const left = measure(a.left, s, p);
  const where = s ? { section_id: s.id, from_beat: s.start, to_beat: s.start + s.length } : undefined;
  if (left === undefined) return { pass: true, skipped: true };
  if (a.op === 'between') {
    const [lo, hi] = a.right as [number, number];
    return { pass: left >= lo && left <= hi, value: left, expected: `${lo} to ${hi}`, ...(where ? { where } : {}) };
  }
  const base = typeof a.right === 'number' ? a.right : measure(a.right as Metric, s, p);
  if (base === undefined) return { pass: true, skipped: true };
  const target = base + (a.margin ?? 0);
  const pass = a.op === '>=' ? left >= target : a.op === '<=' ? left <= target : a.op === '>' ? left > target : left < target;
  return { pass, value: left, expected: `${a.op} ${+target.toFixed(2)}`, ...(where ? { where } : {}) };
}

/** Baseline: every track in every section, against the approved version. */
function baseline(a: Extract<Assertion, { kind: 'baseline' }>, p: Project, measure: MeasureFn, approved: Project | null): Omit<TestResult, 'testId'>[] {
  if (!approved) return [{ pass: true, skipped: true, expected: 'an approved version' }];
  const sections: (Section | null)[] = p.sections?.length ? p.sections : [null];
  const out: Omit<TestResult, 'testId'>[] = [];
  for (const t of p.tracks) {
    const before = approved.tracks.find((x) => x.id === t.id);
    if (!before) continue;
    for (const s of sections) {
      const then = approved.sections?.find((x) => x.id === s?.id) ?? (s ? null : null);
      const m: Metric = { of: { track: t.id }, measure: 'rms' };
      const now = measure(m, s, p);
      const old = measure(m, then, approved);
      if (now === undefined || old === undefined) continue;
      const diff = now - old;
      if (Math.abs(diff) > a.tolerance) out.push({ pass: false, value: +diff.toFixed(2), expected: `± ${a.tolerance} dB`, where: { track_id: t.id, ...(s ? { section_id: s.id, from_beat: s.start, to_beat: s.start + s.length } : {}) } });
    }
  }
  return out.length ? out : [{ pass: true, expected: `± ${a.tolerance} dB` }];
}

export interface RunOptions {
  measure?: MeasureFn;
  approved?: Project | null;
  only?: string[];
  now?: number;
}

export function runTests(p: Project, o: RunOptions = {}): TestRun {
  const results: TestResult[] = [];
  const noAudio: MeasureFn = () => undefined;
  for (const t of p.tests ?? []) {
    if (!t.enabled || (o.only && !o.only.includes(t.id))) continue;
    const a = t.assert;
    if (a.kind === 'baseline') {
      for (const r of baseline(a, p, o.measure ?? noAudio, o.approved ?? null)) results.push({ testId: t.id, ...r });
      continue;
    }
    const sections = sectionsOf(t, p);
    if (!sections.length) results.push({ testId: t.id, pass: true, skipped: true, expected: 'no such section in this song' });
    const found = sections.map((s) => (a.kind === 'symbolic' ? symbolic(a, p, s) : compare(a, p, s, o.measure ?? noAudio)));
    // Every section is judged; one line per section that fails, one if they all pass.
    const bad = found.filter((r) => !r.pass);
    for (const r of bad.length ? bad : found.slice(0, 1)) results.push({ testId: t.id, ...r });
  }
  return { at: o.now ?? Date.now(), results };
}

export const isSymbolic = (t: SongTest) => t.assert.kind === 'symbolic';
