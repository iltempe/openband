// Structural diff between two versions of a song, matched by id. Pure.
import type { Note, Project, Region, Section, Track } from '../types';

const BEATS_PER_BAR = 4;
const TOL = 1 / 32;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface FieldChange {
  from: unknown;
  to: unknown;
}
export interface NotesDiff {
  added: Note[];
  removed: Note[];
  changed: { id: string; from: Note; to: Note }[];
}
export interface RegionChange {
  id: string;
  name: string;
  track_id: string;
  fields: Record<string, FieldChange>;
  moved?: boolean;
  resized?: boolean;
  notes?: NotesDiff;
}
export interface ProjectDiff {
  project: Record<string, FieldChange>;
  tracks: { added: Track[]; removed: Track[]; changed: { id: string; name: string; fields: Record<string, FieldChange> }[] };
  regions: { added: Region[]; removed: Region[]; changed: RegionChange[] };
  sections: { added: Section[]; removed: Section[]; changed: { id: string; name: string; fields: Record<string, FieldChange> }[] };
  lyrics_changed: boolean;
  summary: string[];
  identical: boolean;
}

const PROJECT_FIELDS = ['name', 'bpm', 'key', 'masterVolume', 'loop', 'metronome', 'reference'] as const;
const TRACK_FIELDS = ['name', 'kind', 'instrument', 'volume', 'pan', 'mute', 'solo', 'reverb', 'delay', 'cutoff', 'fx', 'automation', 'color'] as const;
const REGION_FIELDS = ['name', 'trackId', 'start', 'length', 'audio', 'activeTakeId'] as const;
const SECTION_FIELDS = ['name', 'kind', 'start', 'length', 'color'] as const;

function fields<T extends object>(a: T, b: T, keys: readonly (keyof T)[]): Record<string, FieldChange> {
  const out: Record<string, FieldChange> = {};
  for (const k of keys) if (!same(a[k], b[k])) out[k as string] = { from: a[k] ?? null, to: b[k] ?? null };
  return out;
}

function byId<T extends { id: string }>(a: T[], b: T[]) {
  const ma = new Map(a.map((x) => [x.id, x]));
  const mb = new Map(b.map((x) => [x.id, x]));
  return {
    added: b.filter((x) => !ma.has(x.id)),
    removed: a.filter((x) => !mb.has(x.id)),
    both: a.filter((x) => mb.has(x.id)).map((x) => [x, mb.get(x.id)!] as const),
  };
}

/** Notes matched by id, then (for the rest) by pitch and start within a 32nd. */
export function diffNotes(a: Note[], b: Note[]): NotesDiff {
  const { added, removed, both } = byId(a, b);
  const changed = both.filter(([x, y]) => !same({ ...x, id: 0 }, { ...y, id: 0 })).map(([x, y]) => ({ id: x.id, from: x, to: y }));
  const leftA = [...removed];
  const leftB: Note[] = [];
  for (const y of added) {
    const i = leftA.findIndex((x) => x.pitch === y.pitch && Math.abs(x.start - y.start) <= TOL);
    if (i < 0) leftB.push(y);
    else {
      const [x] = leftA.splice(i, 1);
      if (Math.abs(x.duration - y.duration) > 1e-6 || Math.abs(x.velocity - y.velocity) > 1e-6 || Math.abs(x.start - y.start) > 1e-6) changed.push({ id: x.id, from: x, to: y });
    }
  }
  return { added: leftB, removed: leftA, changed };
}

const bar = (beat: number) => Math.floor(beat / BEATS_PER_BAR) + 1;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function diffProjects(a: Project, b: Project): ProjectDiff {
  const project = fields(a, b, PROJECT_FIELDS);
  const tr = byId(a.tracks, b.tracks);
  const tracks = { added: tr.added, removed: tr.removed, changed: tr.both.map(([x, y]) => ({ id: x.id, name: y.name, fields: fields(x, y, TRACK_FIELDS) })).filter((c) => Object.keys(c.fields).length) };
  const rg = byId(a.regions, b.regions);
  const regions = {
    added: rg.added,
    removed: rg.removed,
    changed: rg.both
      .map(([x, y]): RegionChange => {
        const f = fields(x, y, REGION_FIELDS);
        const notes = diffNotes(x.notes, y.notes);
        const has = notes.added.length + notes.removed.length + notes.changed.length > 0;
        return { id: x.id, name: y.name, track_id: y.trackId, fields: f, ...(f.start || f.trackId ? { moved: true } : {}), ...(f.length ? { resized: true } : {}), ...(has ? { notes } : {}) };
      })
      .filter((c) => Object.keys(c.fields).length || c.notes),
  };
  const sc = byId(a.sections ?? [], b.sections ?? []);
  const sections = { added: sc.added, removed: sc.removed, changed: sc.both.map(([x, y]) => ({ id: x.id, name: y.name, fields: fields(x, y, SECTION_FIELDS) })).filter((c) => Object.keys(c.fields).length) };
  const lyrics_changed = !same(a.lyrics ?? null, b.lyrics ?? null);

  // Human summary, e.g. "Bass: 12 notes changed in Chorus; tempo 82→86".
  const summary: string[] = [];
  if (project.bpm) summary.push(`tempo ${project.bpm.from}→${project.bpm.to}`);
  if (project.key) summary.push(`key ${project.key.from}→${project.key.to}`);
  if (project.masterVolume) summary.push('master volume changed');
  if (project.name) summary.push(`renamed “${project.name.to}”`);
  const trackName = (id: string) => b.tracks.find((t) => t.id === id)?.name ?? a.tracks.find((t) => t.id === id)?.name ?? id;
  const sectionAt = (beat: number) => (b.sections ?? []).find((s) => beat >= s.start && beat < s.start + s.length)?.name;
  for (const t of tracks.added) summary.push(`+ track ${t.name}`);
  for (const t of tracks.removed) summary.push(`− track ${t.name}`);
  for (const t of tracks.changed) summary.push(`${t.name}: ${Object.keys(t.fields).join(', ')}`);
  for (const r of regions.added) summary.push(`${trackName(r.trackId)}: + region “${r.name}” at bar ${bar(r.start)}`);
  for (const r of regions.removed) summary.push(`${trackName(r.trackId)}: − region “${r.name}” at bar ${bar(r.start)}`);
  for (const r of regions.changed) {
    const parts: string[] = [];
    const n = r.notes ? r.notes.added.length + r.notes.removed.length + r.notes.changed.length : 0;
    const reg = b.regions.find((x) => x.id === r.id)!;
    const where = sectionAt(reg.start) ? ` in ${sectionAt(reg.start)}` : ` at bar ${bar(reg.start)}`;
    if (n) parts.push(`${plural(n, 'note')} changed${where}`);
    if (r.moved) parts.push(`“${r.name}” moved to bar ${bar(reg.start)}`);
    if (r.resized) parts.push(`“${r.name}” resized to ${reg.length / BEATS_PER_BAR} bars`);
    const other = Object.keys(r.fields).filter((k) => !['start', 'trackId', 'length'].includes(k));
    if (other.length) parts.push(`“${r.name}” ${other.join(', ')}`);
    if (parts.length) summary.push(`${trackName(r.track_id)}: ${parts.join(', ')}`);
  }
  for (const s of sections.added) summary.push(`+ section ${s.name}`);
  for (const s of sections.removed) summary.push(`− section ${s.name}`);
  for (const s of sections.changed) summary.push(`section ${s.name}: ${Object.keys(s.fields).join(', ')}`);
  if (lyrics_changed) summary.push('lyrics changed');

  const identical = !summary.length;
  return { project, tracks, regions, sections, lyrics_changed, summary, identical };
}
