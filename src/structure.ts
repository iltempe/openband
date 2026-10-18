// Song structure: sections and the edits that keep content and sections together (split, move,
// duplicate, delete a span). Pure: functions take and mutate a Project draft, no store/audio.
import type { Project, Region, Section, SectionKind } from './types';
import { BEATS_PER_BAR, uid } from './music';

export const SECTION_COLORS: Record<SectionKind, string> = {
  intro: '#94a3b8',
  verse: '#60a5fa',
  prechorus: '#a78bfa',
  chorus: '#f472b6',
  bridge: '#fbbf24',
  solo: '#fb923c',
  breakdown: '#22d3ee',
  outro: '#94a3b8',
  custom: '#34d399',
};

const EPS = 1e-6;

export const sortSections = (p: Project) => (p.sections ?? []).sort((a, b) => a.start - b.start);

/** Throws when a section would overlap another one. */
export function assertNoOverlap(p: Project, s: { start: number; length: number }, ignoreId?: string) {
  for (const o of p.sections ?? []) {
    if (o.id === ignoreId) continue;
    if (s.start < o.start + o.length - EPS && o.start < s.start + s.length - EPS) {
      throw new Error(`Overlaps section “${o.name}” (bars ${o.start / BEATS_PER_BAR + 1}–${(o.start + o.length) / BEATS_PER_BAR + 1})`);
    }
  }
}

/**
 * Split a region at a song beat. Notes starting before the cut stay (cut short if they cross it),
 * notes from the cut on move to the new region. Returns the new region id, or null if the beat
 * isn't strictly inside the region.
 */
export function splitRegionAt(p: Project, regionId: string, beat: number): string | null {
  const r = p.regions.find((x) => x.id === regionId);
  if (!r || beat <= r.start + EPS || beat >= r.start + r.length - EPS) return null;
  const cut = beat - r.start;
  const right: Region = {
    ...structuredClone(r),
    id: uid('rgn'),
    start: beat,
    length: r.length - cut,
    notes: r.notes.filter((n) => n.start >= cut - EPS && n.start < r.length).map((n) => ({ ...n, id: uid('n'), start: n.start - cut })),
  };
  delete right.takes;
  delete right.activeTakeId;
  if (r.audio && right.audio) right.audio.offset = r.audio.offset + (cut * 60) / p.bpm;
  r.notes = r.notes.filter((n) => n.start < cut - EPS).map((n) => (n.start + n.duration > cut ? { ...n, duration: cut - n.start } : n));
  r.length = cut;
  p.regions.push(right);
  return right.id;
}

/** Split every region crossing a beat. */
export function splitAllAt(p: Project, beat: number) {
  for (const r of [...p.regions]) splitRegionAt(p, r.id, beat);
}

/** Shift everything starting at or after `from` by `delta` beats (regions, automation, sections). */
export function shiftFrom(p: Project, from: number, delta: number, except: { regions?: Set<string>; sections?: Set<string> } = {}) {
  for (const r of p.regions) if (r.start >= from - EPS && !except.regions?.has(r.id)) r.start = Math.max(0, r.start + delta);
  for (const s of p.sections ?? []) if (s.start >= from - EPS && !except.sections?.has(s.id)) s.start = Math.max(0, s.start + delta);
  for (const t of p.tracks) for (const pts of Object.values(t.automation ?? {})) for (const pt of pts ?? []) if (pt.beat >= from - EPS) pt.beat = Math.max(0, pt.beat + delta);
}

const regionsIn = (p: Project, s: number, e: number) => p.regions.filter((r) => r.start >= s - EPS && r.start + r.length <= e + EPS);

/** Move a section and its content so it starts at `to` (a beat on the current timeline). */
export function moveSection(p: Project, sectionId: string, to: number, ripple = true) {
  const sec = p.sections?.find((x) => x.id === sectionId);
  if (!sec) throw new Error(`Section "${sectionId}" not found`);
  const s = sec.start;
  const len = sec.length;
  const e = s + len;
  if (to > s + EPS && to < e - EPS) throw new Error('The destination is inside the section itself');
  splitAllAt(p, s);
  splitAllAt(p, e);
  const moving = new Set(regionsIn(p, s, e).map((r) => r.id));
  const autoMoving = p.tracks.flatMap((t) => Object.values(t.automation ?? {}).flatMap((pts) => (pts ?? []).filter((pt) => pt.beat >= s - EPS && pt.beat < e - EPS)));
  if (!ripple) {
    for (const r of p.regions) if (moving.has(r.id)) r.start += to - s;
    for (const pt of autoMoving) pt.beat += to - s;
    sec.start = to;
    assertNoOverlap(p, sec, sec.id);
    return;
  }
  // Close the gap the section leaves…
  const autoSet = new Set(autoMoving);
  for (const r of p.regions) if (moving.has(r.id)) r.start -= s; // park the content at 0-relative offsets
  for (const pt of autoMoving) pt.beat -= s;
  const parked = { regions: moving, sections: new Set([sec.id]) };
  shiftFromExcept(p, e, -len, parked, autoSet);
  // …then open room at the destination (measured on the timeline without the section) and drop it in.
  const dest = to >= e - EPS ? to - len : to;
  splitAllAtExcept(p, dest, moving);
  shiftFromExcept(p, dest, len, parked, autoSet);
  for (const r of p.regions) if (moving.has(r.id)) r.start += dest;
  for (const pt of autoMoving) pt.beat += dest;
  sec.start = dest;
}

function shiftFromExcept(p: Project, from: number, delta: number, except: { regions: Set<string>; sections: Set<string> }, autoExcept: Set<unknown>) {
  for (const r of p.regions) if (r.start >= from - EPS && !except.regions.has(r.id)) r.start = Math.max(0, r.start + delta);
  for (const x of p.sections ?? []) if (x.start >= from - EPS && !except.sections.has(x.id)) x.start = Math.max(0, x.start + delta);
  for (const t of p.tracks) for (const pts of Object.values(t.automation ?? {})) for (const pt of pts ?? []) if (pt.beat >= from - EPS && !autoExcept.has(pt)) pt.beat = Math.max(0, pt.beat + delta);
}

function splitAllAtExcept(p: Project, beat: number, except: Set<string>) {
  for (const r of [...p.regions]) if (!except.has(r.id)) splitRegionAt(p, r.id, beat);
}

/** Copy a section and its content to `to` (default: right after it). Returns the new section id. */
export function duplicateSection(p: Project, sectionId: string, to?: number, ripple = true): string {
  const sec = p.sections?.find((x) => x.id === sectionId);
  if (!sec) throw new Error(`Section "${sectionId}" not found`);
  const s = sec.start;
  const len = sec.length;
  const e = s + len;
  const dest = to ?? e;
  splitAllAt(p, s);
  splitAllAt(p, e);
  const copies = regionsIn(p, s, e).map((r) => ({ ...structuredClone(r), id: uid('rgn'), notes: r.notes.map((n) => ({ ...n, id: uid('n') })) }));
  const autoCopies = p.tracks.map((t) => ({
    t,
    pts: Object.entries(t.automation ?? {}).flatMap(([param, pts]) => (pts ?? []).filter((pt) => pt.beat >= s - EPS && pt.beat < e - EPS).map((pt) => ({ param, beat: pt.beat - s, value: pt.value }))),
  }));
  if (ripple) {
    splitAllAt(p, dest);
    shiftFrom(p, dest, len);
  }
  for (const c of copies) {
    c.start = dest + (c.start - s);
    delete c.takes;
    delete c.activeTakeId;
    p.regions.push(c);
  }
  for (const { t, pts } of autoCopies) {
    for (const pt of pts) {
      const list = ((t.automation ??= {})[pt.param as keyof NonNullable<typeof t.automation>] ??= []);
      list.push({ beat: dest + pt.beat, value: pt.value });
      list.sort((a, b) => a.beat - b.beat);
    }
  }
  const copy: Section = { ...sec, id: uid('sec'), start: dest };
  if (!ripple) assertNoOverlap(p, copy);
  (p.sections ??= []).push(copy);
  sortSections(p);
  return copy.id;
}

/** Remove a section; with deleteContent also everything inside it (the gap stays). */
export function deleteSection(p: Project, sectionId: string, deleteContent = false) {
  const sec = p.sections?.find((x) => x.id === sectionId);
  if (!sec) throw new Error(`Section "${sectionId}" not found`);
  if (deleteContent) {
    const s = sec.start;
    const e = s + sec.length;
    splitAllAt(p, s);
    splitAllAt(p, e);
    const doomed = new Set(regionsIn(p, s, e).map((r) => r.id));
    p.regions = p.regions.filter((r) => !doomed.has(r.id));
    for (const t of p.tracks) for (const [k, pts] of Object.entries(t.automation ?? {})) (t.automation as Record<string, unknown>)[k] = (pts ?? []).filter((pt) => pt.beat < s - EPS || pt.beat >= e - EPS);
  }
  p.sections = (p.sections ?? []).filter((x) => x.id !== sectionId);
}

// ---------- analysis ----------

export interface SectionProfile {
  active_tracks: string[];
  notes_per_bar: number;
  per_track: { track_id: string; name: string; notes_per_bar: number; mean_velocity: number; mean_pitch: number | null }[];
  mean_velocity: number;
  mean_pitch: number | null;
}

/** How "big" a span of the song is: who plays, how much, how loud (velocity), how high. */
export function energyProfile(p: Project, from: number, to: number): SectionProfile {
  const bars = Math.max(1, (to - from) / BEATS_PER_BAR);
  const per = p.tracks.map((t) => {
    const regions = p.regions.filter((r) => r.trackId === t.id && r.start < to && r.start + r.length > from);
    const notes = regions.flatMap((r) => r.notes.filter((n) => n.start < r.length && r.start + n.start >= from && r.start + n.start < to));
    const audio = regions.some((r) => r.audio);
    return {
      track_id: t.id,
      name: t.name,
      active: notes.length > 0 || audio,
      notes_per_bar: +(notes.length / bars).toFixed(2),
      mean_velocity: notes.length ? +(notes.reduce((s, n) => s + n.velocity, 0) / notes.length).toFixed(2) : 0,
      mean_pitch: notes.length && t.kind === 'instrument' ? +(notes.reduce((s, n) => s + n.pitch, 0) / notes.length).toFixed(1) : null,
      count: notes.length,
    };
  });
  const active = per.filter((x) => x.active);
  const all = active.reduce((s, x) => s + x.count, 0);
  const pitched = active.filter((x) => x.mean_pitch !== null);
  return {
    active_tracks: active.map((x) => x.name),
    notes_per_bar: +(all / bars).toFixed(2),
    per_track: active.map(({ track_id, name, notes_per_bar, mean_velocity, mean_pitch }) => ({ track_id, name, notes_per_bar, mean_velocity, mean_pitch })),
    mean_velocity: all ? +(active.reduce((s, x) => s + x.mean_velocity * x.count, 0) / all).toFixed(2) : 0,
    mean_pitch: pitched.length ? +(pitched.reduce((s, x) => s + x.mean_pitch! * x.count, 0) / pitched.reduce((s, x) => s + x.count, 0)).toFixed(1) : null,
  };
}

/** A fingerprint of what plays in one bar (tracks, pitches, rhythm), for spotting repetitions. */
function barPrint(p: Project, bar: number): string {
  const from = bar * BEATS_PER_BAR;
  const to = from + BEATS_PER_BAR;
  const items: string[] = [];
  for (const r of p.regions) {
    if (r.start >= to || r.start + r.length <= from) continue;
    if (r.audio) {
      items.push(`${r.trackId}:audio:${r.audio.sampleId}:${Math.round(((from - r.start) * 60) / p.bpm + r.audio.offset)}`);
      continue;
    }
    for (const n of r.notes) {
      const at = r.start + n.start;
      if (n.start < r.length && at >= from && at < to) items.push(`${r.trackId}:${n.pitch}:${Math.round((at - from) * 4)}`);
    }
  }
  return items.sort().join('|');
}

const similarity = (a: string, b: string) => {
  if (!a && !b) return 1;
  const A = new Set(a.split('|').filter(Boolean));
  const B = new Set(b.split('|').filter(Boolean));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(1, A.size + B.size - inter);
};

/**
 * Propose sections from the material: the song is cut into 4-bar blocks (breaking at silences),
 * similar blocks get the same letter, and letters are named by their role.
 */
export function proposeSections(p: Project, blockBars = 4): Omit<Section, 'id'>[] {
  const end = Math.max(0, ...p.regions.map((r) => r.start + r.length));
  const bars = Math.ceil(end / BEATS_PER_BAR);
  if (!bars) return [];
  const prints = Array.from({ length: bars }, (_, b) => barPrint(p, b));
  // Blocks: runs of non-silent bars, cut every blockBars.
  const blocks: { start: number; bars: number; prints: string[] }[] = [];
  for (let b = 0; b < bars; ) {
    if (!prints[b]) {
      b++;
      continue;
    }
    let e = b;
    while (e < bars && prints[e] && e - b < blockBars) e++;
    blocks.push({ start: b, bars: e - b, prints: prints.slice(b, e) });
    b = e;
  }
  const blockSim = (x: (typeof blocks)[number], y: (typeof blocks)[number]) =>
    x.bars !== y.bars ? 0 : x.prints.reduce((s, pr, i) => s + similarity(pr, y.prints[i]), 0) / x.bars;
  const letters: number[] = [];
  const reps: number[] = [];
  blocks.forEach((blk, i) => {
    const same = reps.findIndex((r) => blockSim(blocks[r], blk) > 0.6);
    if (same >= 0) letters[i] = same;
    else {
      letters[i] = reps.length;
      reps.push(i);
    }
  });
  // Merge consecutive blocks with the same letter into one section.
  const merged: { letter: number; start: number; bars: number }[] = [];
  blocks.forEach((blk, i) => {
    const last = merged[merged.length - 1];
    if (last && last.letter === letters[i] && last.start + last.bars === blk.start) last.bars += blk.bars;
    else merged.push({ letter: letters[i], start: blk.start, bars: blk.bars });
  });
  // Roles: the densest repeated letter is the chorus, other repeated ones verses, unique first/last intro/outro.
  const count = (l: number) => merged.filter((m) => m.letter === l).length;
  const density = (l: number) => {
    const ms = merged.filter((m) => m.letter === l);
    return ms.reduce((s, m) => s + energyProfile(p, m.start * BEATS_PER_BAR, (m.start + m.bars) * BEATS_PER_BAR).notes_per_bar, 0) / ms.length;
  };
  const repeated = [...new Set(merged.map((m) => m.letter))].filter((l) => count(l) > 1).sort((a, b) => density(b) - density(a));
  const kindOf = (m: (typeof merged)[number], i: number): SectionKind => {
    if (repeated[0] === m.letter) return 'chorus';
    if (repeated.includes(m.letter)) return 'verse';
    if (i === 0 && merged.length > 1) return 'intro';
    if (i === merged.length - 1 && merged.length > 1) return 'outro';
    return merged.length === 1 ? 'verse' : 'bridge';
  };
  const seen: Partial<Record<SectionKind, number>> = {};
  return merged.map((m, i) => {
    const kind = kindOf(m, i);
    seen[kind] = (seen[kind] ?? 0) + 1;
    const label = kind.charAt(0).toUpperCase() + kind.slice(1);
    return { name: count(m.letter) > 1 || seen[kind]! > 1 ? `${label} ${seen[kind]}` : label, kind, start: m.start * BEATS_PER_BAR, length: m.bars * BEATS_PER_BAR, color: SECTION_COLORS[kind] };
  });
}
