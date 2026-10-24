// Jam mode (F15): the user plays a phrase, the AI answers on the next musical window. The answer is
// ephemeral (heard, not stored) until the user keeps it.
import { create } from 'zustand';
import type { Note, Project, Region } from './types';
import { suggest } from './suggest/engine';
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
  /** OpenBand's own instant answer (ghost-note engine, G3), until the AI's arrives. */
  local?: boolean;
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
export function playPhrase(trackId: string, notes: JamAnswer['notes'], at?: JamWindow, commitIt = false, local = false) {
  const p = st().project;
  const track = getTrack(p, trackId);
  if (!track) throw new Error(`Track "${trackId}" not found`);
  if (track.kind === 'audio') throw new Error('Answers are notes: use an instrument or drum track');
  if (!notes.length) throw new Error('No notes to play');
  // The AI's answer replaces OpenBand's instant one if that hasn't started yet.
  const prev = useJam.getState().last;
  if (!local && prev?.local && prev.startTime > engine.now + 0.01) {
    engine.cancelPhrase(prev.id);
    useJam.setState((s) => ({ last: null, answers: s.answers.filter((x) => x.id !== prev.id) }));
  }
  const j = useJam.getState();
  const length = phraseLength(notes);
  const busyFor = j.last && j.last.endTime > engine.now ? ((j.last.endTime - engine.now) * p.bpm) / 60 : 0;
  const plan = planResponse({ now: engine.position, playing: engine.playing, window: at ?? j.window, loop: p.loop, length, busyFor });
  const startTime = engine.now + 0.02 + (plan.wait * 60) / p.bpm;
  const id = uid('phr');
  const endTime = engine.schedulePhrase(track.id, notes, startTime, id);
  const last: JamAnswer = { id, trackId: track.id, startBeat: plan.startBeat, notes, startTime, endTime, slipped: plan.slipped, ...(local ? { local: true } : {}) };
  useJam.setState((s) => ({ last, status: 'answering', answers: [...s.answers, last].slice(-MAX_ANSWERS) }));
  clearTimeout(doneTimer);
  doneTimer = setTimeout(() => useJam.setState((s) => ({ status: s.enabled ? 'listening' : 'idle' })), Math.max(0, (endTime - engine.now) * 1000));
  const out = { phrase_id: last.id, ...(local ? { local: true } : {}), start_bar: +(plan.startBeat / BEATS_PER_BAR + 1).toFixed(2), starts_in_beats: +plan.wait.toFixed(2), starts_in_seconds: +(startTime - engine.now).toFixed(2), slipped: plan.slipped, length_bars: length / BEATS_PER_BAR };
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

/**
 * OpenBand's own instant answer to a phrase (G3): the ghost-note engine continues it, on the next window,
 * while the AI thinks. Pure: from the phrase and the song to the answer's notes (bar-relative), or null.
 */
export function localAnswer(p: Project, trackId: string, phrase: { start_bar: number; notes: JamAnswer['notes'] }, seed = 1): JamAnswer['notes'] | null {
  const track = getTrack(p, trackId);
  if (!track || track.kind === 'audio' || !phrase.notes.length) return null;
  const q = structuredClone(p);
  const start = (phrase.start_bar - 1) * BEATS_PER_BAR;
  const length = phraseLength(phrase.notes);
  q.regions.push({ id: 'jam-local', trackId: track.id, name: 'phrase', start, length, notes: phrase.notes.map((n, i) => ({ id: `j${i}`, pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity })) });
  const best = suggest(q, 'jam-local', { kind: 'continue', count: 1, seed }).suggestions[0];
  if (!best?.notes.length) return null;
  // The whole bar after the phrase, as an answer that starts on its bar line.
  const bar = Math.floor(Math.min(...best.notes.map((n) => n.start)) / BEATS_PER_BAR + 1 - 1e-6) * BEATS_PER_BAR;
  const notes = best.notes.filter((n) => n.start >= bar - 1e-6).map((n) => ({ ...n, start: +(n.start - bar).toFixed(4) }));
  return notes.length ? notes : best.notes.map((n) => ({ ...n, start: +(n.start - Math.floor(n.start / BEATS_PER_BAR) * BEATS_PER_BAR).toFixed(4) }));
}

let jamSeed = 1;
export function initJam() {
  onStudioEvent((e) => {
    if (e.kind !== 'phrase' || !useJam.getState().enabled) return;
    useJam.setState({ status: 'thinking' });
    const ev = e as unknown as { track_id: string; start_bar: number; notes: JamAnswer['notes'] };
    const trackId = useJam.getState().trackId ?? ev.track_id;
    try {
      const notes = localAnswer(st().project, ev.track_id, ev, jamSeed++);
      if (notes) playPhrase(trackId, notes, undefined, false, true);
    } catch {
      // the AI still answers
    }
  });
}
