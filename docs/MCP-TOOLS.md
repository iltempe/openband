# OpenBand MCP tools

🇬🇧 English · 🇮🇹 [Italiano](MCP-TOOLS.it.md) · [← README](../README.md)

The same tools are used by MCP clients and by the chat inside the page (they are defined once, in `server/tools.mjs`).

| Area | Tools |
|---|---|
| Project | `pair_studio` (remote MCP only), `open_studio` (local only), `get_project`, `get_status`, `list_instruments`, `new_project`, `rename_project`, `set_tempo`, `set_key`, `set_master_volume`, `export_project_json`, `import_project_json` |
| Studio events | `get_events`, `wait_for_event` (phrases you play, selection, transport, edits, questions from *Ask the AI*); resource `openband://project` with change notifications |
| Undo | `begin_change` / `end_change` (one undo step per request, with a label), `get_history` (with `plugins_changed` per step), `undo` / `redo` (with `steps`; plugin states included) |
| Tracks | `add_track` (instrument, drums or audio), `update_track` (instrument, volume, pan, mute, solo, reverb, echo, tone), `delete_track` |
| Sounds | `import_sample`, `list_samples`, `create_sampler_instrument`, `import_soundfont`, `add_audio_region`, `detect_tempo` (a loop's BPM from its name or onsets) — files are read from a local path or an http(s) URL |
| Structure | `get_structure` (sections with an energy profile), `add_section`, `update_section`, `delete_section`, `move_section`, `duplicate_section` (with ripple), `split_region`, `auto_sections` |
| Lyrics | `set_lyrics`, `get_lyrics`, `align_lyrics`, `check_prosody`, `suggest_melody_rhythm`, `export_chord_sheet` (ChordPro or text, optional `save_to`) |
| Linter | `lint_project` (symbolic rules, optionally audio ones), `apply_fix`, `ignore_issue`; `update_notes` edits notes in place |
| Listening | `analyze_mix` (bars or section, per track, summary/full), `render_spectrogram` (returns an image), `detect_key` (MIDI, audio or both), `analyze_harmony` (chords, Roman numerals, functions, cadences) |
| Multiplayer | `create_room` (LAN or peer-to-peer, optional password), `join_room`, `leave_room`, `get_peers` |
| Jam | `set_jam_mode` (response track, window), `play_phrase` (ephemeral notes at `next_bar`, `next_loop` or a bar; optional `commit`; returns a `phrase_id`), `keep_answer`, `keep_phrase({phrase_id})` (any of the last 20 answers); the user's phrases arrive as `phrase` events |
| Versions | `save_version`, `list_versions`, `create_branch`, `checkout` (branch or version, undoable, auto-saves WIP), `diff_versions` (readable summary + structured changes), `merge` (three-way; `strategy` and per-entity `pick`); `export_project_json` with `canonical` |
| Explain | `annotate` (project, track, region, notes, section or bar range; markdown up to 500 characters), `list_annotations`, `resolve_annotation`, `delete_annotation`; `get_status` reports `teach_mode` |
| Takes | `add_take`, `list_takes`, `set_active_take`, `delete_take`, `comp_takes` (segments, notes cut at the boundaries), `start_ab_test` (blind test; the ranking arrives as an `ab_result` event) |
| Other DAWs | `import_dawproject` (file path or URL; replaces the song, or `replace: false` adds its tracks; returns what couldn't be converted), `export_dawproject` (`save_to` or download) |
| Time machine | `get_timeline` (every journaled step), `preview_at({time})` (the song at a moment — ISO, ms or `"-20m"` — without changing anything), `restore_at({time, as_branch?})` |
| Monitoring | `get_meters` (live LUFS and true peak of the master and every track, target status), `set_monitoring` (mono, dim, target, reset — listening only), `level_match` (how much an FX chain or plugin changes the loudness; `apply` compensates), `update_track({polarity})` |
| Flubs | `add_flub` (playhead or bar/beat; kinds flub / good / note), `list_flubs`, `resolve_flub`, `delete_flub`, `replace_with_best_take`; `flub` events as the user marks |
| Reference | `import_reference` (path or URL, optional excerpt), `compare_to_reference` (loudness-matched differences and suggestions), `clear_reference` |
| Recording | `record_audio` (microphone or interface, count-in, mode `audio` or `hum`; armed tracks together, punch with pre-roll, cycle passes as takes; the user confirms), `arm_track` (input channel per track), `set_punch` (in/out bars, pre-roll), `audio_to_midi` (monophonic audio → notes, snap to key, quantize with strength) |
| Mix Pilot | `mix_pilot` (mix and master for a genre, dosed, every change explained), `set_pilot_amount`, `fix_pilot`, `set_track_role`, `export_for_platforms` (masters per platform, stems, instrumental, report) |
| Mix | `set_track_effects` (high-pass, amp, EQ, compressor with sidechain), `set_master_chain` (master EQ, glue, width, true-peak limiter, loudness per platform), `set_automation` (mix, effect or plugin parameter), `clear_automation`, `list_automatable` |
| Plugins | `add_plugin` (from a plain-language description; installed plugins first in the desktop app), `search_plugins`, `list_plugins`, `list_native_plugins` and `rescan_plugins` (desktop app: the VST3 / CLAP / AU plugins on the computer), `add_plugin_instrument`, `add_plugin_effect`, `remove_plugin_effect`, `set_plugin_bypass`, `get_plugin_params`, `set_plugin_params`, `show_plugin` |
| Files | `export_wav`, `export_midi` (optionally `save_to` a path), `import_midi` |
| Regions | `add_region`, `update_region` (for audio clips also `stretch_mode` follow_tempo / fixed with `ratio`, and `pitch` in semitones), `delete_region`, `duplicate_region`, `open_editor` |
| Notes | `get_region_notes`, `add_notes`, `remove_notes`, `transpose_region`, `quantize_region` |
| Composition | `add_drum_pattern` (step strings like `"x...x...x...x..."`), `add_chord_progression` (`["Am7","Fmaj7","C","G"]`, block, arpeggio or stabs style), `add_drummer` (style, complexity, loudness, swing, fills, seed; follows the sections), `regenerate_drummer` (new seed, optionally as a take) |
| Loops | `search_loops` (words, tempo, key), `add_loop` (follows the song tempo and key; `repeat`) — a CC0 library made with OpenBand |
| Transport | `transport` (play, stop, toggle, rewind), `set_loop`, `set_metronome`, `open_studio` |

Conventions: 4/4 time; bars start at 1; inside a region, positions and durations are in beats (0.25 = a sixteenth); pitches are MIDI numbers, names (`"C4"`, `"F#3"`) or, on drum tracks, piece names (`"kick"`, `"snare"`, `"hihat"`…).
