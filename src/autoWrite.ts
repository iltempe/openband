// Writing automation by moving controls during playback (F22). With the write mode on (touch or latch),
// any knob or fader of the mix or of the built-in effects that the user moves while the song plays is
// recorded into its lane at the playhead:
//   touch — while you hold the control; on release the curve glides back to what it was;
//   latch — the last value is held until playback stops.
// It watches the project for UI changes (not AI commands), so every existing control works unchanged.
import { create } from 'zustand';
import type { AutoTarget, Project, Track, TrackFx } from './types';
import { useStore, isAiCommand } from './store';
import { engine } from './audio/engine';
import { AUTO_PARAMS, FX_PARAMS, mix, pointsOf, setPoints, targetKey, touchRelease, writeSpan, type WriteMode } from './automation';
import { normalizeFx } from './audio/fx';
import { nativeHooks } from './audio/native';

export const useAutoWrite = create<{ mode: WriteMode }>(() => ({ mode: 'off' }));
export const setWriteMode = (mode: WriteMode) => useAutoWrite.setState({ mode });

interface Touch {
  trackId: string;
  target: AutoTarget;
  /** The curve before this gesture (touch restores it on release). */
  before: ReturnType<typeof pointsOf>;
  last: number;
  value: number;
  base: number;
}
const touches = new Map<string, Touch>();
let latched: Touch[] = [];
let writing = false;

/** Values of a track the user can move: the mix (fader, pan, tone, sends) and the built-in effects. */
function controls(t: Track): [AutoTarget, number][] {
  const fx = normalizeFx(t.fx as TrackFx | undefined);
  return [
    ...AUTO_PARAMS.map((p) => [mix(p.id), p.base(t)] as [AutoTarget, number]),
    ...FX_PARAMS.map((p) => [{ kind: 'fx', unit: p.unit, param: p.param } as AutoTarget, (fx[p.unit] as unknown as Record<string, number>)[p.param]] as [AutoTarget, number]),
  ];
}

function write(d: Project, x: Touch, value: number, at: number) {
  const tr = d.tracks.find((t) => t.id === x.trackId);
  if (!tr) return;
  setPoints(tr, x.target, writeSpan(pointsOf(tr, x.target) ?? [], x.last, at, value));
  x.last = at;
  x.value = value;
}

function onChange(s: { project: Project; isPlaying: boolean }, prev: { project: Project }) {
  if (writing || s.project === prev.project) return;
  const mode = useAutoWrite.getState().mode;
  if (mode === 'off' || !s.isPlaying || isAiCommand()) return;
  const at = engine.position;
  const changes: { touch: Touch; value: number }[] = [];
  for (const t of s.project.tracks) {
    const before = prev.project.tracks.find((x) => x.id === t.id);
    if (!before) continue;
    const old = new Map(controls(before).map(([tg, v]) => [targetKey(tg), v]));
    for (const [tg, v] of controls(t)) {
      const key = `${t.id}|${targetKey(tg)}`;
      if (old.get(targetKey(tg)) === v) continue;
      let x = touches.get(key);
      if (!x) {
        const existing = pointsOf(t, tg);
        x = { trackId: t.id, target: tg, before: existing ? existing.map((p) => ({ ...p })) : undefined, last: at, value: v, base: old.get(targetKey(tg)) ?? v };
        touches.set(key, x);
        latched = latched.filter((l) => !(l.trackId === t.id && targetKey(l.target) === targetKey(tg)));
        // The gesture ends when the pointer is released.
        if (typeof window !== 'undefined') window.addEventListener('pointerup', () => release(key), { once: true });
      }
      changes.push({ touch: x, value: v });
    }
  }
  if (!changes.length) return;
  writing = true;
  try {
    useStore.getState().commit((d) => {
      for (const c of changes) write(d, c.touch, c.value, at);
    }, { history: false });
  } finally {
    writing = false;
  }
}

/** The control was let go. */
export function release(key: string) {
  const x = touches.get(key);
  if (!x) return;
  touches.delete(key);
  const mode = useAutoWrite.getState().mode;
  if (mode === 'latch' && engine.playing) return void latched.push(x);
  if (mode !== 'touch') return;
  const at = engine.position;
  writing = true;
  try {
    useStore.getState().commit((d) => {
      const tr = d.tracks.find((t) => t.id === x.trackId);
      if (tr) setPoints(tr, x.target, touchRelease(pointsOf(tr, x.target) ?? [], x.before, at, x.base));
    }, { history: false });
  } finally {
    writing = false;
  }
}

/**
 * A parameter moved in a native plugin's own window (G8): written into its lane like any control of the
 * studio. gesture true / false = the control was grabbed / let go (from the plugin), undefined = a move.
 */
export function pluginMoved(trackId: string, slotId: string | null, paramId: string, value: number, gesture?: boolean) {
  const target: AutoTarget = { kind: 'plugin', slotId, paramId };
  const key = `${trackId}|${targetKey(target)}`;
  if (gesture === false) return release(key);
  const mode = useAutoWrite.getState().mode;
  if (mode === 'off' || !engine.playing) return;
  const at = engine.position;
  let x = touches.get(key);
  if (!x) {
    const t = useStore.getState().project.tracks.find((tr) => tr.id === trackId);
    if (!t) return;
    const existing = pointsOf(t, target);
    x = { trackId, target, before: existing ? existing.map((p) => ({ ...p })) : undefined, last: at, value, base: value };
    touches.set(key, x);
    latched = latched.filter((l) => !(l.trackId === trackId && targetKey(l.target) === targetKey(target)));
  }
  if (gesture) return;
  writing = true;
  try {
    useStore.getState().commit((d) => write(d, x!, value, at), { history: false });
  } finally {
    writing = false;
  }
}

/** Playback stopped: latched values are written up to here. */
function onStop() {
  if (!latched.length) return;
  const at = engine.position;
  const done = latched;
  latched = [];
  writing = true;
  try {
    useStore.getState().commit((d) => {
      for (const x of done) write(d, x, x.value, at);
    }, { history: false });
  } finally {
    writing = false;
  }
}

export function initAutoWrite() {
  nativeHooks.onParam = (key, id, value, gesture) => {
    const [trackId, slot] = key.split(':');
    pluginMoved(trackId, slot === 'instrument' ? null : slot, String(id), value, gesture);
  };
  useStore.subscribe((s, prev) => {
    if (prev.isPlaying && !s.isPlaying) onStop();
    onChange(s, prev);
  });
}

/** Tests: the state of the writer. */
export const _autoWriteState = () => ({ touches: [...touches.keys()], latched: latched.length });
