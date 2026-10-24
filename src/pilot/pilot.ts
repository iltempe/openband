// The Mix & Master Pilot (G1): measure the song, plan (plan.ts), find the loudness target, apply it as
// one undo step with an explanation per decision. The knob ("How much") stays live afterwards: it
// blends from the song before the run to the full proposal until "Fix".
import type { MixRole, PilotDecision, PilotState, Project, Track, TrackMix } from '../types';
import { MIX_ROLES } from '../types';
import { useStore } from '../store';
import { renderBuffer, renderStems } from '../audio/render';
import { analyzeInWorker, channelsOf } from '../analysis/client';
import { PLATFORM_TARGETS, type Platform } from '../audio/master';
import { fitLimiter, measureWith } from '../audio/fitLimiter';
import { engine } from '../audio/engine';
import { t as tr, useLang, type MessageKey } from '../i18n';
import type { BandId } from '../analysis/spectrum';
import { blendMaster, blendTrack, mixOf, planMaster, planTracks, PROFILES, spectralTilt, type Fmt, type MaskPair, type TrackMeasure } from './plan';
import { autoRole, noteFacts, type RoleFacts } from './roles';

const st = () => useStore.getState();
const fmt: Fmt = (key, vars) => tr(key as MessageKey, vars);
const PILOT_NOTE = 'ann_pilot_';

export interface PilotArgs {
  amount?: number;
  genre?: string;
  platform?: string;
  use_reference?: boolean;
  scope?: 'mix' | 'master' | 'both';
}

function setMix(t: Track, m: TrackMix) {
  t.volume = m.volume;
  t.pan = m.pan;
  t.reverb = m.reverb;
  t.delay = m.delay;
  if (m.fx) t.fx = structuredClone(m.fx);
  else delete t.fx;
}

/** The song as it was before the pilot's last run (the knob at 0). */
export function beforeOf(p: Project): Project {
  if (!p.pilot) return p;
  const q = structuredClone(p);
  for (const t of q.tracks) {
    const m = p.pilot.before.tracks[t.id];
    if (m) setMix(t, m);
  }
  if (p.pilot.full.master) {
    if (p.pilot.before.master) q.master = structuredClone(p.pilot.before.master);
    else delete q.master;
  }
  delete q.pilot;
  return q;
}

/** Set a project (a draft) to the blend at `a`. */
export function applyAmount(d: Project, s: PilotState, a: number) {
  for (const t of d.tracks) {
    const b = s.before.tracks[t.id];
    const f = s.full.tracks[t.id];
    if (b && f) setMix(t, blendTrack(b, f, a));
  }
  if (s.full.master) {
    const m = blendMaster(s.before.master, s.full.master, a);
    if (m) d.master = m;
    else delete d.master;
  }
}

const audibleIds = (p: Project) => {
  const anySolo = p.tracks.some((t) => t.solo);
  return p.tracks.filter((t) => !t.mute && (!anySolo || t.solo)).map((t) => t.id);
};

async function measure(p: Project) {
  const ids = audibleIds(p);
  if (!ids.length) throw new Error('Nothing to mix: the song has no audible tracks');
  const stems = await renderStems(p, { tracks: ids, includeMaster: false, tailSeconds: 1 });
  const chans = ids.map((id) => channelsOf(stems[id]));
  const len = Math.max(...chans.map((c) => c[0].length));
  const mix = [new Float32Array(len), new Float32Array(len)];
  for (const c of chans) for (let k = 0; k < 2; k++) c[Math.min(k, c.length - 1)].forEach((x, i) => (mix[k][i] += x));
  const res = (await analyzeInWorker({ mix, stems: ids.map((id, i) => ({ id, name: id, channels: chans[i] })), sampleRate: 44100, bpm: p.bpm, projectKey: p.key, maskingTop: 40 })) as {
    tracks: { id: string; lufs_short_max: number; dominant_band: BandId }[];
    masking: MaskPair[];
  };
  const measures: Record<string, TrackMeasure> = {};
  for (const t of res.tracks) measures[t.id] = { lufs: t.lufs_short_max <= -900 ? -Infinity : t.lufs_short_max, dominant: t.dominant_band };
  return { measures, masking: res.masking };
}

async function measureMix(p: Project) {
  const buf = await renderBuffer({ ...p, master: undefined }, { tailSeconds: 1 });
  const res = (await analyzeInWorker({ mix: channelsOf(buf), sampleRate: buf.sampleRate, bpm: p.bpm, projectKey: p.key })) as { master: { bands_db: Record<BandId, number>; sample_peak_db: number; correlation: number } };
  return { bandsDb: res.master.bands_db, peakDb: res.master.sample_peak_db };
}

/** Find the limiter gain for the blend at `amount` and keep it in the state; returns the loudness. */
async function retarget(s: PilotState, base: Project, amount: number) {
  if (!s.full.master) return null;
  const q = structuredClone(base);
  applyAmount(q, s, amount);
  if (!q.master?.on || !q.master.limiter.on) return null;
  const f = await fitLimiter(q, q.master);
  s.full.master.limiter.inputGainDb = f.inputGainDb;
  return f;
}

export async function runPilot(args: PilotArgs) {
  const p0 = st().project;
  const base = beforeOf(p0);
  const amount = Math.min(1, Math.max(0, Number(args.amount ?? p0.pilot?.amount ?? 0.7)));
  const genre = String(args.genre ?? p0.pilot?.genre ?? 'pop').toLowerCase().replace(/[^a-z]/g, '');
  const profile = PROFILES[genre];
  if (!profile) throw new Error(`Unknown genre "${args.genre}". Genres: ${Object.keys(PROFILES).join(', ')}`);
  const platform = String(args.platform ?? p0.pilot?.platform ?? profile.platform) as Platform;
  if (!PLATFORM_TARGETS[platform]) throw new Error(`Unknown platform "${args.platform}". Platforms: ${Object.keys(PLATFORM_TARGETS).join(', ')}`);
  const scope = args.scope ?? 'both';
  let refTilt: number | undefined;
  if (args.use_reference) {
    const bands = base.reference?.analysis?.bands_db as Record<BandId, number> | undefined;
    if (!bands) throw new Error('No reference loaded: call import_reference first, or run without use_reference');
    refTilt = spectralTilt(bands);
  }

  // 1–7: the tracks.
  const { measures, masking } = await measure(base);
  const facts: Record<string, RoleFacts> = Object.fromEntries(base.tracks.map((t) => [t.id, noteFacts(base, t.id)]));
  const plan = planTracks({ project: base, profile, measures, masking, facts, fmt });
  const decisions: PilotDecision[] = [];
  const touched = scope === 'master' ? [] : Object.keys(plan.tracks);
  const state: PilotState = {
    amount,
    genre,
    platform,
    before: { tracks: Object.fromEntries(touched.map((id) => [id, mixOf(base.tracks.find((t) => t.id === id)!)])), master: base.master ? structuredClone(base.master) : null },
    full: { tracks: Object.fromEntries(touched.map((id) => [id, plan.tracks[id]])), master: null },
    decisions,
    lufsBefore: -Infinity,
    lufsAfter: -Infinity,
  };
  if (scope !== 'master') decisions.push(...plan.decisions);

  // 8: the master, measured on the mix as the pilot leaves it.
  if (scope !== 'mix') {
    const mixed = structuredClone(base);
    applyAmount(mixed, state, 1);
    const mp = planMaster(base.master, await measureMix(mixed), profile, platform, fmt, refTilt);
    state.full.master = mp.master;
    decisions.push(...mp.decisions);
  }

  // 9–10: the loudness target at this amount, then a check of the result (true peak, phase).
  state.lufsBefore = (await measureWith(base, base.master ?? null)).lufs;
  let fit = await retarget(state, base, amount);
  for (let pass = 0; pass < 2 && fit && state.full.master; pass++) {
    const m = state.full.master;
    const over = fit.truePeak - m.limiter.ceilingDbtp;
    if (over > 0.2) {
      m.limiter.inputGainDb = +((m.limiter.inputGainDb ?? 0) - over).toFixed(2);
      decisions.push({ kind: 'master', text: fmt('pi.d.fixPeak', { over: over.toFixed(1) }) });
      const q = structuredClone(base);
      applyAmount(q, state, amount);
      const x = await measureWith(q, q.master ?? null);
      fit = { ...fit, lufs: x.lufs, truePeak: x.tp };
      continue;
    }
    break;
  }
  state.lufsAfter = fit ? fit.lufs : (await measureWith(applied(base, state, amount), applied(base, state, amount).master ?? null)).lufs;

  const label = tr('pi.label', { genre: profile.name[useLangCode()], platform: tr(`mc.p.${platform}` as MessageKey), pct: Math.round(amount * 100) });
  st().commit(
    (d) => {
      applyAmount(d, state, amount);
      d.pilot = state;
      // One note per track for the decisions that aren't obvious, replacing the last run's (none at 0).
      if (amount === 0) return;
      const notes = (d.annotations ?? []).filter((a) => !a.id.startsWith(PILOT_NOTE));
      const byTrack = new Map<string, string[]>();
      for (const x of decisions) if (x.kind === 'eq' || x.kind === 'sidechain' || (x.kind === 'master' && x.text)) byTrack.set(x.trackId ?? '', [...(byTrack.get(x.trackId ?? '') ?? []), x.text]);
      for (const [id, texts] of byTrack) {
        const text = texts.join(' ').slice(0, 500);
        notes.push({ id: `${PILOT_NOTE}${id || 'master'}`, target: id ? { type: 'track', id } : { type: 'project' }, text, author: { kind: 'ai', name: 'Mix Pilot' }, createdAt: Date.now() });
      }
      d.annotations = notes;
    },
    { label },
  );
  const roles = plan.roles;
  return {
    applied: label,
    genre,
    platform,
    amount,
    scope,
    roles: base.tracks.filter((t) => roles[t.id]).map((t) => ({ track_id: t.id, name: t.name, role: roles[t.id], ...(t.role ? { set_by_user: true } : {}) })),
    changes: decisions.map((x) => ({ ...(x.trackId ? { track_id: x.trackId } : {}), kind: x.kind, text: x.text })),
    loudness: { before_lufs: round1(state.lufsBefore), after_lufs: round1(state.lufsAfter), ...(fit ? { true_peak_dbtp: round1(fit.truePeak), target_lufs: PLATFORM_TARGETS[platform].lufs, reached: fit.reached } : {}) },
    next: 'set_pilot_amount turns the dose up or down (0 = the song as it was); fix_pilot keeps the result and ends the live knob.',
  };
}

const applied = (base: Project, s: PilotState, a: number) => {
  const q = structuredClone(base);
  applyAmount(q, s, a);
  return q;
};
const round1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const useLangCode = (): 'en' | 'it' => (useLang.getState().lang === 'it' ? 'it' : 'en');

/** Turn the dose: live (no render) while dragging; `settle` also re-finds the loudness target. */
export async function setPilotAmount(amount: number, o: { settle?: boolean; history?: boolean } = {}) {
  const p = st().project;
  if (!p.pilot) throw new Error('The mix pilot has not run on this song (or its result was fixed): call mix_pilot first');
  const a = Math.min(1, Math.max(0, amount));
  st().commit(
    (d) => {
      applyAmount(d, d.pilot!, a);
      d.pilot!.amount = a;
    },
    { history: o.history ?? true, label: tr('pi.amountLabel', { pct: Math.round(a * 100) }) },
  );
  if (o.settle === false) return { amount: a };
  const s = structuredClone(st().project.pilot!);
  const fit = await retarget(s, beforeOf(st().project), a);
  if (fit) {
    st().commit(
      (d) => {
        if (!d.pilot) return;
        d.pilot.full.master = s.full.master;
        d.pilot.lufsAfter = fit.lufs;
        applyAmount(d, d.pilot, d.pilot.amount);
      },
      { history: false },
    );
  }
  return { amount: a, ...(fit ? { loudness: { after_lufs: round1(fit.lufs), true_peak_dbtp: round1(fit.truePeak), reached: fit.reached } } : {}) };
}

/** Keep the result: the knob stops being live. */
export function fixPilot() {
  if (!st().project.pilot) throw new Error('Nothing to fix: the mix pilot has no live result');
  st().commit((d) => void delete d.pilot, { label: tr('pi.fixLabel') });
  return { fixed: true };
}

/** Hear the song before the pilot at the same loudness as after it (monitoring only). */
export function listenBefore(on: boolean) {
  const p = st().project;
  if (!p.pilot) return;
  const s = p.pilot;
  const before = beforeOf(p);
  // Shown, not committed: the engine plays a project; the store keeps the pilot's result.
  engine.previewProject(on ? before : null);
  const diff = s.lufsAfter - s.lufsBefore;
  engine.setMonitoring({ trimDb: on && Number.isFinite(diff) ? Math.max(-24, Math.min(24, diff)) : 0 });
}

export function setTrackRole(trackId: string, role: MixRole | null) {
  const t = st().project.tracks.find((x) => x.id === trackId || x.name.toLowerCase() === trackId.toLowerCase());
  if (!t) throw new Error(`Track "${trackId}" not found`);
  if (role !== null && !MIX_ROLES.includes(role)) throw new Error(`Unknown role "${role}". Roles: ${MIX_ROLES.join(', ')}`);
  st().commit(
    (d) => {
      const x = d.tracks.find((y) => y.id === t.id)!;
      if (role) x.role = role;
      else delete x.role;
    },
    { label: tr('pi.roleLabel') },
  );
  return { track_id: t.id, role: role ?? autoRole(t, noteFacts(st().project, t.id)), set_by_user: !!role };
}
