// Starter song shown on first launch, built through the same command API the AI uses.
import { commands } from './commands';
import { useStore } from './store';

export function loadDemo() {
  const c = commands as Record<string, (a: Record<string, unknown>) => any>;
  c.new_project({ name: 'Notte a Trastevere', bpm: 92, key: 'Am' });

  const drums = c.add_track({ instrument: 'kit-studio', name: 'Batteria' }).track_id;
  const beat = c.add_drum_pattern({
    track_id: drums,
    start_bar: 1,
    bars: 2,
    pattern: {
      kick: 'x.....x.x.....x. x.....x...x.....',
      snare: '....x.......x... ....x.......x..o',
      hihat: 'x.x.x.x.x.x.x.x. x.x.x.x.x.x.x.xo',
    },
    name: 'Groove',
  }).region_id;
  c.duplicate_region({ region_id: beat, times: 3 });

  const bass = c.add_track({ instrument: 'finger-bass', name: 'Basso' }).track_id;
  const roots = [33, 29, 36, 31];
  const bassNotes = roots.flatMap((r, i) => [
    { pitch: r, start: i * 4, duration: 1.5, velocity: 0.9 },
    { pitch: r, start: i * 4 + 1.5, duration: 0.5, velocity: 0.6 },
    { pitch: r + 7, start: i * 4 + 2, duration: 1, velocity: 0.75 },
    { pitch: r + 12, start: i * 4 + 3, duration: 0.5, velocity: 0.7 },
    { pitch: r + 10, start: i * 4 + 3.5, duration: 0.5, velocity: 0.6 },
  ]);
  const bassRegion = c.add_region({ track_id: bass, start_bar: 1, length_bars: 4, notes: bassNotes, name: 'Linea di basso' }).region_id;
  c.duplicate_region({ region_id: bassRegion, times: 1 });

  const keys = c.add_track({ instrument: 'velvet-keys', name: 'Piano elettrico' }).track_id;
  const keysRegion = c.add_chord_progression({
    track_id: keys,
    start_bar: 1,
    chords: ['Am7', 'Fmaj7', 'C', 'G'],
    beats_per_chord: 4,
    octave: 4,
    style: 'stabs',
    velocity: 0.62,
  }).region_id;
  c.duplicate_region({ region_id: keysRegion, times: 1 });

  const pad = c.add_track({ instrument: 'aurora-pad', name: 'Pad' }).track_id;
  c.add_chord_progression({
    track_id: pad,
    start_bar: 5,
    chords: ['Am', 'F', 'C', 'G'],
    beats_per_chord: 4,
    octave: 3,
    velocity: 0.6,
  });

  c.update_track({ track_id: keys, reverb: 0.35, delay: 0.18, pan: -0.15 });
  c.update_track({ track_id: pad, reverb: 0.6, volume: 0.62, pan: 0.2 });
  c.update_track({ track_id: bass, reverb: 0.05 });
  c.set_loop({ enabled: true, start_bar: 1, end_bar: 9 });

  const s = useStore.getState();
  s.set({ past: [], future: [], selectedRegionId: null, selectedTrackId: drums });
}
