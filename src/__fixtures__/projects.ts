// Reference projects for tests. Plain data only: no store, no audio.
import type { Note, Project, Region, Track } from '../types';
import demoV1 from './demo.v1.json';

/** The demo song exactly as OpenBand v0.1 saved it (schema v1), exported from the browser. */
export const demoV1Raw: unknown = demoV1;

const base = (over: Partial<Project> = {}): Project =>
  ({
    version: 2,
    name: 'Fixture',
    bpm: 120,
    key: 'C',
    tracks: [],
    regions: [],
    loop: { enabled: false, start: 0, end: 16 },
    masterVolume: 0.8,
    metronome: false,
    ...over,
  }) as Project;

export const track = (id: string, over: Partial<Track> = {}): Track => ({
  id,
  name: id,
  kind: 'instrument',
  instrument: 'felt-piano',
  color: '#34d399',
  volume: 0.8,
  pan: 0,
  mute: false,
  solo: false,
  reverb: 0.2,
  delay: 0,
  cutoff: 0.8,
  ...over,
});

let n = 0;
export const note = (pitch: number, start: number, duration = 1, velocity = 0.8, id = `n${++n}`): Note => ({ id, pitch, start, duration, velocity });

export const region = (id: string, trackId: string, start: number, length: number, notes: Note[], over: Partial<Region> = {}): Region => ({
  id,
  trackId,
  name: id,
  start,
  length,
  notes,
  ...over,
});

export const emptyProjectFixture = (): Project => base({ name: 'Empty' });

/**
 * A deliberately messy song in C major, used by the linter tests. Each problem is labelled with the
 * rule that should catch it.
 */
export const dirtyProjectFixture = (): Project =>
  base({
    name: 'Dirty',
    key: 'C',
    tracks: [
      track('t_keys', { name: 'Keys' }),
      track('t_bass', { name: 'Bass', instrument: 'finger-bass', pan: 0.6 }), // bass_panned
      track('t_sub', { name: 'Sub', instrument: 'sub-bass' }),
      track('t_empty', { name: 'Empty' }), // empty_track
      track('t_drums', { name: 'Drums', kind: 'drums', instrument: 'kit-studio' }),
    ],
    regions: [
      region('r_keys', 't_keys', 0, 8, [
        note(60, 0, 1, 0.8, 'k1'),
        note(66, 1, 1, 0.8, 'k_fsharp'), // out_of_key: F#4, a whole beat
        note(64, 2, 1, 0.8, 'k3'),
        note(64, 2.5, 1, 0.8, 'k_overlap'), // overlapping_notes with k3
        note(67, 3, 0.25, 0.8, 'k5'),
        note(68, 3.25, 0.25, 0.8, 'k_passing'), // chromatic passing note between G and A: tolerated
        note(69, 3.5, 0.5, 0.8, 'k7'),
        note(72, 9, 1, 0.8, 'k_outside'), // notes_outside_region (region is 8 beats)
      ]),
      region('r_keys2', 't_keys', 6, 4, [note(62, 0, 1, 0.8, 'k2_1')]), // overlapping_regions with r_keys
      // low_end_clash: Bass and Sub both below E2 (40) at the same time for 4 beats
      region('r_bass', 't_bass', 0, 16, Array.from({ length: 16 }, (_, i) => note(36, i, 1, 0.7, `b${i}`))), // also robotic_velocity
      region('r_sub', 't_sub', 0, 4, [note(33, 0, 4, 0.8, 's1')]),
      region('r_drums', 't_drums', 0, 4, [note(36, 0, 0.25, 1, 'd1'), note(38, 1, 0.25, 1, 'd2')]),
    ],
  });
