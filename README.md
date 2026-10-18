# OpenBand

🇬🇧 English · 🇮🇹 [Italiano](README.it.md)

**An open-source, GarageBand-style music studio that runs in your browser — and that your AI can play too, through the Model Context Protocol (MCP).**

### ▶ [Try the live demo](https://iltempe.github.io/openband/) — nothing to install

![OpenBand playing a song](docs/demo.gif)

Ask Claude (or any MCP client) *“make a lo-fi beat at 82 BPM in D minor with drums, bass and Rhodes, then loop it”* and watch the tracks, notes and mixer move in real time.

OpenBand is a *clean-room* implementation: it reproduces the workflow of a consumer DAW (tracks, regions, piano roll, step sequencer, Smart Controls, mixer, musical typing) with code and sounds written from scratch. It contains no Apple code, samples, loops or artwork — every instrument is synthesized in real time — so it is freely redistributable under the MIT license.

## Features

- **Arrangement**: instrument, drum and audio tracks; MIDI regions you can drag, resize, duplicate (⌥-drag or ⌘D) and move between tracks of the same kind; ruler with cycle (loop) and zoom (⌘ + wheel).
- **Piano roll**: add, move, stretch and delete notes; grid from 1/4 to 1/32 plus triplets; transpose, quantize and velocity.
- **Drum step sequencer**: 11 pieces (kick, snare, clap, rim, closed and open hi-hat, 3 toms, crash, ride), paint by dragging, accents.
- **15 synthesized instruments**: piano, FM electric piano, organ, bells, lead, pluck, 8-bit, 3 basses, pad, strings and 3 drum kits (Studio, Trap 808, Lo-Fi).
- **Import your own sounds**: turn audio files into a playable **sampler** (note names in file names set the keys, otherwise the pitch is detected), build **drum kits** from samples (kick, snare, hat… recognised by name), load instruments from **SoundFont (.sf2)** libraries, or drop audio files on the timeline.
- **Audio tracks** with waveforms: clips with gain and start trim, included in the WAV export.
- **Smart Controls**: per-track volume, pan, brightness (filter), reverb and echo.
- **Per-track effects**: amp simulator (drive, cabinet tone, level), 3-band EQ with sweepable mids and a compressor with gain-reduction meter.
- **Automation** of volume, pan, brightness, reverb and echo: draw curves in a lane under each track.
- **Mixer** with level meters, faders, mute and solo, sends and master.
- **Musical typing** (keys A–' like a piano, Z/X for octave, C/V for velocity) and **Web MIDI** for external controllers.
- **Live recording** into new regions, with metronome.
- **MIDI import and export** (Standard MIDI Files, General MIDI programs, drums on channel 10).
- **Undo/redo**, autosave, **WAV export** with offline rendering; projects with imported sounds are saved as a single `.openband` file that bundles the samples.
- **AI control via MCP**: 42 tools to compose, arrange, import sounds, mix, automate and export.
- **English and Italian** interface (switch from the start screen or the ⋯ menu).

| Piano roll | Mixer |
|---|---|
| ![Piano roll](docs/editor.png) | ![Mixer](docs/mixer.png) |

> The online demo can't talk to your AI: for security, the MCP server only accepts pages served from localhost. To let your AI play, run OpenBand locally as shown below.

## Quick start

```bash
git clone https://github.com/iltempe/openband.git
cd openband
npm install
npm run dev          # open http://localhost:5173
```

Or build once, and the MCP server will serve the app itself on `http://127.0.0.1:7777`:

```bash
npm run build
```

A demo song opens on first launch. The “Enter the studio” click is needed because browsers only enable audio after a user interaction.

## Connect an AI (MCP)

```
AI client (Claude Desktop, Claude Code, Cursor…)
        │  stdio · MCP
        ▼
server/mcp-server.mjs ──── WebSocket ws://127.0.0.1:7777/bridge ────▶ OpenBand in the browser
```

The client launches the MCP server, which forwards every call to the open OpenBand window. Each command received shows up in the app's **AI** panel (the “MCP” button, top right).

**Claude Desktop**: add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "openband": {
      "command": "node",
      "args": ["/absolute/path/to/openband/server/mcp-server.mjs"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add openband -- node /absolute/path/to/openband/server/mcp-server.mjs
```

Then open the studio (`npm run dev`, or let the AI call `open_studio` after an `npm run build`) and ask, for example:

> Make a lo-fi beat at 82 BPM in D minor with drums, bass and Rhodes, then start the loop.

Environment variables: `OPENBAND_PORT` (default 7777; if you change it, open the app with `?mcp=<port>`) and `OPENBAND_DEV_URL` (default `http://localhost:5173`).

The bridge only accepts connections from `127.0.0.1` and from pages served on localhost.

### MCP tools

| Area | Tools |
|---|---|
| Project | `get_project`, `get_status`, `list_instruments`, `new_project`, `rename_project`, `set_tempo`, `set_key`, `set_master_volume`, `export_project_json`, `import_project_json`, `undo`, `redo` |
| Tracks | `add_track` (instrument, drums or audio), `update_track` (instrument, volume, pan, mute, solo, reverb, echo, tone), `delete_track` |
| Sounds | `import_sample`, `list_samples`, `create_sampler_instrument`, `import_soundfont`, `add_audio_region` — files are read from a local path or an http(s) URL |
| Mix | `set_track_effects` (amp, EQ, compressor), `set_automation`, `clear_automation` |
| Files | `export_wav`, `export_midi` (optionally `save_to` a path), `import_midi` |
| Regions | `add_region`, `update_region`, `delete_region`, `duplicate_region`, `open_editor` |
| Notes | `get_region_notes`, `add_notes`, `remove_notes`, `transpose_region`, `quantize_region` |
| Composition | `add_drum_pattern` (step strings like `"x...x...x...x..."`), `add_chord_progression` (`["Am7","Fmaj7","C","G"]`, block, arpeggio or stabs style) |
| Transport | `transport` (play, stop, toggle, rewind), `set_loop`, `set_metronome`, `open_studio` |

Conventions: 4/4 time; bars start at 1; inside a region, positions and durations are in beats (0.25 = a sixteenth); pitches are MIDI numbers, names (`"C4"`, `"F#3"`) or, on drum tracks, piece names (`"kick"`, `"snare"`, `"hihat"`…).

## Shortcuts

| Key | Action |
|---|---|
| Space / Enter | Play/Stop · Back to start |
| R · C · M | Record · Cycle · Metronome |
| K | Musical typing (Esc to close) |
| Y · B · E · X · F | Library · Smart Controls · Editor · Mixer · Effects |
| ↑ ↓ | Previous or next track |
| ⌘Z / ⇧⌘Z | Undo / Redo |
| ⌘D · ⌫ | Duplicate region · Delete notes or region |
| ⌘A (in the editor) | Select all notes |

## Code structure

```
src/
  types.ts, music.ts      data model, theory (notes, chords, drum map)
  store.ts                state (zustand), undo/redo, autosave
  commands.ts             command API, shared by the UI and MCP
  bridge.ts               WebSocket client to the MCP server
  input.ts                musical typing, Web MIDI, recording
  audio/instruments.ts    synthesized presets (Tone.js)
  audio/engine.ts         live audio graph, transport, metronome, meters
  audio/render.ts         offline WAV rendering
  audio/samples.ts        imported audio (IndexedDB), waveforms, pitch detection
  audio/sampler.ts        sample-based instruments (sampler, kits, SoundFont presets)
  audio/soundfont.ts      SoundFont 2 reader
  audio/fx.ts             per-track effects (amp sim, EQ, compressor)
  automation.ts           automation curves
  midi.ts                 MIDI file reader/writer, General MIDI mapping
  importers.ts            importing sounds, .openband bundles
  components/             Toolbar, Arrangement, Editor, SmartControls, Mixer, Library, AIPanel…
server/mcp-server.mjs     MCP server (stdio) + WebSocket bridge + static files
```

## Roadmap

- Recording audio from the microphone or a guitar interface
- Web Audio Modules (WAM 2.0) plugin support — the web's equivalent of VST
- Desktop app with Tauri or Electron, hosting native VST/AU plugins
- Generative “Drummer” and a freely licensed (CC0) loop library
- Automation of effect parameters; time-stretching audio clips

Contributions are welcome — open an issue or a pull request. If you like the project, a ⭐ helps others find it.

## License

MIT. “GarageBand” is a trademark of Apple Inc.; OpenBand is an independent project, not affiliated with or endorsed by Apple.
