# Changelog

All notable changes to OpenBand. The v0.2 work follows [docs/SPEC.md](docs/SPEC.md).

## Unreleased — v0.2 "The AI that listens"

### F15 · Live call-and-response
- Pure module `src/jam.ts`: when the answer starts — `next_bar`, `next_loop` or a given bar, following the cycle — never before the requested window, at least half a beat ahead (otherwise the next window of the same kind), always on a bar line, never overlapping an answer still playing (but allowed to start right where it ends).
- Engine: `schedulePhrase` plays ephemeral notes at absolute AudioContext times with a lookahead timer (no Tone.Part on the looping transport, so nothing repeats on the next pass); stop cancels what hasn't played; start times stay strictly increasing for monophonic synths.
- MCP: `set_jam_mode`, `play_phrase` (`commit` optional), `keep_answer`; `get_status` reports the jam state; the instructions describe the wait_for_event → play_phrase loop.
- UI: Jam section in the AI panel (response track, window, "listening / thinking / answers at bar n", Keep / Dismiss) and the answer as glowing ghost notes in the piano roll with a Keep button; Keep adds the notes to the region already covering that spot or makes a new one (one undo step).

### F13 · Versions, branches, diff and merge
- Pure modules in `src/versions/`: `canonical.ts` (deterministic JSON: sorted keys, numbers to 4 decimals, notes/regions/sections sorted — the same song always gives the same string), `diff.ts` (by id: project fields, tracks per field, regions added/removed/moved/resized, notes added/removed/changed with a pitch+start fallback within a 32nd, sections, lyrics; plus a readable summary such as “Bass: 3 notes changed in Chorus; tempo 82→86”), `merge.ts` (three-way, entity level with field-level merging for tracks; strategies `manual`/`ours`/`theirs`, granular `pick`; common-ancestor search).
- Storage: versions (gzip snapshots via fflate) and branch refs in IndexedDB (the database moves to v2, samples untouched); HEAD per song.
- MCP: `save_version`, `list_versions`, `create_branch`, `checkout` (undoable, saves a WIP version first when there are unsaved changes), `diff_versions`, `merge` (applied as one undo step; saves a merge version with two parents when there are no conflicts); `export_project_json({canonical: true})`.
- UI: Versions panel with the branch graph, save/branch/checkout, change summary, merge with per-conflict *keep ours / take theirs*; compare view (regions green/yellow/red dashed, ghost notes in the piano roll, banner) and synced A/B listening between now and the selected version (rendered offline, played through the reference player).

### F14 · "Explain" mode (annotations)
- Pure module `src/annotations.ts`: target validation (project, track, region, notes, section, bar range), orphan reconciliation run inside every commit — deleting a target marks its annotations *orphaned* without deleting them, and undo restores them — pin anchors and threads.
- MCP: `annotate` (max 500 characters, records the AI transaction it belongs to), `list_annotations`, `resolve_annotation`, `delete_annotation`; `get_status` reports `teach_mode`; the instructions ask the AI to annotate non-obvious choices when it's on and to answer *Explain* requests with `annotate`.
- *Explain* on the region context menu, the section menu and the piano-roll selection sends an `ask` event with the context (`explain: true`).
- UI: comment pins on regions, sections, bar ranges and notes in the piano roll; a Comments panel with threads, replies, resolve/reopen, *Teach me* toggle; the AI panel shows the explanations under the request that produced them. Markdown is rendered without HTML injection.

### F12 · Takes, comping and blind A/B
- Pure module `src/takes.ts`: the region's content becomes "Take 1" on the first alternative, edits to the active take are kept when switching, comping cuts notes at segment boundaries (held notes end there, earlier ones begin there), one take per loop pass for cycle recording.
- Cycle recording: recording with the cycle on and playing over several passes makes one region over the cycle with one take per pass (the last one active).
- MCP: `add_take`, `list_takes`, `set_active_take`, `delete_take`, `comp_takes`, `start_ab_test` (result as the `ab_result` event).
- Blind test (`src/abtest.ts`): takes shuffled into A–D; the mapping stays in a module closure — never in a store, the project or the DOM — until the user confirms their ranking. Switching letters swaps the notes live while the region loops, with no undo steps; the original take is restored at the end, with a button to keep the winner.
- UI: "n takes" badge on regions, takes dialog (switch, delete, drag across lanes to comp, pick 2–4 for a blind test), blind-test overlay with ranking and reveal.

### F6 · Reference matching
- Pure module `src/analysis/reference.ts`: master profile (integrated LUFS, true peak, crest, LRA, correlation, width, 7 bands, 31 third-octave bands) with the spectrum and RMS gated like BS.1770, so silence around a song doesn't change its balance; comparison after loudness matching (tonal diff per band and per 1/3 octave, loudness, crest, width) and suggestions — boosts on the master, cuts on the track with the most energy in the band, gain, compression, width.
- `project.reference` (schema v2): the sample is stored and bundled in `.openband` files like the others but isn't on the timeline; its analysis is cached.
- MCP: `import_reference` (path or URL, optional `from_seconds`/`to_seconds`), `compare_to_reference` (bars or a section), `clear_reference`.
- UI: Reference strip in the mixer (load, A/B switch synced to the song position, loudness match, compare) and a comparison card in the Analysis panel with the two curves, the differences and the suggestions. The mixer's Analyze button moved into the master strip (it used to cover it).
- Accepted: the demo compared with its own WAV export gives 0.0 on every difference.

### F11 · Microphone recording and hum-to-MIDI
- Pure module `src/analysis/pitchtrack.ts`: YIN pitch tracking (FFT difference function, parabolic interpolation, 70–1100 Hz), median smoothing, note segmentation (onsets from silence, +6 dB energy jumps or a new stable pitch held 60 ms; vibrato stays one note; blips under 80 ms dropped), snap to the key and quantize with strength. Runs in the analysis worker. Sampler pitch detection now uses YIN too.
- Recording (`src/recording.ts`): raw microphone input (no echo cancellation/AGC) captured by an AudioWorklet with sample timestamps, one-bar count-in, takes trimmed exactly at the start bar with the browser's output latency plus a manual offset (ms, remembered), stored as WAV samples on an audio track. *Hum a melody* adds the notes on a new instrument track and keeps the hummed audio, muted.
- MCP: `record_audio` (always confirmed by the user in the studio; declining returns `recorded:false`) and `audio_to_midi` (any monophonic audio region or sample).
- UI: microphone button with a popover (record audio / hum, melody instrument, latency offset), recording pill with count-in, level meter and stop, and the AI confirmation dialog.

### F10 · Lyrics, prosody and ChordPro
- Pure modules in `src/lyrics/`: rule-based Italian syllabification (diphthongs/triphthongs, intervocalic i, qu/gu glides, double consonants, inseparable groups, s impura, lexical hiatus dictionary) tested on 372 words; Italian stress (written accents, ~300 sdrucciole, -ere infinitives, forcing with ˈ or an uppercase syllable, unstressed clitics); metric syllables with synalepha; English syllables and stress (heuristics + small dictionary); melismas with `_`.
- Alignment of lines to the melody (per section and per phrase), prosody checks (syllables vs notes, stress on weak beats, long unstressed endings, words cut by rests) — also as the `lyrics_prosody` lint rule — rhythm suggestions with stressed syllables on beats, ChordPro and chords-over-lyrics export (chord changes after the last syllable are kept).
- MCP: `set_lyrics`, `get_lyrics`, `align_lyrics`, `check_prosody`, `suggest_melody_rhythm`, `export_chord_sheet`.
- Lyrics panel (per section, language, melody track, align, ChordPro), lyrics lane under the melody track, syllables in piano-roll notes (stressed in bold, prosody problems underlined).

### F9 · Harmonic analysis
- Pure module `src/analysis/harmony.ts`: chord recognition from MIDI (pitch classes weighted by duration × velocity, 14 templates, bass for inversions → slash chords; one chord per bar, split in halves only when one chord can't explain the bar, so walking basses don't create fake chords; added tones must really be present; sixth chords over their sixth read as minor sevenths).
- Roman numerals in the project key with functions: diatonic degrees, the harmonic-minor V, secondary dominants (V7/V, V/vi…), modal borrowing (bVII, iv…), chromatic chords.
- Cadences: authentic, plagal, ii–V–I, deceptive and half — only those closing a section when sections exist.
- MCP tool `analyze_harmony`; chord strip with degrees (coloured by function) and cadences in the Analysis panel.
- Accepted: I–V–vi–IV, ii–V–I in C and Am–Dm–E7–Am recognised exactly; the demo reads Am7 · Fmaj7 · C · G.

### F8 · Sections as first-class objects
- Pure module `src/structure.ts`: `splitRegionAt` (notes crossing the cut are shortened, audio clips keep the right sample offset), `moveSection` and `duplicateSection` with or without ripple (regions are split at the boundaries; automation and other sections follow), `deleteSection` with or without content, energy profiles and `proposeSections` (4-bar blocks compared by note fingerprints, roles from repetition and density).
- MCP: `get_structure` (energy profile per section, loudness when a full analysis is cached), `add_section`, `update_section`, `delete_section`, `move_section`, `duplicate_section`, `split_region`, `auto_sections`; every edit is one undo step. Instructions tell the AI to work in sections.
- Structure lane above the ruler: click to loop, double-click to add or rename, drag to move (⌥ for ripple), right-click to duplicate, re-type or delete; *Suggest* applies the automatic proposal in one step.

### F7 · Musical linter and CI
- Pure lint engine (`src/lint/`) with stable issue ids (hash of rule + target), per-song settings in `project.lint` (`disabled`, `severity`, `ignored`) and a rule registry for later rules.
- Symbolic rules: `out_of_key` (short chromatic passing notes tolerated), `overlapping_notes`, `notes_outside_region`, `overlapping_regions`, `low_end_clash`, `register_crowding`, `robotic_velocity`, `robotic_timing`, `empty_track`, `bass_panned`, `section_gap`; most have an automatic fix.
- Audio rules (`clipping`, `low_headroom`, `masking_low_end`, `phase_mono`) reuse `analyze_mix` when `include_audio` is set.
- MCP: `lint_project`, `apply_fix` (one undo step), `ignore_issue`, and the new primitive `update_notes` (edit notes keeping their ids).
- Problems panel with a badge in the toolbar, re-checked 1 s after every change.
- CI for songs: `scripts/openband-lint.mjs` (text, JSON or GitHub annotations; `--fail-on`), a composite GitHub Action `.github/actions/openband-lint`, and a CI job that runs it on the demo. esbuild (MIT, already used by Vite) is now an explicit dev dependency for the CLI.

### F5 · `analyze_mix`: the AI hears the mix
- Pure DSP in `src/analysis/`: radix-2 FFT with Hann window; ITU-R BS.1770-4 / EBU R128 loudness (K-weighting at any sample rate, gated integrated, short-term max, LRA, 4× true peak, RMS, crest, clipped samples); band energies (sub … air), centroid and 1/3-octave curve; stereo correlation, width (overall and per band), mono loss; masking between stems; key detection (Krumhansl–Schmuckler from MIDI or from an audio chromagram); rules that turn metrics into issues with concrete suggestions.
- Heavy work runs in `src/workers/analysis.worker.ts`; spectrograms are drawn on an OffscreenCanvas (log frequency, perceptual colormap, bar grid, section names).
- MCP tools: `analyze_mix` (range or section, per-track stats, `summary`/`full` with loudness per bar), `render_spectrogram` (returns an MCP image Claude can see), `detect_key`.
- The mix is analysed as the exact sum of its stems (renders are deterministic since F4): the demo is analysed in ~6 s.
- Relative keys (e.g. C / Am) are reported with `same_scale` and not flagged as a mismatch.
- Analysis panel (N) with LUFS/true-peak meters, band bars, per-track loudness, issues and spectrogram; *Analyze* button in the mixer.

### F3 · Studio → AI event channel
- The browser now reports what the user does: live phrases (split after a bar of silence, notes quantized to 1/16 with the raw start kept), selection (throttled to one event per 500 ms), play/stop/loop, finished user edits, recorded regions and questions from the new *Ask the AI* box.
- MCP server: a 500-event ring buffer with the new tools `get_events` (since_id, kinds, limit) and `wait_for_event` (long-poll up to 60 s, `{timeout:true}` otherwise).
- MCP resource `openband://project` (the `get_project` JSON) with subscriptions: subscribers get `notifications/resources/updated` after every change.
- Privacy: *Share my activity with the AI* in the AI panel (on by default on localhost); when off only explicit events (questions, A/B results) are sent.
- Pure modules with tests: `src/phrases.ts` (phrase segmenter) and `server/events.mjs` (event buffer).

### F4 · Reusable renderer
- `renderBuffer(project, options)` renders the song or a range (`fromBeat`/`toBeat`), only some tracks (stems, ignoring mute/solo), with or without the master volume, at any sample rate and with a configurable tail; notes and audio clips already sounding at the start of the range are rendered from the right point.
- `renderStems()` renders tracks one at a time over the same range; `renderProject()` (WAV export) is built on top and unchanged for users.
- An LRU cache of the last 3 renders keyed on project + options.
- Renders are now deterministic: the reverb impulse is generated from a fixed seed and noise sources are seeded during offline renders, so stems add up exactly to the mix and analyses are repeatable. Verified: the demo's WAV export differs from the pre-refactor one by at most 1 LSB (−90.3 dBFS, the same as between two exports of the old code).

### F2 · Project schema v2 and migrations
- Projects are now schema v2: the same content plus optional fields for the coming features (sections, lyrics, annotations, reference track, linter settings, takes) and `meta` (`projectId`, `createdAt`, `updatedAt`).
- `src/migrations.ts` (pure): `migrate()` accepts v1 and v2 objects or JSON, fills missing defaults, assigns a stable `projectId` and rejects non-projects with a clear message. It is used by autosave, `import_project_json`, `.openband.json` and `.openband` files.
- Autosave moved to `openband.project.v2`; the v0.1 key is still read, so existing songs open and are re-saved as v2.

### F1 · Transactions and undo by intent
- Labelled undo history: each step records its label, source (UI/AI) and how many commands it groups.
- Store transactions (`beginTransaction` / `endTransaction`, nestable): commits inside one become a single undo step; empty transactions leave no trace.
- AI commands are grouped automatically and closed after 4 s of silence, or explicitly with the new MCP tools `begin_change(label)` / `end_change()`; a user edit closes an open AI step instead of merging into it.
- New MCP tool `get_history`; `undo` / `redo` take `steps`.
- Drags and knob turns are one step each. Undo/redo tooltips show the label; the AI panel groups activity by step with an “Undo this” button.

### F0 · Test infrastructure
- Vitest (`npm test`, `npm run test:watch`) with Node as the default environment.
- Reference projects in `src/__fixtures__/`: the v0.1 demo exported as real v1 JSON, an empty project and a deliberately "dirty" one for the linter.
- CI workflow (`.github/workflows/ci.yml`): typecheck and tests on every push and pull request.
- The WAM SDK is now loaded lazily so the command and store modules can be imported in Node.

## 0.1.0

First public version: arrangement, piano roll, step sequencer, synthesized instruments, imported sounds (sampler, drum kits, SoundFont, audio tracks), per-track effects, automation, MIDI import/export, WAM plugins, WAV export, English/Italian UI and AI control over MCP.
