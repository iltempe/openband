// Jam mode (F15): the user plays a phrase, the AI answers on the next musical window. The answer is
// ephemeral (heard, not stored) until the user keeps it.
import { create } from 'zustand';
import type { Note, Region } from './types';
import { BEATS_PER_BAR, uid } from './music';
import { getTrack, useStore } from './store';
import { engine } from './audio/engine';
import { onStudioEvent } from './events';
import { phraseLength, planResponse, type JamWindow } from './jam';

export interface JamAnswer {
  trackId: string;
  /** Timeline beat where it starts (bar-aligned). */
  startBeat: number;
  notes: { pitch: number; start: number; duration: number; velocity: number }[];
  /** AudioContext times. */
  startTime: number;
  endTime: number;
  slipped: boolean;
}

interface JamState {
  enabled: boolean;
  trackId: string | null;
  window: 'next_bar' | 'next_loop';
  status: 'idle' | 'listening' | 'thinking' | 'answering';
  last: JamAnswer | null;
}

export const useJam = create<JamState>(() => ({ enabled: false, trackId: null, window: 'next_bar', status: 'idle', last: null }));

const st = () => useStore.getState();
let doneTimer: ReturnType<typeof setTimeout> | undefined;

export function setJamMode(enabled: boolean, trackId?: string | null, window?: 'next_bar' | 'next_loop') {
  if (trackId && !getTrack(st().project, trackId)) throw new Error(`Track "${trackId}" not found`);
  useJam.setState((s) => ({ enabled, trackId: trackId ?? s.trackId, window: window ?? s.window, status: enabled ? 'listening' : 'idle' }));
  return { enabled, response_track_id: useJam.getState().trackId, window: useJam.getState().window };
}

export function jamStatus() {
  const j = useJam.getState();
  return { enabled: j.enabled, response_track_id: j.trackId, window: j.window, status: j.status, ...(j.last ? { last_answer_bar: j.last.startBeat / BEATS_PER_BAR + 1 } : {}) };
}

/** Play an answer on the next window. Returns where and when it will sound. */
export function playPhrase(trackId: string, notes: JamAnswer['notes'], at?: JamWindow, commitIt = false) {
  const p = st().project;
  const track = getTrack(p, trackId);
  if (!track) throw new Error(`Track "${trackId}" not found`);
  if (track.kind === 'audio') throw new Error('Answers are notes: use an instrument or drum track');
  if (!notes.length) throw new Error('No notes to play');
  const j = useJam.getState();
  const length = phraseLength(notes);
  const busyFor = j.last && j.last.endTime > engine.now ? ((j.last.endTime - engine.now) * p.bpm) / 60 : 0;
  const plan = planResponse({ now: engine.position, playing: engine.playing, window: at ?? j.window, loop: p.loop, length, busyFor });
  const startTime = engine.now + 0.02 + (plan.wait * 60) / p.bpm;
  const endTime = engine.schedulePhrase(track.id, notes, startTime);
  const last: JamAnswer = { trackId: track.id, startBeat: plan.startBeat, notes, startTime, endTime, slipped: plan.slipped };
  useJam.setState({ last, status: 'answering' });
  clearTimeout(doneTimer);
  doneTimer = setTimeout(() => useJam.setState((s) => ({ status: s.enabled ? 'listening' : 'idle' })), Math.max(0, (endTime - engine.now) * 1000));
  const out = { start_bar: +(plan.startBeat / BEATS_PER_BAR + 1).toFixed(2), starts_in_beats: +plan.wait.toFixed(2), starts_in_seconds: +(startTime - engine.now).toFixed(2), slipped: plan.slipped, length_bars: length / BEATS_PER_BAR };
  if (commitIt) return { ...out, ...keepAnswer() };
  return out;
}

/** Keep the last answer: its notes go into the song (one undo step). */
export function keepAnswer() {
  const a = useJam.getState().last;
  if (!a) throw new Error('There is no answer to keep');
  const p = st().project;
  const length = phraseLength(a.notes);
  const notes: Note[] = a.notes.map((n) => ({ id: uid('n'), ...n }));
  // Into a region of that track that already covers the spot, else a new region.
  const host = p.regions.find((r) => r.trackId === a.trackId && !r.audio && r.start <= a.startBeat && r.start + r.length >= a.startBeat + length);
  if (host) {
    st().commit((d) => void d.regions.find((r) => r.id === host.id)!.notes.push(...notes.map((n) => ({ ...n, start: n.start + a.startBeat - host.start }))), { label: 'Keep AI answer' });
    useJam.setState({ last: null });
    return { kept: true, region_id: host.id };
  }
  const region: Region = { id: uid('rgn'), trackId: a.trackId, name: 'AI answer', start: a.startBeat, length, notes };
  st().commit((d) => void d.regions.push(region), { label: 'Keep AI answer' });
  useJam.setState({ last: null });
  return { kept: true, region_id: region.id };
}

export const dismissAnswer = () => useJam.setState({ last: null });

export function initJam() {
  onStudioEvent((e) => {
    if (e.kind === 'phrase' && useJam.getState().enabled) useJam.setState({ status: 'thinking' });
  });
}
