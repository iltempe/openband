# ADR 0002 — Time-stretch and pitch-shift of audio clips

Status: accepted (F23) · 2026-10-20

## Context

Audio clips need to follow the song's tempo (loops), be stretched by a ratio, and be transposed when the
key changes. Options considered:

1. **Rubber Band** (WASM build) — excellent quality, but **GPL**: not compatible with OpenBand's licence. Rejected.
2. **signalsmith-stretch** (MIT, WASM) — high quality, built as an AudioWorklet node for real-time use.
3. **Our own** WSOLA (time-stretch) and phase vocoder with identity phase locking (pitch-shift), in TypeScript.

## Decision

Option 3: `src/audio/stretch.ts`, pure and synchronous, run in a worker (`src/workers/stretch.worker.ts`)
with a cache of processed buffers by (sample, factor, semitones) (`src/audio/processed.ts`).

- Stretch only → **WSOLA** (≈23 ms frames, half overlap, ±¼-frame waveform-similarity search): it keeps
  transients and voices clean, which a phase vocoder smears. Inside a frame the material plays at its own
  speed, so an attack d samples into a frame would land d·(1 − factor) off its stretched time (up to ~6 ms
  here, plus the search shift): frames that contain an attack are placed so that it lands exactly on time.
  Over five tempo changes (92→120, 100→120, 120→90, 80→128, 140→100) the worst onset error went from
  9.3 ms (plain WSOLA) to 2.5 ms.
- Pitch (with or without stretch) → **phase vocoder** (≈46 ms frames, ¼ hop, identity phase locking to
  spectral peaks), then cubic resampling.
- 3 ms fades at both ends of every processed clip.

Why not signalsmith-stretch: its interface is a real-time AudioWorklet node, while OpenBand needs whole
buffers processed off the main thread, identically for live playback and for the offline render, and
testable in Node. Our own code has no dependency and no build step (≈300 lines), and its behaviour is
covered by unit tests. If its quality turns out to be a limit — mostly pitch-shifting drums — swapping
the processing function behind `processChannel()` is local.

## Comparison

`node scripts/stretch-compare.mjs [dir]` regenerates this table and writes every result as WAV for a
listening test. Materials are synthesized so the script runs anywhere: a sung "ah" (sawtooth with
vibrato through three formants), a drum loop (kick, snare, hats at 120 BPM), a pad (detuned saws).

- *transients kept*: mean of the 8 steepest envelope rises, relative to the original (100% = as sharp);
- *pitch error*: fundamental (autocorrelation) against the expected one;
- *edge jump*: largest sample-to-sample jump in the first/last 5 ms, relative to the original's (a click shows as ≫ 1);
- *time / audio*: processing time over the duration of the output (Node, one core).

| material | operation | method | transients kept | pitch error | edge jump vs original | time / audio |
|---|---|---|---|---|---|---|
| voice | stretch ×0.8 | WSOLA (OpenBand, stretch) | 100% | +0.00% | 1.99× | 1.2% |
| voice | stretch ×0.8 | phase vocoder (OpenBand) | 107% | +0.00% | 1.52× | 2.0% |
| voice | stretch ×0.8 | resample (tape speed) | 100% | +24.77% | 4.54× | 0.1% |
| voice | stretch ×1.25 | WSOLA (OpenBand, stretch) | 100% | +0.00% | 0.62× | 1.2% |
| voice | stretch ×1.25 | phase vocoder (OpenBand) | 103% | +0.00% | 0.43× | 1.6% |
| voice | stretch ×1.25 | resample (tape speed) | 100% | -20.06% | 0.49× | 0.1% |
| voice | pitch +3 st | phase vocoder + resample (OpenBand) | 102% | -0.21% | 1.23× | 1.8% |
| voice | pitch -3 st | phase vocoder + resample (OpenBand) | 105% | -0.15% | 0.84× | 1.5% |
| drums | stretch ×0.8 | WSOLA (OpenBand, stretch) | 81% | — | 0.69× | 1.4% |
| drums | stretch ×0.8 | phase vocoder (OpenBand) | 80% | — | 0.96× | 1.8% |
| drums | stretch ×0.8 | resample (tape speed) | 88% | — | 0.85× | 0.1% |
| drums | stretch ×1.25 | WSOLA (OpenBand, stretch) | 91% | — | 0.69× | 1.3% |
| drums | stretch ×1.25 | phase vocoder (OpenBand) | 63% | — | 0.99× | 1.6% |
| drums | stretch ×1.25 | resample (tape speed) | 87% | — | 0.70× | 0.0% |
| drums | pitch +3 st | phase vocoder + resample (OpenBand) | 66% | — | 0.63× | 1.7% |
| drums | pitch -3 st | phase vocoder + resample (OpenBand) | 79% | — | 0.56× | 1.4% |
| pad | stretch ×0.8 | WSOLA (OpenBand, stretch) | 102% | +0.50% | 1.75× | 1.0% |
| pad | stretch ×0.8 | phase vocoder (OpenBand) | 111% | +0.00% | 0.99× | 1.8% |
| pad | stretch ×0.8 | resample (tape speed) | 102% | +24.84% | 1.36× | 0.0% |
| pad | stretch ×1.25 | WSOLA (OpenBand, stretch) | 99% | +0.00% | 1.00× | 1.0% |
| pad | stretch ×1.25 | phase vocoder (OpenBand) | 108% | +0.00% | 0.99× | 1.5% |
| pad | stretch ×1.25 | resample (tape speed) | 116% | -19.76% | 0.70× | 0.0% |
| pad | pitch +3 st | phase vocoder + resample (OpenBand) | 141% | +0.31% | 1.07× | 1.8% |
| pad | pitch -3 st | phase vocoder + resample (OpenBand) | 142% | +0.01% | 0.72× | 1.3% |

Reading it:

- WSOLA keeps the drum transients far better than the phase vocoder when stretching (91% vs 63% at
  1.25×), with the pitch exact: it is the right default for stretch-only.
- The phase vocoder is exact in pitch on voice and pad (≤ 0.3% error, i.e. ≤ 5 cents) and avoids the
  ±20–25% pitch change of plain resampling ("tape speed").
- Pitch-shifting drums softens their attacks (66–79%): a known limit of phase vocoders, documented here;
  transposing drums is rarely wanted.
- No method clicks at the edges (the 3 ms fades); everything runs at 1–4% of real time.

**Not done here:** a listening test by people. The script writes the WAV files for it; the measures above
are the objective part.

## Acceptance (F23)

- Stretch 0.8× / 1.25× without clicks at the edges or inside: `src/audio/stretch.test.ts` (largest step
  within 1.3× of the original sine's, zero at both ends, same pitch).
- `follow_tempo` keeps onsets on the grid: a 100 BPM loop played at 120 BPM has every onset within
  5 ms of the 120 BPM beats (the spec asks ±10 ms; same test file). In the browser, a 92 BPM loop in a
  120 BPM song exported with follow_tempo: onsets 1–4 ms from the grid.
