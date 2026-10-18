// Symbolic rules: they read the project only (no audio), so they also run in Node / CI.
import type { LintRule } from '../types';
import { BEATS_PER_BAR, melodicTracks, noteName, playedNotes, regionsOf, type PlayedNote } from '../util';

const BASS_PRESETS = /bass/i;

export const outOfKey: LintRule = {
  id: 'out_of_key',
  category: 'harmony',
  severity: 'warn',
  check(p, ctx) {
    if (!ctx.scale.size) return [];
    const out: ReturnType<LintRule['check']> = [];
    for (const t of melodicTracks(p)) {
      for (const r of regionsOf(p, t.id)) {
        const notes = playedNotes(p, r).sort((a, b) => a.at - b.at || a.pitch - b.pitch);
        const inScale = (n?: PlayedNote) => !!n && ctx.scale.has(n.pitch % 12);
        const bad = notes.filter((n, i) => {
          if (inScale(n)) return false;
          // Short chromatic passing notes between two scale notes are fine.
          const passing = n.end - n.at <= 0.5 && inScale(notes[i - 1]) && inScale(notes[i + 1]);
          return !passing;
        });
        if (!bad.length) continue;
        const fixed = bad.map((n) => {
          const down = [...Array(7)].map((_, k) => n.pitch - k).find((x) => ctx.scale.has(((x % 12) + 12) % 12))!;
          const up = [...Array(7)].map((_, k) => n.pitch + k).find((x) => ctx.scale.has(x % 12))!;
          return { id: n.id, pitch: n.pitch - down <= up - n.pitch ? down : up };
        });
        out.push({
          message: `${bad.length} note(s) outside ${p.key} in “${r.name}” on ${t.name}: ${[...new Set(bad.map((n) => noteName(n.pitch)))].join(', ')}`,
          params: { n: bad.length, key: p.key, region: r.name, track: t.name, notes: [...new Set(bad.map((n) => noteName(n.pitch)))].join(', ') },
          target: { track_id: t.id, region_id: r.id, note_ids: bad.map((n) => n.id) },
          fix: { label: `Move them to the nearest note of ${p.key}`, commands: [{ method: 'update_notes', params: { region_id: r.id, notes: fixed } }] },
        });
      }
    }
    return out;
  },
};

export const overlappingNotes: LintRule = {
  id: 'overlapping_notes',
  category: 'rhythm',
  severity: 'warn',
  check(p) {
    const out: ReturnType<LintRule['check']> = [];
    for (const r of p.regions.filter((x) => !x.audio)) {
      const notes = playedNotes(p, r).sort((a, b) => a.pitch - b.pitch || a.at - b.at);
      for (let i = 1; i < notes.length; i++) {
        const a = notes[i - 1];
        const b = notes[i];
        if (a.pitch !== b.pitch || b.at >= a.end - 1e-6) continue;
        out.push({
          message: `Two ${noteName(a.pitch)} overlap in “${r.name}”`,
          params: { note: noteName(a.pitch), region: r.name },
          target: { track_id: r.trackId, region_id: r.id, note_ids: [a.id, b.id], from_beat: b.at, to_beat: a.end },
          fix: { label: 'Shorten the first note', commands: [{ method: 'update_notes', params: { region_id: r.id, notes: [{ id: a.id, duration: +(b.at - a.at).toFixed(4) }] } }] },
        });
      }
    }
    return out;
  },
};

export const notesOutsideRegion: LintRule = {
  id: 'notes_outside_region',
  category: 'arrangement',
  severity: 'warn',
  check(p) {
    const out: ReturnType<LintRule['check']> = [];
    for (const r of p.regions.filter((x) => !x.audio)) {
      const outside = r.notes.filter((n) => n.start >= r.length);
      if (!outside.length) continue;
      const end = Math.max(...outside.map((n) => n.start + n.duration));
      out.push({
        message: `${outside.length} note(s) after the end of “${r.name}” never play`,
        params: { n: outside.length, region: r.name },
        target: { track_id: r.trackId, region_id: r.id, note_ids: outside.map((n) => n.id) },
        fix: { label: 'Extend the region to include them', commands: [{ method: 'update_region', params: { region_id: r.id, length_bars: Math.ceil(end / BEATS_PER_BAR) } }] },
      });
    }
    return out;
  },
};

export const overlappingRegions: LintRule = {
  id: 'overlapping_regions',
  category: 'arrangement',
  severity: 'warn',
  check(p) {
    const out: ReturnType<LintRule['check']> = [];
    for (const t of p.tracks) {
      const rs = p.regions.filter((r) => r.trackId === t.id).sort((a, b) => a.start - b.start);
      for (let i = 0; i < rs.length; i++) {
        for (let j = i + 1; j < rs.length && rs[j].start < rs[i].start + rs[i].length; j++) {
          out.push({
            message: `“${rs[i].name}” and “${rs[j].name}” overlap on ${t.name}`,
            params: { a: rs[i].name, b: rs[j].name, track: t.name },
            target: { track_id: t.id, region_id: rs[j].id, from_beat: rs[j].start, to_beat: Math.min(rs[i].start + rs[i].length, rs[j].start + rs[j].length) },
          });
        }
      }
    }
    return out;
  },
};

const E2 = 40;
export const lowEndClash: LintRule = {
  id: 'low_end_clash',
  category: 'arrangement',
  severity: 'warn',
  check(p) {
    const low = melodicTracks(p)
      .map((t) => ({ t, notes: regionsOf(p, t.id).flatMap((r) => playedNotes(p, r)).filter((n) => n.pitch < E2) }))
      .filter((x) => x.notes.length);
    const out: ReturnType<LintRule['check']> = [];
    for (let i = 0; i < low.length; i++) {
      for (let j = i + 1; j < low.length; j++) {
        let overlap = 0;
        let from = Infinity;
        let to = -Infinity;
        for (const a of low[i].notes)
          for (const b of low[j].notes) {
            const o = Math.min(a.end, b.end) - Math.max(a.at, b.at);
            if (o > 0) {
              overlap += o;
              from = Math.min(from, Math.max(a.at, b.at));
              to = Math.max(to, Math.min(a.end, b.end));
            }
          }
        if (overlap <= 1) continue;
        // Keep the real bass down: move the other one (fewer low notes, or not a bass sound) up an octave.
        const weight = (x: (typeof low)[number]) => x.notes.reduce((s, n) => s + n.end - n.at, 0) + (BASS_PRESETS.test(x.t.instrument + x.t.name) ? 1000 : 0);
        const [keep, move] = weight(low[i]) >= weight(low[j]) ? [low[i], low[j]] : [low[j], low[i]];
        const regions = [...new Set(move.notes.map((n) => n.regionId))];
        out.push({
          message: `${keep.t.name} and ${move.t.name} both play below E2 at the same time for ${overlap.toFixed(1)} beats`,
          params: { a: keep.t.name, b: move.t.name, beats: overlap.toFixed(1) },
          target: { track_id: move.t.id, from_beat: from, to_beat: to },
          fix: { label: `Move ${move.t.name} up an octave`, commands: regions.map((region_id) => ({ method: 'transpose_region', params: { region_id, semitones: 12 } })) },
        });
      }
    }
    return out;
  },
};

export const registerCrowding: LintRule = {
  id: 'register_crowding',
  category: 'arrangement',
  severity: 'info',
  check(p) {
    const tracks = melodicTracks(p);
    const end = Math.max(0, ...p.regions.map((r) => r.start + r.length));
    const bars = Math.ceil(end / BEATS_PER_BAR);
    const mean = tracks.map((t) => {
      const notes = regionsOf(p, t.id).flatMap((r) => playedNotes(p, r));
      return Array.from({ length: bars }, (_, b) => {
        const inBar = notes.filter((n) => n.at < (b + 1) * BEATS_PER_BAR && n.end > b * BEATS_PER_BAR);
        return inBar.length ? inBar.reduce((s, n) => s + n.pitch, 0) / inBar.length : null;
      });
    });
    const crowded = Array.from({ length: bars }, (_, b) => {
      const vals = mean.map((m, i) => ({ v: m[b], t: tracks[i] })).filter((x) => x.v !== null) as { v: number; t: (typeof tracks)[number] }[];
      vals.sort((a, c) => a.v - c.v);
      for (let i = 0; i + 2 < vals.length; i++) if (vals[i + 2].v - vals[i].v <= 12) return vals.slice(i, i + 3).map((x) => x.t);
      return null;
    });
    const out: ReturnType<LintRule['check']> = [];
    for (let b = 0; b < bars; ) {
      if (!crowded[b]) {
        b++;
        continue;
      }
      let e = b;
      while (e < bars && crowded[e]) e++;
      if (e - b > 2) {
        const names = crowded[b]!.map((t) => t.name);
        out.push({
          message: `${names.join(', ')} play in the same octave for ${e - b} bars (bars ${b + 1}–${e})`,
          params: { tracks: names.join(', '), bars: e - b, from: b + 1, to: e },
          target: { from_beat: b * BEATS_PER_BAR, to_beat: e * BEATS_PER_BAR },
        });
      }
      b = e;
    }
    return out;
  },
};

/** Deterministic ±amount per note, so the fix is reproducible. */
function jitter(id: string, amount: number) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((((h >>> 0) % 1000) / 1000) * 2 - 1) * amount;
}

export const roboticVelocity: LintRule = {
  id: 'robotic_velocity',
  category: 'rhythm',
  severity: 'info',
  check(p) {
    const out: ReturnType<LintRule['check']> = [];
    for (const r of p.regions.filter((x) => !x.audio)) {
      const notes = playedNotes(p, r);
      if (notes.length < 16) continue;
      const m = notes.reduce((s, n) => s + n.velocity, 0) / notes.length;
      const sd = Math.sqrt(notes.reduce((s, n) => s + (n.velocity - m) ** 2, 0) / notes.length);
      if (sd >= 0.02) continue;
      out.push({
        message: `All ${notes.length} notes of “${r.name}” have the same velocity: it sounds mechanical`,
        params: { n: notes.length, region: r.name },
        target: { track_id: r.trackId, region_id: r.id },
        fix: {
          label: 'Humanize velocities (±0.08)',
          commands: [{ method: 'update_notes', params: { region_id: r.id, notes: notes.map((n) => ({ id: n.id, velocity: +Math.min(1, Math.max(0.05, n.velocity + jitter(n.id, 0.08))).toFixed(3) })) } }],
        },
      });
    }
    return out;
  },
};

export const roboticTiming: LintRule = {
  id: 'robotic_timing',
  category: 'rhythm',
  severity: 'info',
  check(p) {
    const out: ReturnType<LintRule['check']> = [];
    for (const t of melodicTracks(p)) {
      for (const r of regionsOf(p, t.id)) {
        if (/arp/i.test(r.name)) continue;
        const notes = playedNotes(p, r);
        if (notes.length < 8) continue;
        const onGrid = notes.every((n) => Math.abs(n.start * 4 - Math.round(n.start * 4)) < 1e-6);
        // Melodic playing has varied lengths; patterns and block chords are fine on the grid.
        const lengths = new Set(notes.map((n) => +n.duration.toFixed(3)));
        if (!onGrid || lengths.size < 3) continue;
        out.push({
          message: `Every note of “${r.name}” sits exactly on the 1/16 grid`,
          params: { region: r.name },
          target: { track_id: t.id, region_id: r.id },
        });
      }
    }
    return out;
  },
};

export const emptyTrack: LintRule = {
  id: 'empty_track',
  category: 'arrangement',
  severity: 'info',
  check(p) {
    return p.tracks
      .filter((t) => !p.regions.some((r) => r.trackId === t.id))
      .map((t) => ({
        message: `${t.name} has no regions`,
        params: { track: t.name },
        target: { track_id: t.id },
        fix: { label: 'Delete the track', commands: [{ method: 'delete_track', params: { track_id: t.id } }] },
      }));
  },
};

export const bassPanned: LintRule = {
  id: 'bass_panned',
  category: 'mix',
  severity: 'warn',
  check(p) {
    const out: ReturnType<LintRule['check']> = [];
    for (const t of p.tracks) {
      if (Math.abs(t.pan) <= 0.2) continue;
      const notes = p.regions.filter((r) => r.trackId === t.id && !r.audio).flatMap((r) => playedNotes(p, r));
      if (!notes.length) continue;
      const low = t.kind === 'drums' ? notes.some((n) => n.pitch === 36) : notes.reduce((s, n) => s + n.pitch, 0) / notes.length < 48;
      if (!low) continue;
      out.push({
        message: `${t.name} carries ${t.kind === 'drums' ? 'the kick' : 'the low end'} but is panned ${t.pan > 0 ? 'right' : 'left'} (${t.pan.toFixed(2)})`,
        params: { track: t.name, pan: t.pan.toFixed(2) },
        target: { track_id: t.id },
        fix: { label: 'Centre it', commands: [{ method: 'update_track', params: { track_id: t.id, pan: 0 } }] },
      });
    }
    return out;
  },
};

export const sectionGap: LintRule = {
  id: 'section_gap',
  category: 'structure',
  severity: 'info',
  check(p) {
    const secs = [...(p.sections ?? [])].sort((a, b) => a.start - b.start);
    if (!secs.length) return [];
    const end = Math.max(0, ...p.regions.map((r) => r.start + r.length));
    const out: ReturnType<LintRule['check']> = [];
    let cursor = 0;
    for (const s of [...secs, { start: end, length: 0 }]) {
      if (s.start - cursor >= BEATS_PER_BAR) {
        out.push({
          message: `Bars ${cursor / BEATS_PER_BAR + 1}–${s.start / BEATS_PER_BAR} are not in any section`,
          params: { from: cursor / BEATS_PER_BAR + 1, to: s.start / BEATS_PER_BAR },
          target: { from_beat: cursor, to_beat: s.start },
        });
      }
      cursor = Math.max(cursor, s.start + s.length);
    }
    return out;
  },
};

import { lyricsProsody } from './lyrics';

export const SYMBOLIC_RULES = [lyricsProsody, outOfKey, overlappingNotes, notesOutsideRegion, overlappingRegions, lowEndClash, registerCrowding, roboticVelocity, roboticTiming, emptyTrack, bassPanned, sectionGap];
