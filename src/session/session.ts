// Session mode (SPEC v0.6 G4): "Session on verse 1, five passes". The studio loops the section with a
// count-in, every pass becomes a take, flubs (voice, pedal, key) attach to the take being recorded; then
// each take is scored bar by bar (pitch against the guide melody, timing, clipping; for MIDI timing and
// notes out of the key), and the best bar of each is comped into a "Session comp" take, offered for an
// A/B against the best single take. "That's enough" stops it at any time.
import { create } from 'zustand';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { BEATS_PER_BAR, uid } from '../music';
import { recordFromMic, stopMicRecording } from '../recording';
import { emitStudioEvent } from '../events';
import { getBuffer, importSample, encodeMonoWav } from '../audio/samples';
import { scalePitchClasses } from '../analysis/key';
import { audioBarScores, chooseComp, compAudio, midiBarScores, takeScore, type BarScore, type GuideNote } from './score';
import type { Region, Take } from '../types';

export interface SessionArgs {
  section_id?: string;
  from_bar?: number;
  /** Last bar (inclusive). */
  to_bar?: number;
  passes?: number;
  track_id?: string;
}

export interface SessionTake {
  take_id: string;
  name: string;
  score: number;
  flubs: number;
  bars: BarScore[];
}

interface SessionState {
  active: boolean;
  regionId: string | null;
  passes: number;
  from: number;
  to: number;
  takes: SessionTake[];
  comp: { take_id: string; from_takes: string[] } | null;
  best: string | null;
  note: string;
}

export const useSession = create<SessionState>(() => ({ active: false, regionId: null, passes: 0, from: 0, to: 0, takes: [], comp: null, best: null, note: '' }));

const st = () => useStore.getState();
const run = (method: string, params: Record<string, unknown> = {}) => runCommand(method, params, 'ui');

/** The guide melody under the range, in seconds from its start: the lyrics' melody, or another pitched part. */
function guideFor(from: number, to: number, excludeTrack: string): GuideNote[] {
  const p = st().project;
  const spb = 60 / p.bpm;
  const melody = p.lyrics?.melodyTrackId ?? p.tracks.find((t) => t.kind === 'instrument' && t.id !== excludeTrack && (t.role === 'lead' || t.role === 'vocal'))?.id;
  if (!melody) return [];
  return p.regions
    .filter((r) => r.trackId === melody && !r.audio)
    .flatMap((r) => r.notes.map((n) => ({ start: r.start + n.start, end: r.start + n.start + n.duration, pitch: n.pitch })))
    .filter((n) => n.end > from && n.start < to)
    .map((n) => ({ start: (Math.max(n.start, from) - from) * spb, end: (Math.min(n.end, to) - from) * spb, pitch: n.pitch }));
}

/** The range and the takes of a region, scored; the comp built and made active. */
export async function scoreAndComp(regionId: string): Promise<Pick<SessionState, 'takes' | 'comp' | 'best'>> {
  const p = st().project;
  const r = p.regions.find((x) => x.id === regionId) as Region | undefined;
  if (!r?.takes?.length) throw new Error('No takes to score');
  const spb = 60 / p.bpm;
  const bars = Math.round(r.length / BEATS_PER_BAR);
  const takes = r.takes.filter((t) => !/^Session comp/.test(t.name));
  const flubs = (p.flubs ?? []).filter((f) => f.regionId === r.id);
  const marks = takes.map((t, i) =>
    Array.from({ length: bars }, (_, b) => {
      const mine = flubs.filter((f) => (f.takeId ? f.takeId === t.id : i === 0) && Math.floor((f.beat - r.start) / BEATS_PER_BAR) === b);
      return { flubs: mine.filter((f) => f.kind === 'flub').length, goods: mine.filter((f) => f.kind === 'good').length };
    }),
  );
  const guide = guideFor(r.start, r.start + r.length, r.trackId);
  const pcms: Float32Array[] = [];
  let sr = 44100;
  const scores = takes.map((t) => {
    if (t.audio) {
      const buf = getBuffer(t.audio.sampleId);
      if (!buf) return Array.from({ length: bars }, () => ({ score: 0, cents: null, timingMs: null, clipped: 0, silent: true }));
      sr = buf.sampleRate;
      const x = buf.getChannelData(0).subarray(Math.round(t.audio.offset * sr));
      pcms.push(x);
      return audioBarScores(x, sr, { bars, spb, guide });
    }
    return midiBarScores(t.notes, { bars, spb, scale: scalePitchClasses(p.key) });
  });
  const result: SessionTake[] = takes.map((t, i) => ({ take_id: t.id, name: t.name, score: takeScore(scores[i], marks[i]), flubs: marks[i].reduce((s, m) => s + m.flubs, 0), bars: scores[i] }));
  const best = [...result].sort((a, b) => b.score - a.score)[0];
  st().commit((d) => {
    const x = d.regions.find((y) => y.id === r.id);
    for (const t of x?.takes ?? []) {
      const s = result.find((q) => q.take_id === t.id);
      if (s) t.score = s.score;
    }
  }, { history: false });
  const pick = chooseComp(scores, marks);
  let comp: SessionState['comp'] = null;
  const used = [...new Set(pick)];
  if (used.length > 1 && r.audio && pcms.length === takes.length) {
    const barSamples = Math.round(BEATS_PER_BAR * spb * sr);
    const pcm = compAudio(pcms, pick, barSamples, Math.round(0.01 * sr));
    const info = await importSample(encodeMonoWav(pcm, sr), `${r.name} - session comp.wav`);
    const take: Take = { id: uid('take'), name: `Session comp (${pick.map((k) => k + 1).join('·')})`, notes: [], audio: { sampleId: info.id, offset: 0, gain: r.audio.gain }, createdAt: Date.now(), author: 'user' };
    st().commit((d) => {
      const x = d.regions.find((y) => y.id === r.id)!;
      x.takes = [...(x.takes ?? []), take];
      x.activeTakeId = take.id;
      x.audio = { ...take.audio! };
    });
    comp = { take_id: take.id, from_takes: pick.map((k) => takes[k].id) };
  } else if (used.length > 1 && !r.audio) {
    const segments = pick.map((k, b) => ({ from_beat: b * BEATS_PER_BAR, to_beat: (b + 1) * BEATS_PER_BAR, take_id: takes[k].id }));
    const c = (await run('comp_takes', { region_id: r.id, segments, name: 'Session comp' })) as { take_id?: string };
    if (c.take_id) comp = { take_id: c.take_id, from_takes: pick.map((k) => takes[k].id) };
  } else await run('set_active_take', { region_id: r.id, take_id: takes[used[0] ?? 0].id });
  return { takes: result, comp, best: best?.take_id ?? null };
}

/** Run a session: loop the range, record the passes, score, comp. Resolves when it is done or stopped. */
export async function startSession(a: SessionArgs) {
  const p = st().project;
  if (useSession.getState().active) throw new Error('A session is already running: say "basta così" / "that\'s enough" to stop it');
  let from: number;
  let to: number;
  if (a.section_id) {
    const s = (p.sections ?? []).find((x) => x.id === a.section_id);
    if (!s) throw new Error(`Section "${a.section_id}" not found`);
    from = s.start;
    to = s.start + s.length;
  } else if (a.from_bar !== undefined) {
    from = (a.from_bar - 1) * BEATS_PER_BAR;
    to = (a.to_bar ?? a.from_bar) * BEATS_PER_BAR;
  } else throw new Error('Say where: section_id, or from_bar and to_bar');
  const passes = Math.max(1, Math.min(16, Math.round(a.passes ?? 5)));
  useSession.setState({ active: true, regionId: null, passes, from, to, takes: [], comp: null, best: null, note: '' });
  try {
    await run('set_punch', { enabled: false });
    await run('set_loop', { enabled: true, start_bar: from / BEATS_PER_BAR + 1, end_bar: to / BEATS_PER_BAR + 1 });
    const r = await recordFromMic({ mode: 'audio', trackId: a.track_id, startBeat: from, passes });
    const regionId = r.region_id;
    useSession.setState({ regionId });
    const scored = await scoreAndComp(regionId);
    for (const t of scored.takes) emitStudioEvent({ kind: 'session_take', region_id: regionId, take_id: t.take_id, name: t.name, score: t.score, flubs: t.flubs });
    const note = scored.comp ? 'The comp (best bar of each take) is active; compare it with the best single take: start_ab_test' : 'One take was best everywhere: it is active';
    useSession.setState({ ...scored, note });
    emitStudioEvent({ kind: 'session_done', region_id: regionId, takes: scored.takes.length, comp_take_id: scored.comp?.take_id ?? null, best_take_id: scored.best });
    return { ...summary(), note };
  } finally {
    useSession.setState({ active: false });
  }
}

export function stopSession() {
  if (!useSession.getState().active) return { stopped: false };
  stopMicRecording();
  return { stopped: true, note: 'The passes recorded so far are kept, scored and comped' };
}

export function summary() {
  const s = useSession.getState();
  return {
    active: s.active,
    region_id: s.regionId,
    passes: s.passes,
    takes: s.takes.map((t) => ({ take_id: t.take_id, name: t.name, score: t.score, flubs: t.flubs, bars: t.bars.map((b) => b.score) })),
    comp_take_id: s.comp?.take_id ?? null,
    comp_from: s.comp?.from_takes ?? null,
    best_take_id: s.best,
  };
}
