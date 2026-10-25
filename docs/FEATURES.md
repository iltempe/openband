# OpenBand: features

🇬🇧 English · 🇮🇹 [Italiano](FEATURES.it.md) · [← README](../README.md)

- **Arrangement**: instrument, drum and audio tracks; MIDI regions you can drag, resize, duplicate (⌥-drag or ⌘D) and move between tracks of the same kind; ruler with cycle (loop) and zoom (⌘ + wheel).
- **Piano roll**: add, move, stretch and delete notes; grid from 1/4 to 1/32 plus triplets; transpose, quantize and velocity.
- **Ghost notes — Tab to write**: a moment after you stop editing, the piano roll suggests in grey what comes next: the rest of the melody and the next bar, a bass line under your chords (on an empty bass region), a variation of the motif (on an empty section), and in the step sequencer the rest of the groove or a fill. **Tab** accepts (one undo step), **⇧Tab** shows the next of three, **Esc** dismisses; *Harmonize* (3 chord progressions, on a new harmony track), *Counter-melody* and *Bass line* ask for one now, and **?** says why (*“chord tones of Am on the strong beats, repeats the rhythm of bar 2”*). Local and instant — no LLM, nothing leaves your computer — and it learns from what you accept (*Forget what I taught* resets it). In Jam mode the same engine answers your phrase at once, and the AI's answer replaces it when it arrives in time. The AI uses it too: `suggest_continuation`.
- **Draw the song** (from the AI or MCP for now; the drawing lane comes next): give the energy over time — points, or a shape (*pop*, *slow build*, *EDM drop*, *ballad*) and a length (*3:30*) — and **Arrange** turns the loop you have into a whole song: sections where the energy changes (intro, verses, choruses, bridge, outro), instruments that come in with the energy, the drummer busier and louder, the lead doubled an octave up on the peaks, the filter opening in the build-ups, more reverb in the quiet parts, the second verse with one layer more, **transitions** made on the spot (riser, downlifter, reverse cymbal, impact, a drum fill, a stop before the drop) and an ending (a fade, or the tonic with a crash). Your notes are never changed — only copied and moved — and the result goes on a new branch, opened in compare view. Same seed, same song.
- **Drum step sequencer**: 11 pieces (kick, snare, clap, rim, closed and open hi-hat, 3 toms, crash, ride), paint by dragging, accents.
- **15 synthesized instruments**: piano, FM electric piano, organ, bells, lead, pluck, 8-bit, 3 basses, pad, strings and 3 drum kits (Studio, Trap 808, Lo-Fi).
- **Import your own sounds**: turn audio files into a playable **sampler** (note names in file names set the keys, otherwise the pitch is detected), build **drum kits** from samples (kick, snare, hat… recognised by name), load instruments from **SoundFont (.sf2)** libraries, or drop audio files on the timeline.
- **Audio tracks** with waveforms: clips with gain and start trim, included in the WAV export.
- **Smart Controls**: per-track volume, pan, brightness (filter), reverb and echo.
- **Per-track effects**: amp simulator (drive, cabinet tone, level), 3-band EQ with sweepable mids and a compressor with gain-reduction meter.
- **Automation** of volume, pan, brightness, reverb and echo: draw curves in a lane under each track.
- **Plugins (Web Audio Modules 2.0)** — the open plugin standard of the web: browse the community collection of synths, drum machines, amps, pedals and reverbs, or load any WAM from a URL. Plugin instruments play your MIDI, plugin effects go in each track's chain, their own windows open inside the studio and their settings are saved with the project and rendered in the WAV export.
- **Mixer** with level meters, faders, mute and solo, sends and master.
- **Musical typing** (keys A–' like a piano, Z/X for octave, C/V for velocity) and **Web MIDI** for external controllers.
- **Live recording** into new regions, with metronome.
- **Microphone recording and hum-to-MIDI**: record your voice or an instrument onto an audio track after a one-bar count-in (with latency compensation), or *hum a melody* and get it back as MIDI notes, snapped to the key and gently quantized. Any monophonic audio clip can be converted the same way. When the AI asks to record, you always confirm first.
- **MIDI import and export** (Standard MIDI Files, General MIDI programs, drums on channel 10).
- **The AI listens**: `analyze_mix` renders the song and measures it — loudness (EBU R128 LUFS, true peak, LRA), frequency balance in 7 bands, stereo/phase, masking between tracks, the key — and returns concrete fixes (*“Bass and Drums cover each other at 60–250 Hz: cut 2–3 dB around 80 Hz…”*). `render_spectrogram` gives Claude an image of the mix to look at, and `analyze_harmony` reads the chords with their degrees in the key (*Am7 i7 · Fmaj7 VImaj7 · V7/V…*) and the cadences. The same reports are in the **Analysis** panel (N).
- **Play together, with the AI as the third musician**: open a room from the people button, share the link (and the password) and everyone edits the same song live — different notes of the same region merge on their own (Yjs CRDT). You see who's on which track, imported sounds travel to whoever lacks them, play/stop can follow the host, and **undo only takes back your own work**. The AI connected to your browser acts in the room like anyone else, and the others see what it did and for whom. Saved versions and branches are shared with the room too, and comments become threads with everyone's name (*“AI · Marco”*, *“Giulia”*).
- **Jam with the AI (call-and-response)**: turn on *Jam* in the AI panel, play a phrase and the AI answers on the next bar or at the loop start — LLM latency is hidden by quantizing the answer to the next musical window (if it arrives too late it moves to the following one, never mid-bar, never over the previous answer). Answers are heard but not saved: they show as glowing ghost notes in the piano roll until you press **Keep**.
- **Versions and branches, like git for songs**: save versions, branch off to try another direction (*“what if the chorus were slower?”*), go back at any time (undoable; unsaved work is kept as a WIP version), and **merge** branches three-way — changes on different tracks, regions or fields combine by themselves, real conflicts are listed with *keep ours / take theirs*. The **compare view** colours the timeline (green added, yellow changed, red dashed removed), shows the other version's notes as ghosts in the piano roll, and lets you A/B the two versions in sync. `export_project_json({canonical:true})` writes deterministic JSON for git.
- **Explain mode**: right-click a region, a section or selected notes and choose **Explain** — the AI answers with a comment pinned right there (*“C in first inversion: E in the bass softens the move from Fmaj7…”*). Turn on **Teach me** and the AI annotates its non-obvious choices while it works. Comments live in the song (threads, replies, resolve), survive export and undo, and are kept — marked *deleted* — if their target goes away.
- **Takes, comping and blind A/B**: every region can hold alternative takes — recorded in cycle mode (one per pass, as in GarageBand) or written by the AI (*“give me 4 bass lines”*). Comp the best parts by dragging across the take lanes, or run a **blind test**: the takes loop as A/B/C/D in random order, you rank them, and only then the names are revealed (and the AI gets your ranking).
- **Record like a studio**: pick the input device, arm several audio tracks with **R** (input 1 on the vocal, input 2 on the guitar) and they record together; **punch in/out** over a range after a pre-roll replaces only those bars, as a new take with 5 ms crossfades; with the cycle on, every pass becomes a take; optional input monitoring tells you its latency.
- **A drummer and a loop library**: *add_drummer* plays a human-like part in one of 10 styles (rock, pop, funk, boom-bap, trap, lo-fi, house, bossa, ballad, shuffle) that follows the song — simpler in verses, fuller in choruses, fills before each new section — and the same seed always plays the same part, so alternatives are a new seed away (as takes, for a blind test). The *Loops* tab of the library has 16 CC0 loops (drums, bass, keys, pad, lead) made with OpenBand: preview them at your tempo and key, add them at the playhead and they follow the song.
- **Time-stretch and pitch for audio clips**: a loop can *follow the tempo* of the song (its own BPM is read from the file name or its onsets), be stretched by a ratio, or be transposed in semitones without changing its length — and changing the key offers to transpose the audio clips too. OpenBand's own WSOLA and phase vocoder (no GPL code) run in a worker; attacks stay within a few ms of the beat ([ADR](adr/0002-time-stretch.md)).
- **Automate anything**: besides volume, pan, tone and sends, every parameter of the built-in effects (EQ frequency, compressor threshold, drive…) and of any plugin can have a curve — values in the parameter's own units, the same live and in the export. Draw it, or record it: set the lane to *Touch* or *Latch* and move knobs and faders while the song plays.
- **DAWproject: a bridge to Bitwig, Studio One and Cubase**: open a `.dawproject` (menu ⋯, drag & drop, or *Open with* once installed) and its tracks, note and audio clips, markers, volume/pan automation, mixer, built-in EQ and compressor come in; plugins installed on your computer (VST3, CLAP, AU, in the desktop app) load with their settings, the others become the closest OpenBand instrument, and everything that can't come along is listed in *What wasn't imported*. Export writes native plugins as VST3 / CLAP / AU devices with their state, so the other DAW opens them as they were. Export goes the other way, audio included; OpenBand's own parts (lyrics, takes, comments, plugins) ride along inside the file, so OpenBand → DAWproject → OpenBand loses nothing.
- **Safety net and time machine**: every step (your edits, each AI request, undo, redo) is journaled in the browser, so work is never lost — after a crash OpenBand offers back the changes the autosave missed — and the **time machine** in the Versions panel rebuilds the song at any moment of the last 30 days: listen to it, A/B it against now, restore it or open it as a branch, without ever having saved a version. Destructive operations (new song, import, checkout, merge, deleting a track with regions, AI requests of more than 20 commands, going back in time) save a *“Before: …”* version first, and exporting a `.openband` twice never overwrites (`song v2.openband`).
- **Monitoring essentials**: a live **LUFS meter** on the master (momentary, short-term, integrated, true peak 4× oversampled — an AudioWorklet that matches the offline measurement within 0.3 LU) against a target (Streaming −14, Apple −16, Broadcast −23, Club −8) with a green / yellow / red light; **Mono** and **Dim** (−20 dB) buttons for listening only, never in the export; **Ø** polarity per track (rendered). **A/B level-matched**: measure how much louder an FX chain or a plugin makes a track, hear it bypassed at the same loudness (*“This chain adds +5.8 dB: without compensation the volume is fooling you”*), and make the compensation permanent with one click.
- **Flub markers**: while recording press **F** when you slip (**G** for a part worth keeping; Shift+F / Shift+G when musical typing is open) or step on a MIDI pedal (CC64 by default, or any controller with *Learn*). Red and green flags land on the ruler, on the region and on the take; the **To fix** panel lists them, `]` / `[` jump to the next / previous one with a 2-bar loop around it, and **Best take** comps in, over the bars around the mistake, the take with no slip there and the most good marks. The AI is told as you mark (`flub` events) and can offer to fix them.
- **Native CLAP, VST3 and AU instruments and effects** (desktop app): the CLAP, VST3 and (on a Mac) Audio Unit plugins installed on the computer — synths on their tracks with their own windows, sample-accurate automation, undo — in the plugin browser next to the web ones; each runs in a process of its own, so a crash only stops that plugin while the track plays on, in time ([DESKTOP.md](DESKTOP.md#native-plugins)).
- **Plugin delay compensation**: a plugin that delays the sound (lookahead, or the audio bridge of native plugins in the desktop app) delays every other track as much, live and in exports, within a sample; the slot shows the latency it adds.
- **Mix & Master Pilot** (*Mix Pilot* tab, `mix_pilot`): pick a genre and a platform, press *Run pilot*: OpenBand listens to every track and mixes it — trims to a working level, balance by role, EQ cuts where tracks mask each other (*“Cut 1.5 dB at 354 Hz on Pad: it was covering Drums”*), high-pass filters, kick → bass sidechain, mirrored pan, reverb and echo by genre — then masters it to the platform's loudness. One knob (*How much*) doses it and stays live; *Listen before* compares at the same loudness; roles can be corrected on each mixer strip. **Export for platforms**: one zip with a master per platform (24-bit; CD 16-bit dithered), instrumental, a cappella, stems by role that add up to the master, and a report. Guide: [MIXING.md](MIXING.md).
- **Master chain and sidechain** (Mixer): EQ (tilt, shelves, bands) → glue compressor → M/S width with mono lows → a **true-peak limiter** (4× oversampled, 5 ms lookahead, an AudioWorklet that runs the same code live and in the export). *Set loudness* picks a platform — Spotify −14, Apple −16, YouTube −14, SoundCloud −11, Club −8, CD −9 LUFS — renders the song and sets the limiter gain to land within ±0.3 LU without passing the ceiling. Per track: a **high-pass** filter and **sidechain** on the compressor (the bass ducks under the kick).
- **Reference matching**: load a song you'd like to sound like (it stays off the timeline), flip **A/B** in the mixer to hear it at the same loudness as your mix and at the same point in the song, and compare: loudness, dynamics, width and the 1/3-octave balance after loudness matching, with suggestions such as *“+2.5 dB above 6 kHz on the master”* or *“cut 2 dB at 250–500 Hz on the Pad, the loudest track there”*.
- **Song structure**: mark intro, verses, choruses… in the *Structure* lane above the ruler (or let *Suggest* find them from repetitions). Click a section to loop it, drag it to move it with all its content (⌥ pushes the rest of the song), right-click to duplicate or delete it. The AI works in sections too: *“add one more chorus at the end”*, *“make the second verse bigger”*.
- **Lyrics**: write the words per section in the **Lyrics** panel; Italian lyrics are split into metric syllables (with synalepha: *canto e ballo* = 4) and stressed syllables are marked, English too. Align them to the melody track: syllables appear under the track and inside the piano-roll notes, and prosody problems — stressed syllables on weak beats, long notes on unstressed endings, words cut by rests, syllables vs notes — are underlined and listed. Export a **ChordPro** or chords-over-lyrics sheet.
- **Musical linter**: the **Problems** panel (badge in the toolbar) checks the song after every change — notes out of key, overlapping notes and regions, notes past the end of a region, two bass parts clashing below E2, crowded registers, mechanical velocity or timing, empty tracks, panned bass — most with a one-click fix. The AI runs the same checks with `lint_project`, and so can your CI.
- **The AI follows along**: phrases you play (split after a bar of silence), what you select, play/stop, your edits and questions typed in *Ask the AI* reach the connected AI as events. A switch in the AI panel turns activity sharing off (questions are always sent).
- **Undo by intent**: everything the AI does for one request is a single, labelled undo step (*“Undo: Lo-fi beat (23 commands)”*); drags and knob turns are one step each. **Plugins included**: whatever you change in a plugin's own window (presets, modes, wavetables — not just automatable knobs) and every `set_plugin_params` is an undo step too, and undo puts the plugin back in exactly the state it was in.
- **Undo/redo**, autosave, **WAV export** with offline rendering; projects with imported sounds are saved as a single `.openband` file that bundles the samples.
- **AI control via MCP**: 146 tools to compose, arrange, import sounds, add plugins, mix, automate and export — the AI can add a plugin just from a description such as *“a warm tube overdrive”*.
- **English and Italian** interface (switch from the start screen or the ⋯ menu).

| Piano roll | Mixer |
|---|---|
| ![Piano roll](editor.png) | ![Mixer with effects on two tracks](mixer.png) |
| **Effects** | **Audio track** |
| ![Amp, EQ, compressor and a WAM reverb on the bass](effects.png) | ![Audio clip with waveform](audio.png) |
| **Analysis (what the AI hears)** | **Spectrogram (what the AI sees)** |
| ![Analysis panel](analysis.png) | ![Spectrogram of the demo](spectrogram.png) |
| **Problems (musical linter)** | **Lyrics and prosody** |
| ![Problems panel](problems.png) | ![Lyrics panel](lyrics.png) |
| **WAM plugin window** | **Plugin browser** |
| ![Synth-101 WAM plugin](plugins.png) | ![Searching plugins in plain language](plugin-browser.png) |
| **Play together: room, link, people** | **What the others see (avatars, the AI's activity)** |
| ![Room menu with the link and the people in it](room.png) | ![The second musician's studio with the host's avatar and the room activity](multiplayer.png) |
| **Jam: the AI answers what you play** | **The answer as ghost notes, until you keep it** |
| ![Jam section in the AI panel](jam.png) | ![AI answer as ghost notes in the piano roll](jam-ghosts.png) |
| **Versions: branch graph and compare view** | **Ghost notes of the other version** |
| ![Versions panel with branches and the compare view](versions.png) | ![Piano roll with ghost notes](version-ghosts.png) |
| **Explain mode: comments pinned to the song** | **The AI's explanations, per request** |
| ![Comments panel with pins on regions and sections](comments.png) | ![AI panel with annotations](ai-notes.png) |
| **Takes and comping** | **Blind A/B test** |
| ![Takes dialog with comping](takes.png) | ![Blind test of three bass takes](blind-test.png) |
| **Reference matching** | **A/B with the reference** |
| ![Mix vs reference curves and suggestions](reference.png) | ![Reference strip in the mixer](reference-strip.png) |
| **Microphone: record or hum** | **The AI asks before recording** |
| ![Microphone menu](recording.png) | ![Recording confirmation](record-confirm.png) |
| **Punch-in with pre-roll, armed inputs** | **Time-stretch: a loop following the tempo** |
| ![Recording menu with input, armed track and punch range](punch.png) | ![Audio clip editor with Follow tempo (92 BPM) and pitch](time-stretch.png) |
| **The loop library and the drummer** | **Comments in a room, with names** |
| ![Loops tab with a preview playing, a drummer part and loops in the song](loops.png) | ![A comment thread in a room: the AI acting for Marco, and Giulia's reply](room-comments.png) |
| **DAWproject import report** | **Automating a plugin parameter** |
| ![What wasn't imported from a Bitwig project](dawproject-report.png) | ![A plugin's filter frequency automated, with Read / Touch / Latch](automation-plugin.png) |
| **Time machine** | **Crash recovery** |
| ![Time machine slider in the Versions panel](time-machine.png) | ![Recovery banner](recovery.png) |
| **Loudness meter, Mono, Dim, Ø** | **A/B level-matched** |
| ![Mixer with the LUFS meter and polarity buttons](monitoring.png) | ![Level-matched comparison of an FX chain](level-match.png) |
| **Flub markers: the To fix panel** | **Flags on the takes** |
| ![To fix panel with a mistake and a good mark](flubs.png) | ![Takes dialog with flub flags](flub-takes.png) |
| **Mix Pilot: one knob, every change explained** | **Export for platforms** |
| ![The Mix Pilot after a run](pilot.png) | ![Export for platforms: masters, stems, versions](export-platforms.png) |
| **Master chain: Set loudness for Spotify** | **High-pass and sidechain on the bass** |
| ![Master chain in the mixer at −14 LUFS, −1 dBTP](master-chain.png) | ![Bass effects with high-pass and the compressor keyed by the drums](sidechain.png) |

## Using it

- **Your own sounds**: use *Import sounds* at the top of the library. *Sampler* turns audio files into an instrument (name them like `Piano_C4.wav` to set the keys, otherwise the pitch is detected); *Drum kit* maps files named kick, snare, hat, clap, tom… to the kit; *SoundFont* opens a `.sf2` library and lets you pick presets; *Audio* puts files on the timeline. You can also drop files anywhere on the studio. Free SoundFonts to try: FluidR3_GM (MIT) or GeneralUser GS.
- **Saving**: projects with imported sounds are saved as one `.openband` file that contains the samples, so they open anywhere. Songs saved by older versions open as usual and are upgraded automatically.
- **Effects**: select a track and press **F** (or click *FX* on a mixer strip). Each unit has its own power button.
- **Automation**: click **A** on a track to open its lane, choose the parameter, click to add points, drag to move them, double-click to delete.
- **MIDI**: *Import MIDI…* / *Export MIDI* in the ⋯ menu, or drop a `.mid` file on the studio.
- **Plugins**: click *Plugins* in the library and describe what you need (*“wide dark reverb”*, *“synth monofonico”*) or filter by instruments/effects; instruments get their own track, effects are added to the selected track (also from *+ Plugin* in the Effects panel). *Edit* opens the plugin's window. Plugins come from the [WAM community collection](https://github.com/boourns/wam-community) and need an internet connection the first time they load.

## Lint your songs in CI

If you keep songs in a Git repository, check every pull request with the OpenBand linter:

```yaml
# .github/workflows/songs.yml
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: iltempe/openband/.github/actions/openband-lint@main
        with:
          files: songs/*.openband.json songs/*.openband
          fail-on: error        # or warn / info / none
```

Problems appear as annotations on the pull request. Locally: `node scripts/openband-lint.mjs song.openband.json [--format=text|json|github] [--fail-on=warn]`. Rules can be disabled or re-graded per song in `project.lint` (`disabled`, `severity`, `ignored`).
