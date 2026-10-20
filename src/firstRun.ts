// First run: what the welcome cards do (surprise, hum, templates), the device check and local-only
// metrics (time to first sound / first export — kept in this browser, never sent anywhere).
import * as Tone from 'tone';
import { create } from 'zustand';
import { useStore } from './store';
import { engine } from './audio/engine';
import { runCommand } from './commands';
import { applyPlan } from './generate/apply';
import { accompanimentPlan, surprisePlan } from './generate/surprise';
import { keyFromProfile, profileFromNotes } from './analysis/key';
import { recordFromMic } from './recording';
import { TEMPLATES } from './templates';
import { advanceTour, startTour, type TourState } from './tour';

// ---------------------------------------------------------------- devices

export const useDevices = create<{ midiInputs: string[]; latencyMs: number | null }>(() => ({ midiInputs: [], latencyMs: null }));
export const setMidiInputs = (names: string[]) => useDevices.setState({ midiInputs: names });

/** Output latency as the browser reports it, once audio runs. */
export function measureLatency() {
  const c = Tone.getContext().rawContext as unknown as AudioContext;
  const ms = Math.round(((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000);
  useDevices.setState({ latencyMs: ms });
  return ms;
}

// ---------------------------------------------------------------- metrics (local only)

const METRICS_KEY = 'openband.metrics';
interface Metrics {
  firstSoundMs: number | null;
  firstExportMs: number | null;
  at: number;
}
const readMetrics = (): Metrics | null => {
  try {
    return JSON.parse(localStorage.getItem(METRICS_KEY) ?? 'null');
  } catch {
    return null;
  }
};
export const useMetrics = create<{ current: Metrics; previous: Metrics | null }>(() => ({ current: { firstSoundMs: null, firstExportMs: null, at: Date.now() }, previous: readMetrics() }));
function saveMetrics() {
  try {
    localStorage.setItem(METRICS_KEY, JSON.stringify(useMetrics.getState().current));
  } catch {
    // not kept
  }
}
export function markFirstExport() {
  const m = useMetrics.getState().current;
  if (m.firstExportMs !== null) return;
  useMetrics.setState({ current: { ...m, firstExportMs: Math.round(performance.now()) } });
  saveMetrics();
}

// ---------------------------------------------------------------- tour

const TOUR_KEY = 'openband.tour';
export const useTour = create<{ tour: TourState | null }>(() => ({ tour: null }));
const tourDone = () => {
  try {
    return localStorage.getItem(TOUR_KEY) === 'done';
  } catch {
    return false;
  }
};
function snapshot() {
  const s = useStore.getState();
  return { playing: s.isPlaying, regions: s.project.regions.length, notes: s.project.regions.reduce((n, r) => n + r.notes.length, 0), bottom: s.bottom, aiOpen: s.aiOpen };
}
export function beginTour(force = false) {
  if (!force && tourDone()) return;
  // A step already done when the tour starts (e.g. the music is playing) is passed at once.
  useTour.setState({ tour: advanceTour(startTour(snapshot()), snapshot()) });
}
export function endTour() {
  useTour.setState({ tour: null });
  try {
    localStorage.setItem(TOUR_KEY, 'done');
  } catch {
    // not kept
  }
}

export function initFirstRun() {
  useStore.subscribe((s, prev) => {
    // First sound.
    if (s.isPlaying && !prev.isPlaying) {
      const m = useMetrics.getState().current;
      if (m.firstSoundMs === null) {
        useMetrics.setState({ current: { ...m, firstSoundMs: Math.round(performance.now()) } });
        saveMetrics();
      }
    }
    // Tour progress.
    const t = useTour.getState().tour;
    if (t && t.step !== 'done') {
      const next = advanceTour(t, snapshot());
      if (next !== t) {
        if (next.step === 'done') endTour();
        else useTour.setState({ tour: next });
      }
    }
  });
}

// ---------------------------------------------------------------- welcome actions

async function play() {
  engine.position = 0;
  await runCommand('transport', { action: 'play', from_bar: 1 }, 'ui');
}

/** 🎲 An 8-bar loop, playing in well under two seconds. */
export async function surpriseMe(seed = Math.floor(Math.random() * 1e9)) {
  const s = surprisePlan(seed);
  await applyPlan(s.plan, { label: s.plan.name });
  await play();
  return s.summary;
}

/** A template, with its explanations on screen. */
export async function openTemplate(id: string) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`No template "${id}"`);
  await applyPlan(t.plan);
  useStore.getState().set({ bottom: 'comments' });
  await play();
}

/** 🎤 Hum 4 bars: the melody becomes notes, with chords, bass and a beat under it. */
export async function humAnIdea() {
  await runCommand('new_project', { name: 'Hummed idea', bpm: 90 }, 'ui');
  const r = await recordFromMic({ mode: 'hum', startBeat: 0, bars: 4 });
  if (!r.midi) throw new Error('No melody found in the recording');
  const region = useStore.getState().project.regions.find((x) => x.id === r.midi!.region_id);
  if (!region?.notes.length) throw new Error('No melody found in the recording');
  const key = keyFromProfile(profileFromNotes(region.notes))?.key ?? 'C';
  const acc = accompanimentPlan(region.notes, key, useStore.getState().project.bpm, region.start / 4 + 1);
  await applyPlan({ ...acc, id: 'hum', name: 'Hummed idea' }, { replace: false, label: 'Accompaniment' });
  const bars = Math.ceil(region.length / 4);
  await runCommand('set_loop', { enabled: true, start_bar: 1, end_bar: bars + 1 }, 'ui');
  await play();
}
