// The mix pilot's proposal (G1), pure: from measurements of the song as it is now ("before") to a full
// mix ("full"), and the knob that blends between the two. Steps 2–8 of the spec: gain staging, static
// balance by role and genre, room in frequency (cuts where tracks mask each other, high-pass), kick →
// bass sidechain, pan by role and register, reverb and echo sends, the master chain. The renders and
// the loudness target are done by the caller (pilot.ts).
import type { MasterChain, MixRole, PilotDecision, Project, Track, TrackFx, TrackMix } from '../types';
import { faderToDb } from '../music';
import { defaultFx } from '../fxDefaults';
import { defaultMaster, PLATFORM_TARGETS, type Platform } from '../audio/master';
import { BANDS, type BandId } from '../analysis/spectrum';
import { priority, roleOf, type RoleFacts } from './roles';
import pop from './profiles/pop.json';
import rock from './profiles/rock.json';
import hiphop from './profiles/hiphop.json';
import lofi from './profiles/lofi.json';
import edm from './profiles/edm.json';
import acoustic from './profiles/acoustic.json';
import ambient from './profiles/ambient.json';
import jazz from './profiles/jazz.json';

export interface Profile {
  id: string;
  name: { en: string; it: string };
  /** Loudness of each role relative to the loudest one (dB). */
  balance: Record<MixRole, number>;
  /** How far harmony and texture tracks go from the centre (0..1). */
  panWidth: number;
  reverb: Record<MixRole, number>;
  delay: Record<MixRole, number>;
  /** Kick → bass sidechain when they mask each other. */
  sidechain: boolean;
  /** Target spectral slope of the mix, dB per octave (see spectralTilt). */
  tilt: number;
  /** Master stereo width (1 = unchanged). */
  width: number;
  platform: Platform;
}

export const PROFILES: Record<string, Profile> = Object.fromEntries(([pop, rock, hiphop, lofi, edm, acoustic, ambient, jazz] as Profile[]).map((p) => [p.id, p]));
export const GENRES = Object.keys(PROFILES);

/** Pre-fader working level every track is trimmed to (LUFS, short-term max). */
export const WORKING_LEVEL = -18;

export interface TrackMeasure {
  /** Short-term max loudness of the track as rendered (its fader and trim included). */
  lufs: number;
  dominant?: BandId;
}

export interface MaskPair {
  /** Track ids. */
  a: string;
  b: string;
  band: BandId;
  score: number;
}

/** Decision texts: `key` and values, formatted by the caller (i18n). */
export type Fmt = (key: string, vars: Record<string, string | number>) => string;

export interface PlanInput {
  project: Project;
  profile: Profile;
  measures: Record<string, TrackMeasure>;
  masking: MaskPair[];
  facts: Record<string, RoleFacts>;
  fmt: Fmt;
}

export interface TrackPlan {
  roles: Record<string, MixRole>;
  tracks: Record<string, TrackMix>;
  decisions: PilotDecision[];
}

export const mixOf = (t: Track): TrackMix => ({ volume: t.volume, pan: t.pan, reverb: t.reverb, delay: t.delay, ...(t.fx ? { fx: structuredClone(t.fx) } : {}) });

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dbToFader = (db: number) => clamp(0.8 * Math.pow(10, db / 20), 0, 1);
const midiHz = (p: number) => 440 * Math.pow(2, (p - 69) / 12);
const bandHz = (b: BandId) => {
  if (b === 'sub') return 45;
  if (b === 'air') return 8000;
  const x = BANDS.find((y) => y.id === b)!;
  return Math.round(Math.sqrt(x.lo * x.hi));
};

/** Tracks the pilot works on: audible ones with something to measure. */
export function pilotTracks(p: Project, measures: Record<string, TrackMeasure>) {
  const anySolo = p.tracks.some((t) => t.solo);
  return p.tracks.filter((t) => !t.mute && (!anySolo || t.solo) && Number.isFinite(measures[t.id]?.lufs) && measures[t.id].lufs > -70);
}

export function planTracks({ project: p, profile, measures, masking, facts, fmt }: PlanInput): TrackPlan {
  const tracks = pilotTracks(p, measures);
  const roles: Record<string, MixRole> = {};
  for (const t of tracks) roles[t.id] = roleOf(t, { ...facts[t.id], dominant: measures[t.id].dominant });
  const decisions: PilotDecision[] = [];
  const out: Record<string, TrackMix> = {};
  const name = (id: string) => p.tracks.find((t) => t.id === id)?.name ?? id;

  // 2–3. Gain staging with the trim, balance with the fader.
  const count: Partial<Record<MixRole, number>> = {};
  for (const t of tracks) count[roles[t.id]] = (count[roles[t.id]] ?? 0) + 1;
  const top = Math.max(...(Object.keys(count) as MixRole[]).map((r) => profile.balance[r]));
  for (const t of tracks) {
    const role = roles[t.id];
    const fx: TrackFx = structuredClone(t.fx ?? defaultFx());
    const fader = faderToDb(t.volume);
    const preFader = measures[t.id].lufs - (Number.isFinite(fader) ? fader : 0);
    fx.trim = r1(clamp((t.fx?.trim ?? 0) + WORKING_LEVEL - preFader, -24, 24));
    const db = profile.balance[role] - top - 10 * Math.log10(count[role]!);
    const volume = r2(dbToFader(db));
    out[t.id] = { volume, pan: t.pan, reverb: t.reverb, delay: t.delay, fx };
    if (t.role === undefined) decisions.push({ trackId: t.id, kind: 'role', text: fmt('pi.d.role', { track: t.name, role: fmt(`pi.role.${role}`, {}) }) });
    decisions.push({ trackId: t.id, kind: 'balance', text: fmt('pi.d.balance', { track: t.name, trim: signed(fx.trim - (t.fx?.trim ?? 0)), fader: signed(r1(db)) }) });
  }

  // 4. Room in frequency: the lower-priority track of each masking pair gives way (one cut each).
  const sidechainPairs = new Set<string>();
  const cut = new Set<string>();
  for (const m of [...masking].sort((x, y) => y.score - x.score)) {
    if (m.score < 0.3 || !out[m.a] || !out[m.b]) continue;
    const ra = roles[m.a];
    const rb = roles[m.b];
    const low = m.band === 'sub' || m.band === 'bass';
    const kickBass = low && ((isKick(ra) && rb === 'bass') || (isKick(rb) && ra === 'bass'));
    if (kickBass && profile.sidechain) {
      sidechainPairs.add(isKick(ra) ? `${m.a}>${m.b}` : `${m.b}>${m.a}`);
      if (m.score >= 0.5) continue;
    }
    const [winner, loser] = priority(ra, m.band) >= priority(rb, m.band) ? [m.a, m.b] : [m.b, m.a];
    if (cut.has(loser)) continue;
    cut.add(loser);
    const gain = -Math.round((1 + 3 * clamp((m.score - 0.3) / 0.5, 0, 1)) * 2) / 2;
    const hz = bandHz(m.band);
    const fx = out[loser].fx!;
    fx.eq.bands = [...(fx.eq.bands ?? []), { hz, gain, q: 1.2 }];
    decisions.push({ trackId: loser, kind: 'eq', text: fmt('pi.d.eq', { track: name(loser), gain: String(-gain), hz: hzLabel(hz), other: name(winner) }) });
  }

  // High-pass on everything but kick, drums and bass: an octave under the lowest note played.
  for (const t of tracks) {
    const role = roles[t.id];
    if (role === 'kick' || role === 'drums' || role === 'bass') continue;
    const lowest = facts[t.id]?.lowestPitch;
    const hz = Math.round(clamp(lowest !== undefined ? midiHz(lowest) / 2 : role === 'vocal' ? 90 : 60, 30, 250));
    const fx = out[t.id].fx!;
    if (fx.eq.hpf?.on && fx.eq.hpf.hz >= hz) continue;
    fx.eq.hpf = { on: true, hz };
    decisions.push({ trackId: t.id, kind: 'hpf', text: fmt('pi.d.hpf', { track: t.name, hz: hzLabel(hz) }) });
  }

  // 5. Kick → bass sidechain where they mask each other hard.
  for (const pair of sidechainPairs) {
    const [src, dst] = pair.split('>');
    const score = Math.max(...masking.filter((m) => (m.a === src && m.b === dst) || (m.a === dst && m.b === src)).filter((m) => m.band === 'sub' || m.band === 'bass').map((m) => m.score));
    if (score < 0.5) continue;
    const fx = out[dst].fx!;
    if (fx.comp.sidechain) continue;
    fx.comp = fx.comp.on ? { ...fx.comp, sidechain: { sourceTrackId: src, amount: 0.7 } } : { on: true, threshold: -24, ratio: 4, attack: 0.003, release: 0.12, makeup: 0, sidechain: { sourceTrackId: src, amount: 0.7 } };
    decisions.push({ trackId: dst, kind: 'sidechain', text: fmt('pi.d.sidechain', { track: name(dst), source: name(src), score: Math.round(score * 100) }) });
  }

  // 6. Pan: the low end, the lead and the voice in the middle; harmony and texture in mirrored pairs.
  const spread = tracks.filter((t) => roles[t.id] === 'harmony' || roles[t.id] === 'texture').sort((a, b) => (facts[a.id]?.meanPitch ?? 60) - (facts[b.id]?.meanPitch ?? 60) || a.id.localeCompare(b.id));
  for (const t of tracks) if (!spread.includes(t)) out[t.id].pan = 0;
  spread.forEach((t, i) => {
    const pairs = Math.floor(spread.length / 2);
    const k = Math.floor(i / 2);
    const lone = i === spread.length - 1 && spread.length % 2 === 1;
    const w = profile.panWidth * (pairs > 1 ? 1 - (0.4 * k) / (pairs - 1) : 1);
    out[t.id].pan = lone ? 0 : r2(i % 2 === 0 ? -w : w);
  });
  for (const t of tracks) if (out[t.id].pan !== t.pan) decisions.push({ trackId: t.id, kind: 'pan', text: fmt('pi.d.pan', { track: t.name, pan: panLabel(out[t.id].pan) }) });

  // 7. Space: reverb and echo by role and genre.
  for (const t of tracks) {
    out[t.id].reverb = profile.reverb[roles[t.id]];
    out[t.id].delay = profile.delay[roles[t.id]];
  }
  const wet = tracks.filter((t) => out[t.id].reverb >= 0.2).map((t) => t.name);
  if (wet.length) decisions.push({ kind: 'space', text: fmt('pi.d.space', { tracks: wet.join(', '), genre: profile.id }) });
  return { roles, tracks: out, decisions };
}

const isKick = (r: MixRole) => r === 'kick' || r === 'drums';
const signed = (x: number) => `${x > 0 ? '+' : ''}${r1(x)}`;
const hzLabel = (hz: number) => (hz >= 1000 ? `${r1(hz / 1000)} kHz` : `${Math.round(hz)} Hz`);
const panLabel = (p: number) => (Math.abs(p) < 0.01 ? 'C' : `${p < 0 ? 'L' : 'R'}${Math.round(Math.abs(p) * 100)}`);

/**
 * Slope of a spectrum in dB per octave: band powers per octave of bandwidth, fitted against the
 * octave of each band's centre (bass to air; sub excluded, it's mostly the kick and the bass).
 */
export function spectralTilt(bandsDb: Partial<Record<BandId, number>>): number {
  const pts = BANDS.filter((b) => b.id !== 'sub' && Number.isFinite(bandsDb[b.id]) && bandsDb[b.id]! > -120).map((b) => ({ x: Math.log2(Math.sqrt(b.lo * b.hi) / 1000), y: bandsDb[b.id]! - 10 * Math.log10(Math.log2(b.hi / b.lo)) }));
  if (pts.length < 3) return 0;
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const num = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
  const den = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  return den ? num / den : 0;
}

export interface MixMeasure {
  bandsDb: Partial<Record<BandId, number>>;
  /** Sample peak of the mix before the master chain (dBFS). */
  peakDb: number;
}

/** 8. The master chain: tilt towards the genre (or the reference), light glue, width with mono lows,
 *  limiter at the platform's target. The limiter's input gain is found by the caller (renders). */
export function planMaster(before: MasterChain | undefined, mix: MixMeasure, profile: Profile, platform: Platform, fmt: Fmt, refTilt?: number): { master: MasterChain; decisions: PilotDecision[] } {
  const base = before ?? defaultMaster();
  const target = PLATFORM_TARGETS[platform];
  const measured = spectralTilt(mix.bandsDb);
  const wanted = refTilt ?? profile.tilt;
  const tilt = r1(clamp(wanted - measured, -1.5, 1.5));
  const threshold = Math.round(clamp(mix.peakDb - 6, -30, -3));
  const master: MasterChain = {
    on: true,
    eq: { ...base.eq, on: true, tilt },
    glue: { on: true, threshold, ratio: 2, attack: 0.03, release: 0.25, makeup: 1 },
    width: { on: true, amount: profile.width, monoBelowHz: 120 },
    limiter: { ...base.limiter, on: true, ceilingDbtp: target.ceiling, targetLufs: target.lufs },
  };
  const decisions: PilotDecision[] = [];
  if (Math.abs(tilt) >= 0.1) decisions.push({ kind: 'master', text: fmt(refTilt !== undefined ? 'pi.d.tiltRef' : 'pi.d.tilt', { tilt: signed(tilt), measured: r1(measured), wanted: r1(wanted) }) });
  decisions.push({ kind: 'master', text: fmt('pi.d.glue', { threshold }) });
  decisions.push({ kind: 'master', text: fmt('pi.d.width', { width: Math.round(profile.width * 100) }) });
  decisions.push({ kind: 'master', text: fmt('pi.d.limiter', { platform, lufs: target.lufs, ceiling: target.ceiling }) });
  return { master, decisions };
}

// ---- the knob: blend from before to full

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const logLerp = (a: number, b: number, t: number) => Math.exp(lerp(Math.log(Math.max(1e-3, a)), Math.log(Math.max(1e-3, b)), t));

export function blendTrack(before: TrackMix, full: TrackMix, a: number): TrackMix {
  if (a <= 0) return structuredClone(before);
  if (a >= 1) return structuredClone(full);
  const bdb = faderToDb(before.volume);
  const fdb = faderToDb(full.volume);
  const volume = Number.isFinite(bdb) && Number.isFinite(fdb) ? r2(dbToFader(lerp(bdb, fdb, a))) : r2(lerp(before.volume, full.volume, a));
  const out: TrackMix = { volume, pan: r2(lerp(before.pan, full.pan, a)), reverb: r2(lerp(before.reverb, full.reverb, a)), delay: r2(lerp(before.delay, full.delay, a)) };
  if (!full.fx) return before.fx ? { ...out, fx: structuredClone(before.fx) } : out;
  const b = structuredClone(before.fx ?? defaultFx());
  const f = full.fx;
  const fx: TrackFx = { ...b, eq: { ...b.eq }, comp: { ...b.comp } };
  const trim = r1(lerp(b.trim ?? 0, f.trim ?? 0, a));
  if (trim) fx.trim = trim;
  else delete fx.trim;
  if (f.eq.hpf?.on) {
    const from = b.eq.hpf?.on ? b.eq.hpf.hz : 20;
    fx.eq.hpf = { on: true, hz: Math.round(logLerp(from, f.eq.hpf.hz, a)) };
  }
  if (f.eq.bands?.length) fx.eq.bands = f.eq.bands.map((x, i) => ({ ...x, gain: r1(lerp(b.eq.bands?.[i]?.gain ?? 0, x.gain, a)) }));
  if (f.comp.sidechain && !b.comp.sidechain) fx.comp = { ...f.comp, sidechain: { ...f.comp.sidechain, amount: r2(f.comp.sidechain.amount * a) } };
  return { ...out, fx };
}

export function blendMaster(before: MasterChain | null, full: MasterChain, a: number): MasterChain | null {
  if (a <= 0) return before ? structuredClone(before) : null;
  if (a >= 1) return structuredClone(full);
  const b = before ?? defaultMaster();
  const bOn = (k: 'eq' | 'glue' | 'width') => b.on && b[k].on;
  return {
    on: true,
    eq: { ...full.eq, tilt: r1(lerp(bOn('eq') ? b.eq.tilt : 0, full.eq.tilt, a)) },
    glue: {
      ...full.glue,
      threshold: r1(lerp(bOn('glue') ? b.glue.threshold : 0, full.glue.threshold, a)),
      ratio: r2(lerp(bOn('glue') ? b.glue.ratio : 1, full.glue.ratio, a)),
      makeup: r1(lerp(bOn('glue') ? b.glue.makeup : 0, full.glue.makeup, a)),
    },
    width: { ...full.width, amount: r2(lerp(bOn('width') ? b.width.amount : 1, full.width.amount, a)) },
    // The loudness target is a specification, not a taste: the limiter always applies it.
    limiter: structuredClone(full.limiter),
  };
}
