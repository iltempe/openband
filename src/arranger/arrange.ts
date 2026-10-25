// Draw the song (G2): from an energy curve and the material there is (often an 8-bar loop), a whole
// arrangement — sections cut where the curve changes, layers that come in with the energy, the drummer
// louder and busier, the lead doubled an octave up on the peaks, the filter opening in crescendos, more
// reverb in the valleys, the second verse with one layer more, transitions (riser, downlifter, reverse
// cymbal, fill, a stop before the drop, impact) and an ending (a fade, or the tonic with a crash).
// The user's own regions are never re-noted: they are moved, copied, shortened or left out. Pure and
// deterministic for a seed.
import type { AutomationLane, MixRole, Note, Project, Region, Section, SectionKind } from '../types';
import { BEATS_PER_BAR, uid } from '../music';
import { makeTrack } from '../store';
import { noteFacts, roleOf } from '../pilot/roles';
import { DRUM_STYLES, generateDrums, type DrumStyle } from '../generate/drummer';
import { parseKey } from '../analysis/harmony';
import { correlation, curveAt, measureEnergy, type EnergyCurve } from './energy';

export type TransitionKind = 'riser' | 'downlifter' | 'reverse_cymbal' | 'fill' | 'stop' | 'impact';
export const TRANSITIONS: TransitionKind[] = ['riser', 'downlifter', 'reverse_cymbal', 'fill', 'stop', 'impact'];

export interface ArrangeOptions {
  curve: EnergyCurve;
  seed?: number;
  /** Drummer style for regenerated drums (pop, rock, funk, house, edm, hiphop, ballad, lofi…). */
  genre?: string;
  /** Reuse the song's sections: a new verse plays the old verse's material, a chorus the chorus's. */
  keep_sections?: boolean;
  /** Raise the last chorus by 1 or 2 semitones (copies only; off unless asked). */
  modulate?: 0 | 1 | 2;
}

export interface ArrangedSection {
  name: string;
  kind: SectionKind;
  start_bar: number;
  bars: number;
  energy: number;
  layers: string[];
}

export interface PlacedTransition {
  kind: TransitionKind;
  /** 1-based bar where it starts. */
  bar: number;
  bars: number;
}

export interface Arrangement {
  project: Project;
  sections: ArrangedSection[];
  transitions: PlacedTransition[];
  ending: 'fade' | 'tonic';
  /** Per bar: the drawn energy and what the arrangement measures. */
  target: number[];
  measured: number[];
  correlation: number;
}

/** The audio of a transition, rendered by the app (src/arranger/transitions.ts): its sample id. */
export const transitionSample = (kind: TransitionKind, seconds: number) => `transition:${kind}:${seconds.toFixed(2)}`;

const BAR = BEATS_PER_BAR;
const round = (x: number) => Math.round(x * 1000) / 1000;
function rng(seed: number) {
  let a = seed >>> 0 || 0x2545f491;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 1. the curve, cut into sections

interface Seg {
  start: number; // bar, 0-based
  bars: number;
  energy: number;
  kind: SectionKind;
}

export function segment(curve: EnergyCurve): Seg[] {
  const L = Math.max(4, Math.round(curve.length_bars / 4) * 4);
  const blocks: number[] = [];
  for (let b = 0; b < L; b += 4) {
    let s = 0;
    for (let k = 1; k <= 4; k++) s += curveAt(curve, b + k);
    blocks.push(s / 4);
  }
  const segs: Seg[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const cur = segs[segs.length - 1];
    if (cur && Math.abs(blocks[i] - cur.energy) < 0.12 && cur.bars < 16) {
      cur.energy = (cur.energy * cur.bars + blocks[i] * 4) / (cur.bars + 4);
      cur.bars += 4;
    } else segs.push({ start: i * 4, bars: 4, energy: blocks[i], kind: 'verse' });
  }
  // Labels: the low start is the intro, the end the outro, the peaks choruses, a valley after the second
  // chorus the bridge, a short rise into a chorus the pre-chorus; the rest are verses.
  const max = Math.max(...segs.map((s) => s.energy));
  const peak = Math.max(0.6, max - 0.2);
  segs.forEach((s) => (s.kind = s.energy >= peak ? 'chorus' : 'verse'));
  if (segs.length > 2) {
    if (segs[0].energy < 0.45 && segs[0].kind !== 'chorus') segs[0].kind = 'intro';
    segs[segs.length - 1].kind = 'outro';
  }
  let choruses = 0;
  segs.forEach((s, i) => {
    if (s.kind === 'chorus') choruses++;
    else if (s.kind === 'verse' && choruses >= 2 && i < segs.length - 1 && segs[i + 1].kind === 'chorus' && s.energy < (segs[i - 1]?.energy ?? 1) - 0.15) s.kind = s.energy < 0.3 ? 'breakdown' : 'bridge';
    else if (s.kind === 'verse' && s.bars <= 4 && segs[i + 1]?.kind === 'chorus' && s.energy > (segs[i - 1]?.energy ?? 0) + 0.05 && segs[i - 1]?.kind === 'verse') s.kind = 'prechorus';
  });
  // At least a verse and a chorus.
  if (!segs.some((s) => s.kind === 'chorus')) segs.reduce((a, b) => (b.energy > a.energy ? b : a)).kind = 'chorus';
  if (!segs.some((s) => s.kind === 'verse')) {
    const i = segs.findIndex((s) => s.kind === 'chorus');
    const v = segs.slice(0, Math.max(1, i)).reverse().find((s) => s.kind !== 'intro') ?? segs.find((s) => s.kind !== 'chorus' && s.kind !== 'intro' && s.kind !== 'outro');
    if (v) v.kind = 'verse';
  }
  return segs;
}

// ---------------------------------------------------------------- 2. who plays, by energy

/** Energy from which a role joins: harmony first, then texture and vocal, the lead, the bass, the drums. */
const ENTER: Record<MixRole, number> = { harmony: 0, texture: 0.12, vocal: 0.18, lead: 0.3, bass: 0.27, drums: 0.42, kick: 0.48, fx: 0.55 };
const STYLE_FOR: Record<string, DrumStyle> = { edm: 'house', dance: 'house', hiphop: 'boom-bap', 'hip-hop': 'boom-bap', rap: 'trap', lofi: 'lo-fi', jazz: 'shuffle', latin: 'bossa' };

const NAMES: Record<SectionKind, string> = { intro: 'Intro', verse: 'Verse', prechorus: 'Pre-chorus', chorus: 'Chorus', bridge: 'Bridge', solo: 'Solo', breakdown: 'Breakdown', outro: 'Outro', custom: 'Section' };

export function arrange(p: Project, o: ArrangeOptions): Arrangement {
  const r = rng(o.seed ?? 1);
  const segs = segment(o.curve);
  const L = segs.reduce((a, s) => Math.max(a, s.start + s.bars), 0);
  const q: Project = structuredClone(p);

  // The material: the span with content (the loop), per track; or per existing section kind.
  const content = p.regions.filter((x) => x.notes.length || x.audio);
  const from = content.length ? Math.floor(Math.min(...content.map((x) => x.start)) / BAR) * BAR : 0;
  const to = content.length ? Math.ceil(Math.max(...content.map((x) => x.start + x.length)) / BAR) * BAR : BAR * 8;
  const tracks = q.tracks.filter((t) => t.kind !== 'audio' || content.some((x) => x.trackId === t.id));
  const roles = new Map(tracks.map((t) => [t.id, roleOf(t, noteFacts(p, t.id))] as const));
  const material = (trackId: string, kind: SectionKind) => {
    const sec = o.keep_sections ? (p.sections ?? []).find((s) => s.kind === kind) : null;
    const lo = sec ? sec.start : from;
    const hi = sec ? sec.start + sec.length : to;
    return { regions: p.regions.filter((x) => x.trackId === trackId && x.start >= lo - 1e-6 && x.start < hi - 1e-6 && (x.notes.length || x.audio)), from: lo, len: Math.max(BAR, hi - lo) };
  };
  const drummerTrack = tracks.find((t) => roles.get(t.id) === 'drums' && p.regions.some((x) => x.trackId === t.id && x.drummer));
  const style = (o.genre && (STYLE_FOR[o.genre.toLowerCase()] ?? (DRUM_STYLES as readonly string[]).find((s) => s === o.genre!.toLowerCase()))) as DrumStyle | undefined;
  const drummerOpts = p.regions.find((x) => x.trackId === drummerTrack?.id && x.drummer)?.drummer;

  // Layers per section; the second verse gets one more (the first that wasn't there).
  const layered = segs.map((s) => {
    let on = tracks.filter((t) => s.energy + 1e-6 >= ENTER[roles.get(t.id) ?? 'harmony']);
    if (!on.length) on = [tracks.reduce((a, b) => (ENTER[roles.get(a.id)!] <= ENTER[roles.get(b.id)!] ? a : b))];
    if (s.kind === 'intro' || s.kind === 'outro') on = on.filter((t) => ['harmony', 'texture', 'vocal', 'lead'].includes(roles.get(t.id)!)).slice(0, Math.max(1, Math.round(s.energy * 4)));
    if (!on.length) on = [tracks[0]];
    return on;
  });
  // The second verse: one layer more — or, when everything already plays, a busier groove.
  let verses = 0;
  let busier = -1;
  segs.forEach((s, i) => {
    if (s.kind !== 'verse') return;
    if (++verses !== 2) return;
    const extra = tracks.filter((t) => !layered[i].includes(t)).sort((a, b) => ENTER[roles.get(a.id)!] - ENTER[roles.get(b.id)!])[0];
    if (extra) layered[i] = [...layered[i], extra];
    else busier = i;
  });

  // ---------------------------------------------------------------- 3. the regions
  const moved = new Set<string>();
  const keep: Region[] = [];
  const sectionsOut: Section[] = [];
  const counts: Partial<Record<SectionKind, number>> = {};
  const totalOf: Partial<Record<SectionKind, number>> = {};
  for (const s of segs) totalOf[s.kind] = (totalOf[s.kind] ?? 0) + 1;
  const stops = new Set<number>(); // sections whose last bar is silent (the stop before a drop)
  const transitions: PlacedTransition[] = [];
  segs.forEach((s, i) => {
    const next = segs[i + 1];
    const prev = segs[i - 1];
    if (next && next.energy - s.energy >= 0.45 && next.kind === 'chorus' && s.bars >= 8) stops.add(i);
    if (next && next.energy - s.energy >= 0.25) transitions.push({ kind: 'riser', bar: s.start + s.bars - (s.bars >= 8 ? 2 : 1) + 1, bars: s.bars >= 8 ? 2 : 1 });
    else if (next && next.energy - s.energy >= 0.12) transitions.push({ kind: 'reverse_cymbal', bar: s.start + s.bars, bars: 1 });
    if (prev && s.energy - prev.energy >= 0.35) transitions.push({ kind: 'impact', bar: s.start + 1, bars: 1 });
    if (prev && prev.energy - s.energy >= 0.3) transitions.push({ kind: 'downlifter', bar: s.start + 1, bars: 2 });
    if (stops.has(i)) transitions.push({ kind: 'stop', bar: s.start + s.bars, bars: 1 });
    if (next && next.energy > s.energy + 0.05 && layered[i].some((t) => roles.get(t.id) === 'drums')) transitions.push({ kind: 'fill', bar: s.start + s.bars, bars: 1 });
  });

  segs.forEach((s, i) => {
    counts[s.kind] = (counts[s.kind] ?? 0) + 1;
    const name = totalOf[s.kind]! > 1 ? `${NAMES[s.kind]} ${counts[s.kind]}` : NAMES[s.kind];
    sectionsOut.push({ id: uid('sec'), name, kind: s.kind, start: s.start * BAR, length: s.bars * BAR });
    const start = s.start * BAR;
    const end = start + s.bars * BAR - (stops.has(i) ? BAR : 0);
    const lastChorus = s.kind === 'chorus' && counts.chorus === totalOf.chorus && (o.modulate ?? 0) > 0;
    for (const t of layered[i]) {
      if (t === drummerTrack) continue; // regenerated below
      const m = material(t.id, s.kind);
      if (!m.regions.length) continue;
      const fillHere = roles.get(t.id) === 'drums' && transitions.some((x) => x.kind === 'fill' && x.bar === s.start + s.bars);
      const stopAt = fillHere ? end - 1 : end;
      for (let k = 0; start + k * m.len < stopAt - 1e-6; k++)
        for (const src of m.regions) {
          const at = start + k * m.len + (src.start - m.from);
          if (at >= stopAt - 1e-6) continue;
          const length = Math.min(src.length, stopAt - at);
          // The first time a user region is needed it moves there itself; after that, copies.
          if (!moved.has(src.id) && !lastChorus) {
            moved.add(src.id);
            keep.push({ ...structuredClone(src), start: round(at), length: round(length) });
          } else {
            const copy: Region = { ...structuredClone(src), id: uid('rgn'), start: round(at), length: round(length), takes: undefined, activeTakeId: undefined };
            delete copy.contribution;
            if (lastChorus && t.kind !== 'drums') copy.notes = copy.notes.map((n) => ({ ...n, pitch: n.pitch + (o.modulate ?? 0) }));
            keep.push(copy);
          }
        }
      // A hand-written drum part gets a one-beat fill (generated) where it was cut short.
      if (fillHere) keep.push({ id: uid('rgn'), trackId: t.id, name: 'Fill', start: end - 1, length: 1, notes: fillNotes(r, 0) });
    }
  });

  // The drummer's own part, played again for the whole song: busier and louder with the energy.
  if (drummerTrack) {
    const base = drummerOpts ?? { style: 'pop', complexity: 0.5, loudness: 0.6, swing: 0, fills: 'end_of_section' as const, seed: 1 };
    segs.forEach((s, i) => {
      if (!layered[i].includes(drummerTrack)) return;
      const bars = s.bars - (stops.has(i) ? 1 : 0);
      if (bars < 1) return;
      const rising = (segs[i + 1]?.energy ?? 0) > s.energy + 0.05;
      const st = style ?? (base.style as DrumStyle);
      const complexity = round(Math.min(1, 0.2 + 0.7 * s.energy + (i === busier ? 0.2 : 0)));
      const loudness = round(Math.min(1, 0.35 + 0.6 * s.energy));
      const fills = rising ? ('end_of_section' as const) : ('none' as const);
      const seed = (o.seed ?? 1) * 101 + i;
      const notes = generateDrums([{ start: 0, bars, kind: s.kind }], { style: st, complexity, loudness, swing: base.swing, fills, seed });
      keep.push({ id: uid('rgn'), trackId: drummerTrack.id, name: `Drums · ${sectionsOut[i].name}`, start: s.start * BAR, length: bars * BAR, notes: notes.map((n) => ({ ...n, id: uid('n') })), drummer: { style: st, complexity, loudness, swing: base.swing, fills, seed } });
    });
  }

  // The lead an octave up on the peaks: a track of its own (generated), the user's lead untouched.
  const lead = tracks.find((t) => roles.get(t.id) === 'lead');
  const peaks = segs.filter((s) => s.energy >= 0.85);
  if (lead && peaks.length) {
    const up = makeTrack(q, 'instrument', lead.instrument, `${lead.name} (octave)`);
    up.volume = Math.min(1, lead.volume * 0.7);
    up.role = 'lead';
    q.tracks.push(up);
    for (const s of peaks)
      for (const x of keep.filter((k) => k.trackId === lead.id && k.start >= s.start * BAR && k.start < (s.start + s.bars) * BAR))
        keep.push({ id: uid('rgn'), trackId: up.id, name: `${x.name} +8va`, start: x.start, length: x.length, notes: x.notes.map((n) => ({ ...n, id: uid('n'), pitch: Math.min(127, n.pitch + 12), velocity: round(n.velocity * 0.85) })) });
  }

  // ---------------------------------------------------------------- 4. automation
  const v = (e: number) => round(0.5 + 0.45 * e);
  for (const t of tracks) {
    const role = roles.get(t.id);
    const lanes: AutomationLane[] = (q.tracks.find((x) => x.id === t.id)!.automation ?? []).filter((l) => !(l.target.kind === 'mix' && (l.target.param === 'tone' || l.target.param === 'reverb')));
    if (role === 'harmony' || role === 'texture') {
      const points = segs.flatMap((s, i) => {
        const nx = segs[i + 1];
        const rising = nx && nx.energy > s.energy + 0.15;
        return [{ beat: s.start * BAR, value: v(s.energy) }, { beat: (s.start + s.bars) * BAR - 0.01, value: rising ? v(nx.energy) : v(s.energy) }];
      });
      lanes.push({ target: { kind: 'mix', param: 'tone' }, points });
    }
    if (role !== 'drums' && role !== 'kick' && role !== 'bass') {
      const base = t.reverb ?? 0.2;
      lanes.push({ target: { kind: 'mix', param: 'reverb' }, points: segs.flatMap((s) => [{ beat: s.start * BAR, value: round(Math.min(1, base + 0.3 * (1 - s.energy))) }, { beat: (s.start + s.bars) * BAR - 0.01, value: round(Math.min(1, base + 0.3 * (1 - s.energy))) }]) });
    }
    q.tracks.find((x) => x.id === t.id)!.automation = lanes;
  }

  // ---------------------------------------------------------------- 5. the ending
  const last = segs[segs.length - 1];
  const falling = segs.length > 1 && last.energy < segs[segs.length - 2].energy;
  const ending: Arrangement['ending'] = falling ? 'fade' : 'tonic';
  if (ending === 'fade') {
    for (const t of q.tracks) {
      const lane = (t.automation ??= []).find((l) => l.target.kind === 'mix' && l.target.param === 'volume');
      const pts = [{ beat: last.start * BAR, value: t.volume }, { beat: (last.start + last.bars) * BAR, value: 0 }];
      if (lane) lane.points = [...lane.points.filter((x) => x.beat < last.start * BAR), ...pts];
      else t.automation.push({ target: { kind: 'mix', param: 'volume' }, points: pts });
    }
  } else {
    // The tonic, held for a bar after the song, with a crash.
    const harm = tracks.find((t) => roles.get(t.id) === 'harmony') ?? tracks.find((t) => t.kind === 'instrument');
    const { tonic, minor } = parseKey(p.key || 'C');
    if (harm) keep.push({ id: uid('rgn'), trackId: harm.id, name: 'Last chord', start: L * BAR, length: BAR, notes: [0, minor ? 3 : 4, 7, 12].map((iv) => ({ id: uid('n'), pitch: 48 + tonic + iv, start: 0, duration: BAR - 0.05, velocity: 0.75 })) });
    const dr = tracks.find((t) => t.kind === 'drums');
    if (dr) keep.push({ id: uid('rgn'), trackId: dr.id, name: 'Crash', start: L * BAR, length: BAR, notes: [{ id: uid('n'), pitch: 49, start: 0, duration: 2, velocity: 0.9 }, { id: uid('n'), pitch: 36, start: 0, duration: 0.5, velocity: 0.9 }] });
  }

  // ---------------------------------------------------------------- 6. transitions on their own track
  const audioTransitions = transitions.filter((x) => x.kind !== 'fill' && x.kind !== 'stop');
  if (audioTransitions.length) {
    const fx = makeTrack(q, 'audio', undefined, 'FX transitions');
    fx.role = 'fx';
    fx.volume = 0.6;
    q.tracks.push(fx);
    const spb = 60 / p.bpm;
    for (const x of audioTransitions) {
      const seconds = round(x.bars * BAR * spb);
      keep.push({ id: uid('rgn'), trackId: fx.id, name: TNAME[x.kind], start: (x.bar - 1) * BAR, length: x.bars * BAR, notes: [], audio: { sampleId: transitionSample(x.kind, seconds), offset: 0, gain: 1 } });
    }
  }

  // User regions that never found a place (their track stays out everywhere) stay out of the song.
  q.regions = keep;
  q.sections = sectionsOut;
  q.energy = o.curve;
  const target = Array.from({ length: L }, (_, b) => round(curveAt(o.curve, b + 1)));
  const measured = measureEnergy(q, L);
  return {
    project: q,
    sections: segs.map((s, i) => ({ name: sectionsOut[i].name, kind: s.kind, start_bar: s.start + 1, bars: s.bars, energy: round(s.energy), layers: layered[i].map((t) => t.name) })),
    transitions,
    ending,
    target,
    measured,
    correlation: round(correlation(measured, target)),
  };
}

const TNAME: Record<TransitionKind, string> = { riser: 'Riser', downlifter: 'Downlifter', reverse_cymbal: 'Reverse cymbal', fill: 'Fill', stop: 'Stop', impact: 'Impact' };

/** A one-beat drum fill: snare sixteenths rising. */
function fillNotes(r: () => number, at: number): Note[] {
  return [0, 0.25, 0.5, 0.75].map((d, i) => ({ id: uid('n'), pitch: i === 3 && r() < 0.5 ? 45 : 38, start: at + d, duration: 0.2, velocity: round(0.6 + i * 0.1) }));
}
