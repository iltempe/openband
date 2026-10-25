// `create` (SPEC v0.6 §8.2, first cut for E1): describe a musical part, OpenBand picks the capability and
// the engine, sends it the Song Context Package, conforms what comes back (tempo, key, length) and puts it
// in the song as one undo step — as takes when there are variants — with a ledger entry for each.
import { BEATS_PER_BAR, clamp, uid } from '../music';
import { isAiCommand, makeTrack, useStore } from '../store';
import { getBuffer, importSample } from '../audio/samples';
import type { LedgerEntry, Note, Project, Region, Take, Track } from '../types';
import { buildContext, minimizeContext } from './context';
import { checkContribution, conformNotes, planAudio, type AudioPlan } from './conform';
import { allEngines, callEngine, useEnsemble } from './engines';
import { inferCapability, route, type EngineInfo } from './router';
import { scopeOf } from './builtin';
import type { Capability, Contribution, Scp } from './types';

const st = () => useStore.getState();

export interface CreateArgs {
  /** What to make, in words ("arpeggiated piano, intimate"). */
  text?: string;
  capability?: string;
  track_id?: string;
  section_id?: string;
  /** Bars, inclusive. */
  from_bar?: number;
  to_bar?: number;
  /** Pin an engine by id. */
  engine?: string;
  /** 1–4; from different engines when more than one can play. */
  variants?: number;
  seed?: number;
  role?: string;
  instrument?: string;
  /** The track whose notes are the melody to work from (transform). */
  melody_track_id?: string;
}

const INSTRUMENTS: [RegExp, string, string][] = [
  [/rhodes|electric piano|e\.?\s?piano|wurli/, 'velvet-keys', 'Electric piano'],
  [/organ|organo/, 'retro-organ', 'Organ'],
  [/bell|campan/, 'crystal-bells', 'Bells'],
  [/\bpad\b/, 'aurora-pad', 'Pad'],
  [/string|archi/, 'silk-strings', 'Strings'],
  [/pluck/, 'pluck', 'Pluck'],
  [/8.?bit|chip/, 'chip', '8-bit'],
  [/\b(bass|basso)\b/, 'finger-bass', 'Bass'],
  [/lead|synth/, 'neon-lead', 'Lead'],
  [/piano/, 'felt-piano', 'Piano'],
];
export function instrumentFor(text: string): { instrument: string; name: string } {
  const t = text.toLowerCase();
  const hit = INSTRUMENTS.find(([re]) => re.test(t));
  return hit ? { instrument: hit[1], name: hit[2] } : { instrument: 'felt-piano', name: 'Keys' };
}

/** The bars to fill: a section, explicit bars (inclusive), the cycle, or the whole song. */
export function scopeFor(p: Project, a: CreateArgs): Scp['scope'] {
  if (a.section_id) {
    const s = p.sections?.find((x) => x.id === a.section_id || x.name.toLowerCase() === String(a.section_id).toLowerCase());
    if (!s) throw new Error(`Section "${a.section_id}" not found. Call get_structure.`);
    return { from_bar: s.start / BEATS_PER_BAR + 1, to_bar: (s.start + s.length) / BEATS_PER_BAR + 1, section_id: s.id };
  }
  if (a.from_bar !== undefined) {
    const from = Math.max(1, Math.round(Number(a.from_bar)));
    const to = a.to_bar !== undefined ? Math.round(Number(a.to_bar)) + 1 : from + 4;
    if (!(to > from)) throw new Error('to_bar must be at or after from_bar');
    return { from_bar: from, to_bar: to };
  }
  if (p.loop?.enabled && p.loop.end > p.loop.start) return { from_bar: Math.floor(p.loop.start / BEATS_PER_BAR) + 1, to_bar: Math.ceil(p.loop.end / BEATS_PER_BAR) + 1 };
  const end = Math.max(...p.regions.map((r) => r.start + r.length), ...(p.sections ?? []).map((s) => s.start + s.length), 0);
  return { from_bar: 1, to_bar: Math.max(5, Math.ceil(end / BEATS_PER_BAR) + 1) };
}

interface Made {
  engine: EngineInfo;
  contribution: Contribution;
}

/** Ask the engines for `variants` contributions: rotate across the candidates, fall back on errors. */
async function perform(capability: Capability, candidates: EngineInfo[], scp: Scp, a: CreateArgs, variants: number): Promise<{ made: Made[]; failures: string[] }> {
  const made: Made[] = [];
  const failures: string[] = [];
  const seed = a.seed ?? Math.floor(Math.random() * 1e6);
  for (let v = 0; v < variants; v++) {
    for (let k = 0; k < candidates.length; k++) {
      const e = candidates[(v + k) % candidates.length];
      try {
        const c = await callEngine(e, capability, { context: minimizeContext(scp, e.manifest, capability), request: { text: a.text, role: a.role, instrument: a.instrument }, seed: seed + v, variants: 1 });
        const bad = checkContribution(c);
        if (bad) throw new Error(`invalid contribution: ${bad}`);
        made.push({ engine: e, contribution: c });
        break;
      } catch (err) {
        failures.push(`${e.manifest.engine.name}: ${(err as Error).message}`);
      }
    }
  }
  return { made, failures };
}

function ledgerEntry(m: Made, capability: string, a: CreateArgs, conform: string[], trackId: string, regionIds: string[], takeIds?: string[]): LedgerEntry {
  const c = m.contribution;
  return {
    id: uid('ctb'),
    at: Date.now(),
    source: m.engine.transport === 'builtin' ? 'builtin' : 'engine',
    engine: m.engine.id,
    engineName: m.engine.manifest.engine.name,
    engineVersion: c.provenance.engine_version ?? m.engine.manifest.engine.version,
    capability,
    ...(c.provenance.model_hash ? { modelHash: c.provenance.model_hash } : {}),
    ...(c.provenance.seed !== undefined ? { seed: c.provenance.seed } : {}),
    ...(c.provenance.prompt ? { prompt: c.provenance.prompt } : {}),
    ...(a.text ? { request: a.text } : {}),
    requestedBy: isAiCommand() ? 'ai' : 'user',
    ...(c.provenance.context_hash ? { contextHash: c.provenance.context_hash } : {}),
    conform,
    license: c.license,
    ...(c.cost_usd !== undefined ? { costUsd: c.cost_usd } : {}),
    trackId,
    regionIds,
    ...(takeIds?.length ? { takeIds } : {}),
  };
}

const toNotes = (ns: { pitch: number; start: number; duration: number; velocity?: number }[]): Note[] => ns.map((n) => ({ id: uid('n'), pitch: n.pitch, start: +n.start.toFixed(4), duration: +n.duration.toFixed(4), velocity: clamp(n.velocity ?? 0.8, 0.01, 1) }));

async function audioOf(uri: string): Promise<ArrayBuffer> {
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`Could not read the audio the engine made (HTTP ${res.status})`);
  return res.arrayBuffer();
}

export async function createPart(a: CreateArgs) {
  const p0 = st().project;
  const target = a.track_id ? p0.tracks.find((t) => t.id === a.track_id) : undefined;
  if (a.track_id && !target) throw new Error(`Track "${a.track_id}" not found`);
  const capability = inferCapability({ capability: a.capability, trackKind: target?.kind, text: `${a.text ?? ''} ${a.role ?? ''}` });
  if (!['symbolic.drums', 'symbolic.accompany', 'symbolic.continue', 'symbolic.harmonize', 'music.add_layer', 'music.repaint', 'music.extend', 'music.restyle'].includes(capability))
    throw new Error(`create can't place ${capability} contributions yet (coming with the next Ensemble steps)`);
  const scope = scopeFor(p0, a)!;
  const policy = useEnsemble.getState().policy;
  const r = route({ capability, engine: a.engine }, await allEngines(), policy);
  if (!r.candidates.length) throw new Error(`No engine can do ${capability} with your settings${r.excluded.length ? `: ${r.excluded.map((x) => `${x.name} — ${x.reason}`).join('; ')}` : ''}`);
  const scp = await buildContext(p0, { scope, intent: { text: a.text, role: a.role, instrument: a.instrument }, policy: { commercial_only: policy.commercial_only, local_only: policy.local_only }, melodyTrackId: a.melody_track_id });
  const variants = clamp(Math.round(Number(a.variants ?? 1)), 1, 4);
  const { made, failures } = await perform(capability, r.candidates, scp, a, variants);
  if (!made.length) throw new Error(`Every engine failed: ${failures.join('; ')}`);

  // Everything below is one undo step (inside the AI's transaction when the AI asked).
  const own = st().activeTransaction ? null : st().beginTransaction(`Create: ${a.text || capability}`, isAiCommand() ? 'ai' : 'ui');
  try {
    const s = scopeOf(scp);
    const out = made[0].contribution.kind === 'notes' ? placeNotes(made, capability, scp, a, target, s) : await placeAudio(made, capability, scp, a, target, s);
    return {
      capability,
      scope: { from_bar: s.fromBar, to_bar: s.toBar - 1 },
      ...out,
      engines: made.map((m) => m.engine.manifest.engine.name),
      ...(failures.length ? { failed: failures } : {}),
      ...(r.excluded.length ? { not_used: r.excluded.map((x) => `${x.name}: ${x.reason}`) } : {}),
      context_hash: scp.context_hash,
    };
  } finally {
    if (own) st().endTransaction(own);
  }
}

function placeNotes(made: Made[], capability: Capability, scp: Scp, a: CreateArgs, target: Track | undefined, s: ReturnType<typeof scopeOf>) {
  const drums = capability === 'symbolic.drums' || target?.kind === 'drums';
  const p = st().project;
  let track = target;
  if (!track) {
    if (drums) track = p.tracks.find((t) => t.kind === 'drums');
    if (!track) {
      const pick = drums ? { instrument: 'kit-studio', name: 'Drums' } : instrumentFor(`${a.instrument ?? ''} ${a.text ?? ''}`);
      track = makeTrack(p, drums ? 'drums' : 'instrument', pick.instrument, pick.name);
      const t = track;
      st().commit((d) => void d.tracks.push(t));
    }
  }
  if (track.kind === 'audio') throw new Error('Notes go on an instrument or drum track; this is an audio track');
  const start = (s.fromBar - 1) * BEATS_PER_BAR;
  const length = s.bars * BEATS_PER_BAR;
  const conformed = made.map((m) => ({ m, ...conformNotes(m.contribution, scp, { drums }) }));
  const name = (m: Made) => `${a.text ? a.text.slice(0, 28) : capability.split('.')[1]} · ${m.engine.manifest.engine.name}`;
  const existing = st().project.regions.find((r) => r.trackId === track!.id && Math.abs(r.start - start) < 1e-6 && Math.abs(r.length - length) < 1e-6 && !r.audio);
  const ledger: LedgerEntry[] = [];
  let regionId: string;
  const takeIds: string[] = [];
  if (existing || conformed.length > 1) {
    // Variants (or a part over an existing one) become takes of one region: compare, blind-test, comp.
    const takes: Take[] = conformed.map((c, i) => ({ id: uid('take'), name: `${i + 1} · ${c.m.engine.manifest.engine.name}`, notes: toNotes(c.notes), createdAt: Date.now(), author: 'ai' }));
    takeIds.push(...takes.map((t) => t.id));
    regionId = existing?.id ?? uid('rgn');
    st().commit((d) => {
      let r = d.regions.find((x) => x.id === regionId);
      if (!r) {
        r = { id: regionId, trackId: track!.id, name: name(conformed[0].m), start, length, notes: [] };
        d.regions.push(r);
      }
      const keep: Take[] = r.takes?.length ? r.takes : r.notes.length ? [{ id: uid('take'), name: 'Take 1', notes: r.notes.map((n) => ({ ...n })), createdAt: Date.now(), author: 'user' }] : [];
      r.takes = [...keep, ...takes];
      r.activeTakeId = takes[0].id;
      r.notes = takes[0].notes.map((n) => ({ ...n }));
    });
    conformed.forEach((c, i) => ledger.push(ledgerEntry(c.m, capability, a, c.conform, track!.id, [regionId], [takeIds[i]])));
  } else {
    const c = conformed[0];
    const e = ledgerEntry(c.m, capability, a, c.conform, track.id, []);
    const region: Region = { id: uid('rgn'), trackId: track.id, name: name(c.m), start, length, notes: toNotes(c.notes), contribution: e.id };
    e.regionIds = [region.id];
    regionId = region.id;
    ledger.push(e);
    st().commit((d) => void d.regions.push(region));
  }
  st().commit((d) => {
    d.ledger = [...(d.ledger ?? []), ...ledger];
    const r = d.regions.find((x) => x.id === regionId);
    if (r) r.contribution = ledger[0].id;
  });
  return { track_id: track.id, region_id: regionId, ...(takeIds.length ? { take_ids: takeIds } : {}), notes: conformed[0].notes.length, corrections: conformed.map((c) => c.conform) };
}

async function placeAudio(made: Made[], capability: Capability, scp: Scp, a: CreateArgs, target: Track | undefined, s: ReturnType<typeof scopeOf>) {
  const results: { track_id: string; region_ids: string[]; plan: AudioPlan }[] = [];
  const ledger: LedgerEntry[] = [];
  for (const [i, m] of made.entries()) {
    const file = m.contribution.files![0];
    const label = `${(a.text ?? '').slice(0, 28) || a.role || file.role} · ${m.engine.manifest.engine.name}`;
    const info = await importSample(await audioOf(file.uri), `${m.engine.id}-${capability}-${Date.now().toString(36)}.${file.format}`);
    const buf = getBuffer(info.id);
    if (!buf) throw new Error('The audio could not be decoded');
    const mono = buf.getChannelData(0);
    const plan = planAudio(m.contribution, scp, { mono, sampleRate: buf.sampleRate, name: info.name });
    let track = i === 0 && target?.kind === 'audio' ? target : undefined;
    if (!track) {
      track = makeTrack(st().project, 'audio', undefined, i === 0 ? label : `${label} (variant ${i + 1})`);
      if (i > 0) track.mute = true;
      const t = track;
      st().commit((d) => void d.tracks.push(t));
    }
    const e = ledgerEntry(m, capability, a, plan.conform, track.id, []);
    const regions: Region[] = [];
    for (let k = 0; k < plan.repeats; k++) {
      const bars = k === plan.repeats - 1 ? plan.lastBars : plan.bars;
      regions.push({
        id: uid('rgn'),
        trackId: track.id,
        name: label,
        start: (s.fromBar - 1 + k * plan.bars) * BEATS_PER_BAR,
        length: +(bars * BEATS_PER_BAR).toFixed(4),
        notes: [],
        audio: { sampleId: info.id, offset: 0, gain: 1, stretch: plan.stretch ? { mode: 'follow_tempo', originalBpm: plan.sourceBpm } : { mode: 'off', originalBpm: plan.sourceBpm }, ...(plan.pitch ? { pitch: plan.pitch } : {}) },
        contribution: e.id,
      });
    }
    e.regionIds = regions.map((r) => r.id);
    ledger.push(e);
    st().commit((d) => void d.regions.push(...regions));
    results.push({ track_id: track.id, region_ids: e.regionIds, plan });
  }
  st().commit((d) => void (d.ledger = [...(d.ledger ?? []), ...ledger]));
  return { track_id: results[0].track_id, region_ids: results.flatMap((r) => r.region_ids), ...(results.length > 1 ? { variant_tracks: results.map((r) => r.track_id) } : {}), corrections: results.map((r) => r.plan.conform) };
}
