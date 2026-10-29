// Magenta RealTime 2's conditioning from the studio's transport (omep-magenta-rt): MRT2 has no tempo input,
// so the beat reaches it as drum onsets and the chords as a piano roll with an onset on every bar.
import { parseChord } from './music.mjs';
import { SAMPLE_RATE } from './stream.mjs';

const BEATS_PER_BAR = 4;

/** MRT2's conditioning for one 40 ms frame that starts at `beat`: the chord as a piano roll, the beat as drums. */
export function conditioningFor(beat, frames, bpm, control) {
  const span = (frames / SAMPLE_RATE) * (bpm / 60);
  const end = beat + span;
  const intensity = control.intensity ?? 0.5;
  const grid = intensity > 0.6 ? 0.5 : 1;
  // A grid point (beat, or eighth) falls inside this frame.
  const onBeat = Math.ceil(beat / grid - 1e-9) * grid < end - 1e-9;
  const bar = Math.floor(beat / BEATS_PER_BAR);
  const barStarts = Math.ceil(beat / BEATS_PER_BAR - 1e-9) * BEATS_PER_BAR < end - 1e-9;
  const list = control.chords?.length ? control.chords : null;
  // A frame that crosses a bar line already plays the new bar's chord (with its onset).
  const at = barStarts ? Math.ceil(beat / BEATS_PER_BAR - 1e-9) : bar;
  const chord = list ? parseChord(list[((at % list.length) + list.length) % list.length]) : null;
  // 128 pitches: -1 = up to the model, 0 off, 1 sustain, 2 onset.
  const notes = chord ? Array.from({ length: 128 }, () => 0) : null;
  if (notes) for (const pc of chord.tones) for (const base of [48, 60]) notes[base + pc] = barStarts ? 2 : 1;
  // Below 0.15 the model keeps its own time (drums masked).
  const drums = intensity < 0.15 ? -1 : onBeat ? 1 : 0;
  return { notes, drums };
}

