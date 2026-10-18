// Core data model. All musical times are expressed in beats (quarter notes).
// The project is 4/4: one bar = 4 beats.

export type TrackKind = 'instrument' | 'drums';

export interface Note {
  id: string;
  /** MIDI pitch 0..127. For drum tracks the pitch selects the kit piece (GM drum map). */
  pitch: number;
  /** Start in beats, relative to the region start. */
  start: number;
  /** Duration in beats. */
  duration: number;
  /** 0..1 */
  velocity: number;
}

export interface Region {
  id: string;
  trackId: string;
  name: string;
  /** Start in beats on the timeline. */
  start: number;
  /** Length in beats. */
  length: number;
  notes: Note[];
}

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  /** Instrument preset id, see audio/instruments.ts */
  instrument: string;
  color: string;
  /** Fader 0..1 (0.8 = 0 dB). */
  volume: number;
  /** -1..1 */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Send levels 0..1 */
  reverb: number;
  delay: number;
  /** Smart control "tone" (low-pass cutoff) 0..1 */
  cutoff: number;
}

export interface LoopRange {
  enabled: boolean;
  start: number;
  end: number;
}

export interface Project {
  version: 1;
  name: string;
  bpm: number;
  key: string;
  tracks: Track[];
  regions: Region[];
  loop: LoopRange;
  masterVolume: number;
  metronome: boolean;
}

export type BottomPanel = 'smart' | 'editor' | 'mixer' | null;

export interface BridgeLogEntry {
  id: string;
  time: number;
  method: string;
  ok: boolean;
  summary: string;
}

export type BridgeStatus = 'connecting' | 'connected' | 'disconnected';
