// Studio → AI event channel. Modules report what the user does here; the bridge forwards it to the
// MCP server. No dependencies, so the store and input code can use it freely.
import { create } from 'zustand';

export interface PhraseNoteOut {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
  raw_start: number;
}

export type StudioEvent =
  | { kind: 'phrase'; track_id: string; start_bar: number; notes: PhraseNoteOut[] }
  | { kind: 'selection'; track_id?: string; region_id?: string; note_ids?: string[] }
  | { kind: 'transport'; action: 'play' | 'stop' | 'loop'; bar: number }
  | { kind: 'user_edit'; label: string }
  | { kind: 'region_recorded'; region_id: string }
  | { kind: 'ask'; text: string; context?: { region_id?: string; section_id?: string; note_ids?: string[]; track_id?: string; explain?: boolean; voice?: boolean } }
  | { kind: 'voice_command'; heard: string; action: string }
  | { kind: 'session_take'; region_id: string; take_id: string; name: string; score: number; flubs: number }
  | { kind: 'session_done'; region_id: string; takes: number; comp_take_id: string | null; best_take_id: string | null }
  | { kind: 'ab_result'; test_id: string; ranking: string[] }
  | { kind: 'flub'; flub_id: string; flub_kind: 'flub' | 'good' | 'note'; beat: number; bar: number; track_id?: string };

/** Events the user triggers on purpose: always sent, even with activity sharing off. */
const EXPLICIT = new Set<StudioEvent['kind']>(['ask', 'ab_result']);
const SHARE_KEY = 'openband.shareActivity';

function initialShare() {
  try {
    const v = localStorage.getItem(SHARE_KEY);
    if (v !== null) return v === '1';
  } catch {
    // storage unavailable
  }
  // On by default when the studio runs locally (where an AI can actually be connected).
  return typeof location === 'undefined' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
}

/** "Teach me" mode: the AI explains its non-obvious choices with annotations. */
const TEACH_KEY = 'openband.teachMode';
export const useTeachMode = create<{ on: boolean }>(() => {
  try {
    return { on: localStorage.getItem(TEACH_KEY) === '1' };
  } catch {
    return { on: false };
  }
});
export function setTeachMode(on: boolean) {
  useTeachMode.setState({ on });
  try {
    localStorage.setItem(TEACH_KEY, on ? '1' : '0');
  } catch {
    // not persisted
  }
}

/** Ask the AI to explain something (the "Explain" buttons). */
export const askExplain = (text: string, context: NonNullable<Extract<StudioEvent, { kind: 'ask' }>['context']>) => emitStudioEvent({ kind: 'ask', text, context: { ...context, explain: true } });

export const useActivitySharing = create<{ share: boolean }>(() => ({ share: initialShare() }));
export function setActivitySharing(share: boolean) {
  useActivitySharing.setState({ share });
  try {
    localStorage.setItem(SHARE_KEY, share ? '1' : '0');
  } catch {
    // not persisted
  }
}

type Sink = { event(e: StudioEvent & { at: number }): void; projectChanged(): void };
let sink: Sink | null = null;
export const setEventSink = (s: Sink | null) => void (sink = s);

/** In-app listeners (e.g. jam mode reacting to phrases); they get every event, shared or not. */
const local = new Set<(e: StudioEvent) => void>();
export const onStudioEvent = (fn: (e: StudioEvent) => void) => (local.add(fn), () => void local.delete(fn));

export function emitStudioEvent(e: StudioEvent) {
  local.forEach((fn) => fn(e));
  if (!sink) return;
  if (!EXPLICIT.has(e.kind) && !useActivitySharing.getState().share) return;
  sink.event({ ...e, at: Date.now() });
}

// Selection changes are throttled: at most one event every 500 ms, always ending on the latest.
let selTimer: ReturnType<typeof setTimeout> | undefined;
let selLast = 0;
let selPending: StudioEvent | null = null;
export function emitSelection(e: Extract<StudioEvent, { kind: 'selection' }>) {
  selPending = e;
  const wait = 500 - (Date.now() - selLast);
  if (wait <= 0) {
    selLast = Date.now();
    emitStudioEvent(e);
    selPending = null;
    return;
  }
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    if (!selPending) return;
    selLast = Date.now();
    emitStudioEvent(selPending);
    selPending = null;
  }, wait);
}

// "The project changed" notifications for MCP resource subscribers, coalesced.
let changeTimer: ReturnType<typeof setTimeout> | undefined;
export function notifyProjectChanged() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => sink?.projectChanged(), 300);
}
