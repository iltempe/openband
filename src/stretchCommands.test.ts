import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { commands } from './commands';
import { keyInterval } from './music';

function audioSong() {
  commands.new_project({ name: 'Loops', bpm: 120, key: 'Am' });
  useStore.setState({ past: [], future: [] });
  const { track_id } = commands.add_track({ kind: 'audio', name: 'Loop' }) as unknown as { track_id: string };
  // A 2-bar loop at 92 BPM (5.217 s), placed at 120 BPM: 10.43 beats long.
  const seconds = (8 * 60) / 92;
  useStore.getState().commit((d) => void d.regions.push({ id: 'rgn_loop', trackId: track_id, name: 'Loop', start: 0, length: (seconds * 120) / 60, notes: [], audio: { sampleId: 'smp_x', offset: 0, gain: 1, stretch: { mode: 'off', originalBpm: 92 } } }));
  return { track_id };
}
const clip = () => useStore.getState().project.regions.find((r) => r.id === 'rgn_loop')!;

describe('time-stretch and pitch commands (F23)', () => {
  beforeEach(audioSong);

  it('follow_tempo: the loop becomes exactly 2 bars at the song tempo, and stays 2 bars when the tempo changes', () => {
    const r = commands.update_region({ region_id: 'rgn_loop', stretch_mode: 'follow_tempo' }) as { factor: number };
    expect(r.factor).toBeCloseTo(92 / 120, 4);
    expect(clip().length).toBeCloseTo(8, 3);
    commands.set_tempo({ bpm: 100 });
    expect(clip().length).toBeCloseTo(8, 3); // beats unchanged: the audio follows
    commands.update_region({ region_id: 'rgn_loop', stretch_mode: 'off' });
    expect(clip().length).toBeCloseTo(((8 * 60) / 92) * (100 / 60), 3);
  });

  it('fixed ratio, pitch, and errors', () => {
    commands.update_region({ region_id: 'rgn_loop', ratio: 1.25 });
    expect(clip().audio!.stretch).toMatchObject({ mode: 'fixed', ratio: 1.25 });
    commands.update_region({ region_id: 'rgn_loop', pitch: -3.5 });
    expect(clip().audio!.pitch).toBe(-3.5);
    commands.update_region({ region_id: 'rgn_loop', pitch: 0 });
    expect(clip().audio!.pitch).toBeUndefined();
    useStore.getState().commit((d) => void delete d.regions[0].audio!.stretch);
    expect(() => commands.update_region({ region_id: 'rgn_loop', stretch_mode: 'follow_tempo' })).toThrow(/original_bpm|detect_tempo/);
  });

  it('a key change can transpose the audio clips, the short way', () => {
    expect(keyInterval('Am', 'Cm')).toBe(3);
    expect(keyInterval('C', 'A')).toBe(-3);
    expect(keyInterval('E', 'Bb')).toBe(-6);
    expect(keyInterval('F#m', 'Gbm')).toBe(0);
    commands.set_key({ key: 'Cm' });
    expect(clip().audio!.pitch).toBeUndefined();
    const r = commands.set_key({ key: 'Dm', transpose_audio: true }) as { audio_clips_transposed_by: number };
    expect(r.audio_clips_transposed_by).toBe(2);
    expect(clip().audio!.pitch).toBe(2);
    commands.set_key({ key: 'C', transpose_audio: true });
    expect(clip().audio!.pitch).toBe(0 + 2 - 2 || undefined);
  });
});
