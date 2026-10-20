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
  /** Returned by play_phrase; keep_phrase keeps it later. */
  id: string;
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
  /** Recent answers, newest last (at most 20), that can still be kept. */
  answers: JamAnswer[];
}

export const useJam = create<JamState>(() => ({ enabled: false, trackId: null, window: 'next_bar', status: 'idle', last: null, answers: [] }));
const MAX_ANSWERS = 20;

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
  const last: JamAnswer = { id: uid('phr'), trackId: track.id, startBeat: plan.startBeat, notes, startTime, endTime, slipped: plan.slipped };
  useJam.setState((s) => ({ last, status: 'answering', answers: [...s.answers, last].slice(-MAX_ANSWERS) }));
  clearTimeout(doneTimer);
  doneTimer = setTimeout(() => useJam.setState((s) => ({ status: s.enabled ? 'listening' : 'idle' })), Math.max(0, (endTime - engine.now) * 1000));
  const out = { phrase_id: last.id, start_bar: +(plan.startBeat / BEATS_PER_BAR + 1).toFixed(2), starts_in_beats: +plan.wait.toFixed(2), starts_in_seconds: +(startTime - engine.now).toFixed(2), slipped: plan.slipped, length_bars: length / BEATS_PER_BAR };
  if (commitIt) return { ...out, ...keepPhrase(last.id) };
  return out;
}

/** Keep the last answer: its notes go into the song (one undo step). */
export function keepAnswer() {
  const a = useJam.getState().last;
  if (!a) throw new Error('There is no answer to keep');
  return keepPhrase(a.id);
}

/** Keep an answer by its phrase_id (one undo step); it can't be kept twice. */
export function keepPhrase(phraseId: string) {
  const a = useJam.getState().answers.find((x) => x.id === phraseId);
  if (!a) throw new Error(`No answer "${phraseId}" to keep (already kept, or older than the last ${MAX_ANSWERS})`);
  const forget = () => useJam.setState((s) => ({ answers: s.answers.filter((x) => x.id !== a.id), last: s.last?.id === a.id ? null : s.last }));
  const p = st().project;
  const length = phraseLength(a.notes);
  const notes: Note[] = a.notes.map((n) => ({ id: uid('n'), ...n }));
  // Into a region of that track that already covers the spot, else a new region.
  const host = p.regions.find((r) => r.trackId === a.trackId && !r.audio && r.start <= a.startBeat && r.start + r.length >= a.startBeat + length);
  if (host) {
    st().commit((d) => void d.regions.find((r) => r.id === host.id)!.notes.push(...notes.map((n) => ({ ...n, start: n.start + a.startBeat - host.start }))), { label: 'Keep AI answer' });
    forget();
    return { kept: true, phrase_id: a.id, region_id: host.id };
  }
  const region: Region = { id: uid('rgn'), trackId: a.trackId, name: 'AI answer', start: a.startBeat, length, notes };
  st().commit((d) => void d.regions.push(region), { label: 'Keep AI answer' });
  forget();
  return { kept: true, phrase_id: a.id, region_id: region.id };
}

export const dismissAnswer = () => useJam.setState({ last: null });

export function initJam() {
  onStudioEvent((e) => {
    if (e.kind === 'phrase' && useJam.getState().enabled) useJam.setState({ status: 'thinking' });
  });
}
