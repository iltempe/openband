// Live input: musical typing (computer keyboard), Web MIDI, and recording into regions.
import { create } from 'zustand';
import type { Note } from './types';
import { BEATS_PER_BAR, uid } from './music';
import { engine } from './audio/engine';
import { getTrack, makeTrack, useStore } from './store';
import { t } from './i18n';
import { PhraseSegmenter } from './phrases';
import { emitStudioEvent } from './events';
import { takesFromPasses, type PassNote } from './takes';

/** Musical typing layout, semitone offsets from the current octave's C. */
export const TYPING_KEYS: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17,
};
/** On drum tracks the home row plays kit pieces. */
export const DRUM_TYPING_KEYS: Record<string, number> = {
  a: 36, s: 38, d: 39, f: 42, g: 46, h: 45, j: 48, k: 50, l: 49, ';': 51, w: 37,
};

export const useLive = create<{ active: number[] }>(() => ({ active: [] }));

const st = () => useStore.getState();

// ---------- recording ----------

interface Rec {
  trackId: string;
  pending: Map<number, { start: number; velocity: number; pass: number }>;
  notes: PassNote[];
  /** Loop passes so far (cycle recording makes one take per pass). */
  pass: number;
  lastPos: number;
  watch: ReturnType<typeof setInterval>;
}
let rec: Rec | null = null;

function loopLen() {
  const l = st().project.loop;
  return l.enabled ? l.end - l.start : 0;
}

export async function startRecording() {
  const s = st();
  let track = getTrack(s.project, s.selectedTrackId);
  // MIDI can't be recorded onto an audio track: record into a new instrument track instead.
  if (!track || track.kind === 'audio') {
    track = makeTrack(s.project, 'instrument');
    const t = track;
    s.commit((d) => void d.tracks.push(t));
    s.set({ selectedTrackId: t.id });
  }
  const r: Rec = { trackId: track.id, pending: new Map(), notes: [], pass: 0, lastPos: engine.position, watch: 0 as unknown as ReturnType<typeof setInterval> };
  // The transport jumping back means the cycle started over: a new pass.
  r.watch = setInterval(() => {
    const pos = engine.position;
    if (loopLen() && pos < r.lastPos - 0.5) r.pass++;
    r.lastPos = pos;
  }, 20);
  rec = r;
  s.set({ isRecording: true, keyboardOpen: true });
  if (!engine.playing) {
    await engine.play();
    s.set({ isPlaying: true });
  }
  s.notify(t('rec.start', { name: track.name }));
}

export function stopRecording() {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearInterval(r.watch);
  const now = engine.position;
  for (const [pitch, p] of r.pending) r.notes.push({ ...finishNote(pitch, p.start, p.velocity, now), pass: p.pass });
  st().set({ isRecording: false });
  if (!r.notes.length) return;
  const loop = st().project.loop;
  if (loopLen() && new Set(r.notes.map((n) => n.pass)).size > 1) {
    // Cycle recording: one region over the cycle, one take per pass, the last one active.
    const takes = takesFromPasses(r.notes, loop.start, loopLen(), Date.now(), () => uid('take'));
    const last = takes[takes.length - 1];
    const region = { id: uid('rgn'), trackId: r.trackId, name: t('rec.region'), start: loop.start, length: loopLen(), notes: last.notes.map((n) => ({ ...n })), takes, activeTakeId: last.id };
    st().commit((d) => void d.regions.push(region));
    st().selectRegion(region);
    st().notify(t('rec.takes', { n: takes.length }));
    emitStudioEvent({ kind: 'region_recorded', region_id: region.id });
    return;
  }
  const startBar = Math.floor(Math.min(...r.notes.map((n) => n.start)) / BEATS_PER_BAR) * BEATS_PER_BAR;
  const end = Math.max(...r.notes.map((n) => n.start + n.duration));
  const length = Math.max(BEATS_PER_BAR, Math.ceil((end - startBar) / BEATS_PER_BAR) * BEATS_PER_BAR);
  const region = {
    id: uid('rgn'),
    trackId: r.trackId,
    name: t('rec.region'),
    start: startBar,
    length,
    notes: r.notes.map(({ pass: _, ...n }) => ({ ...n, start: n.start - startBar })),
  };
  st().commit((d) => void d.regions.push(region));
  st().selectRegion(region);
  st().notify(t('rec.done', { n: r.notes.length }));
  emitStudioEvent({ kind: 'region_recorded', region_id: region.id });
}

function finishNote(pitch: number, start: number, velocity: number, end: number): Note {
  let e = end;
  if (e < start && loopLen()) e += loopLen();
  return { id: uid('n'), pitch, start, duration: Math.max(0.125, e - start), velocity };
}

// ---------- live notes ----------

// ---------- phrases for the AI ----------

const phrases = new PhraseSegmenter();
/** Monotonic clock in beats: keeps running when the transport loops or is stopped. */
const phraseClock = () => ((performance.now() / 1000) * st().project.bpm) / 60;
let phraseTimer: ReturnType<typeof setInterval> | undefined;
let phraseTrack: string | null = null;

function watchPhrase() {
  if (phraseTimer) return;
  phraseTimer = setInterval(() => {
    const p = phrases.poll(phraseClock());
    if (!p) return;
    clearInterval(phraseTimer);
    phraseTimer = undefined;
    if (phraseTrack) emitStudioEvent({ kind: 'phrase', track_id: phraseTrack, ...p });
  }, 250);
}

export function liveNoteOn(pitch: number, velocity = st().velocity) {
  const trackId = st().selectedTrackId ?? st().project.tracks[0]?.id;
  if (!trackId) return;
  phraseTrack = trackId;
  phrases.noteOn(pitch, velocity, phraseClock(), engine.position);
  watchPhrase();
  if (!engine.contextRunning) void engine.unlock();
  engine.noteOn(trackId, pitch, velocity);
  useLive.setState((s) => ({ active: [...s.active.filter((p) => p !== pitch), pitch] }));
  if (rec && rec.trackId === trackId) rec.pending.set(pitch, { start: engine.position, velocity, pass: rec.pass });
}

export function liveNoteOff(pitch: number) {
  const trackId = st().selectedTrackId ?? st().project.tracks[0]?.id;
  if (trackId) engine.noteOff(trackId, pitch);
  phrases.noteOff(pitch, phraseClock());
  useLive.setState((s) => ({ active: s.active.filter((p) => p !== pitch) }));
  const p = rec?.pending.get(pitch);
  if (rec && p) {
    rec.pending.delete(pitch);
    rec.notes.push({ ...finishNote(pitch, p.start, p.velocity, engine.position), pass: p.pass });
  }
}

export function typingPitch(key: string): number | undefined {
  const s = st();
  const track = getTrack(s.project, s.selectedTrackId);
  if (track?.kind === 'drums') return DRUM_TYPING_KEYS[key];
  const off = TYPING_KEYS[key];
  return off === undefined ? undefined : (s.octave + 1) * 12 + off;
}

// ---------- Web MIDI ----------

export function initMidi() {
  const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> };
  if (!nav.requestMIDIAccess) return;
  nav
    .requestMIDIAccess()
    .then((access) => {
      const bind = () =>
        access.inputs.forEach((input) => {
          input.onmidimessage = (e) => {
            const [status, d1, d2] = e.data ?? [];
            const cmd = status & 0xf0;
            if (cmd === 0x90 && d2 > 0) liveNoteOn(d1, d2 / 127);
            else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) liveNoteOff(d1);
          };
        });
      bind();
      access.onstatechange = bind;
    })
    .catch(() => {
      /* MIDI permission denied — musical typing still works */
    });
}
