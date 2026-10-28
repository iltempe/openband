// The OpenBand tools: names, descriptions, input schemas (zod) and hints — the one definition shared by
// the MCP server (server/mcp-server.mjs) and the in-browser agent (src/ai/agent.ts). No Node APIs here.
import { z } from 'zod';

/**
 * kind: 'call'        forwarded to the studio as is
 *       'file'        takes a `source` (path or URL), the content is sent to the studio as base64
 *       'export'      the studio renders a file; with save_to it is written to disk instead of downloaded
 *       'chord_sheet' like export, but returns text
 *       'image'       returns an image (render_spectrogram)
 *       'events_list' / 'events_wait'  answered by the server's event buffer (studio → AI events)
 */
export const TOOLS = [];
const add = (kind, name, description, shape, opts = {}) => TOOLS.push({ kind, name, description, shape, title: opts.title, timeout: opts.timeout, annotations: opts.annotations });
const tool = (name, description, shape, opts) => add('call', name, description, shape, opts);
const fileTool = (name, description, shape, opts) => add('file', name, description, shape, { timeout: 180000, ...opts });
const exportTool = (name, description, shape = {}) => add('export', name, description, { ...shape, save_to: z.string().optional().describe('Optional file path to save to (absolute or ~/...). Without it the browser downloads the file.') }, { timeout: 180000 });
const special = (name, description, shape, kind, opts) => add(kind, name, description, shape, { timeout: 180000, ...opts });

export const INSTRUCTIONS = `OpenBand is a GarageBand-style music studio running in the user's browser. You control it with these tools.

Wrap every user request in begin_change("short label") … end_change() so the user can undo it in one step.
Not every tool may be loaded at first: the core and capability tools always are; if the request needs one that isn't there (lyrics, versions, plugins…), call load_toolset with its toolset and it appears right away. (Commands sent without it are grouped automatically until you pause for 4 seconds.)
When the user talks about parts of a song (verse, chorus…), call get_structure first and operate on sections (move_section, duplicate_section). Use the energy profile to make a section 'bigger' (more tracks, higher register, more notes, higher velocity) or 'smaller'. If there are no sections yet, auto_sections proposes them. When the user has a loop that should become a song ("make this a 3-minute song", "build it up slowly"), draw the energy with set_energy_curve (a shape or points) and call arrange_from_energy: it works on a branch, the user's notes untouched.
For vocal lines, keep lyrics and melody aligned: set_lyrics → align_lyrics → check_prosody. Put stressed syllables on strong beats (suggest_melody_rhythm helps).
When get_status reports teach_mode: true, explain your non-obvious musical choices (harmony, voicing, rhythm, mix) with annotate on the exact notes/region/section, using analyze_harmony to be precise. An ask event with context.explain is a request to explain that part: answer with annotate.
In a multiplayer room (get_peers), say who you are acting for and avoid editing a track someone else has selected unless asked.
In jam mode loop: wait_for_event({kinds:['phrase']}) → answer with play_phrase in the same key, contrasting rhythm, ≤ 2 bars (set_jam_mode({enabled:true, response_track_id}) first; answers are quantized to the next window, so latency is fine). keep_phrase(phrase_id) keeps an answer the user liked.
Before a big rework, save_version; to try a different direction without losing the current one, create_branch + checkout (merge brings the good parts back).
To offer alternatives, add them as takes (add_take) and let the user pick with a blind test (start_ab_test, then wait_for_event ab_result).
Before destructive operations a version is saved automatically; preview_at/restore_at can bring back any earlier moment.
add_drummer creates human-like drums that follow the song sections; regenerate with a new seed for alternatives.
Use get_meters for live loudness, level_match before judging whether an effect chain helps.
Flubs: list_flubs shows where the user marked mistakes while recording; offer to fix them (comp from takes, re-record, or edit notes).
Run lint_project before declaring a task done and fix errors (apply_fix).
Before mixing decisions, LISTEN: call analyze_mix (and render_spectrogram if useful). After changes, analyze again and compare. If the user names a song they want to sound like, import_reference it and use compare_to_reference.
The studio also reports what the user does: get_events / wait_for_event (phrases they play, selections, edits, questions). The resource openband://project holds the song and notifies subscribers after each change.

Conventions:
- 4/4 time. Bars are 1-based (bar 1 = the very start). One bar = 4 beats.
- Inside a region, note "start" and "duration" are in BEATS relative to the region start (0 = first beat of the region; 0.25 = a 16th note; 0.5 = an 8th).
- Pitches: MIDI numbers (60 = C4 = middle C) or names like "C4", "F#3", "Bb2". On drum tracks use names: kick, snare, clap, rim, hihat, openhat, lowtom, midtom, hightom, crash, ride.
- velocity 0..1. Track volume 0..1 (0.8 = unity), pan -1..1, reverb/delay/tone 0..1.

Typical workflow: get_project → set_tempo/set_key → add_track (list_instruments for ids) → add_drum_pattern / add_chord_progression / add_region with notes → duplicate_region to extend → update_track to mix → transport play.
Prefer few, musically complete calls (e.g. a whole 4-bar melody in one add_region). Always reuse ids returned by previous calls.

Imported sounds: import_sample loads an audio file (local path or URL) and returns a sample_id. Use it to build instruments with create_sampler_instrument (melodic sampler or drum kit), or put it on the timeline with add_audio_region (audio tracks). import_soundfont lists the presets of a .sf2 file, then imports one as an instrument. Imported instruments get ids like "usr_..." that work in add_track / update_track.

Mixing: set_track_effects adds a high-pass, amp sim, 3-band EQ and compressor to a track (compressor.sidechain ducks it under another track, e.g. the bass under the kick); set_master_chain is the mastering chain (EQ, glue, width, true-peak limiter) and reaches a platform's loudness target (platform "spotify", "apple", "club"…) on its own; mix_pilot mixes and masters the whole song for a genre in one step (ask the genre; set_pilot_amount doses it, fix_pilot keeps it; set_track_role corrects a role first); export_for_platforms makes the release zip (a master per platform, stems, instrumental, report); set_automation draws curves for volume, pan, tone, reverb or echo over time (e.g. fades, filter sweeps, auto-pan).
Recording: record_audio records the user's microphone after they confirm (mode "hum" turns a hummed melody into MIDI); audio_to_midi converts an existing monophonic audio region into notes.
Files: export_wav and export_midi download in the browser, or write to disk with save_to; import_midi turns a .mid file into tracks.
Other DAWs: import_dawproject/export_dawproject move songs to and from Bitwig, Studio One and Cubase; report what could not be converted.
Plugins: Web Audio Modules (WAM 2.0) instruments and effects, and in the desktop app the user's installed VST3 / CLAP / AU plugins (list_native_plugins). When the user describes a sound or effect in words, call add_plugin with that description (or search_plugins first to compare options) — installed plugins come first when they fit; then get_plugin_params / set_plugin_params to dial it in. Never install or download plugins: use what is there.

Ensemble: to add a part (drums, an accompaniment, an audio layer) you can describe it with create instead of writing every note: OpenBand picks the engine (its own drummer, chords and CC0 loops, or the OMEP engines the user installed) within the user's licence and privacy policy, sends it the song's tempo, key, sections and harmony, and fits the result to the song. Do not pin an engine unless the user asks. Ask for variants when taste matters: they arrive as takes, offer a blind test (start_ab_test). Report which engine played and what OpenBand corrected. get_ledger tells who made what; never describe engine-made parts as the user's own playing.
Release: when the user wants to put a song out, get_release shows its metadata, licence and what it contains; ask before choosing a licence (Creative Commons cannot be withdrawn), declare imported samples' licences with set_release({sample_licenses}), run check_release and fix what it names, then generate_cover and export_release_kit (render_video makes the video YouTube needs, or a 9:16 Short). publish always waits for the user's click in the studio: tell them, and never claim it is out before it returns a URL. Spotify, Apple Music and the stores need a distributor: OpenBand does not publish there.`;

const Pitch = z.union([z.number().int().min(0).max(127), z.string()]).describe('MIDI number, note name ("C4", "F#3") or drum name ("kick")');
const NoteSchema = z.object({
  pitch: Pitch,
  start: z.number().min(0).describe('Start in beats from region start'),
  duration: z.number().positive().optional().describe('Length in beats (default 1, drums 0.25)'),
  velocity: z.number().min(0).max(1).optional().describe('0..1, default 0.8'),
});
const readOnly = { annotations: { readOnlyHint: true } };

tool('get_project', 'Get the full project: tempo, key, loop, tracks (with ids, instruments, mix) and their regions. Set include_notes to also return every note.', {
  include_notes: z.boolean().optional(),
}, readOnly);

tool('get_status', 'Transport status: playing/recording, playhead position, selection, and whether browser audio is unlocked.', {}, readOnly);

tool('list_instruments', 'List available instrument presets (ids for add_track/update_track), drum piece names and musical keys.', {}, readOnly);

tool('new_project', 'Start a new empty project (the previous one can be restored with undo).', {
  name: z.string().optional(),
  bpm: z.number().min(40).max(240).optional(),
  key: z.string().optional().describe('e.g. "Am", "C", "F#m"'),
});

tool('rename_project', 'Rename the project.', { name: z.string() });
tool('set_tempo', 'Set the tempo in BPM.', { bpm: z.number().min(40).max(240) });
tool('set_key', 'Set the song key shown in the display (e.g. "Am", "Eb"). transpose_audio=true also pitch-shifts every audio clip by the interval between the two keys (the short way).', { key: z.string(), transpose_audio: z.boolean().optional() });
tool('set_master_volume', 'Set the master output volume 0..1 (0.8 = unity).', { volume: z.number().min(0).max(1) });

tool('add_track', 'Add a track. Give an instrument id (preset or imported, see list_instruments) or just a kind ("audio" for audio clips). Returns track_id.', {
  kind: z.enum(['instrument', 'drums', 'audio']).optional(),
  instrument: z.string().optional(),
  name: z.string().optional(),
});

tool('update_track', 'Change a track: name, instrument preset (same kind), volume 0..1, pan -1..1, mute, solo, reverb 0..1, delay 0..1, tone 0..1 (brightness / low-pass), polarity (true = inverted, rendered too).', {
  track_id: z.string(),
  name: z.string().optional(),
  instrument: z.string().optional(),
  volume: z.number().min(0).max(1).optional(),
  pan: z.number().min(-1).max(1).optional(),
  mute: z.boolean().optional(),
  solo: z.boolean().optional(),
  reverb: z.number().min(0).max(1).optional(),
  delay: z.number().min(0).max(1).optional(),
  tone: z.number().min(0).max(1).optional(),
  polarity: z.boolean().optional().describe('Invert the polarity (phase) of the track'),
});

tool(
  'set_track_effects',
  'Set a track\'s insert effects (chain: amp → eq → compressor). Passing a section turns it on unless on:false. amp: drive/tone/level 0..1 (guitar amp + cabinet sim). eq: low/mid/high in dB −15..15, mid_freq 200..6000 Hz. compressor: threshold dB −60..0, ratio 1..20, attack 0.001..0.2 s, release 0.02..1 s, makeup dB 0..24. eq.hpf: a 12 dB/oct high-pass before the EQ (works with the EQ bands off; null removes it). compressor.sidechain: key the compressor with another track (kick → bass), before that track\'s fader and mute; amount 0..1 scales the reduction; null removes it.',
  {
    track_id: z.string(),
    amp: z.object({ on: z.boolean().optional(), drive: z.number().min(0).max(1).optional(), tone: z.number().min(0).max(1).optional(), level: z.number().min(0).max(1).optional() }).optional(),
    eq: z.object({ on: z.boolean().optional(), low: z.number().min(-15).max(15).optional(), mid: z.number().min(-15).max(15).optional(), high: z.number().min(-15).max(15).optional(), mid_freq: z.number().min(200).max(6000).optional(), hpf: z.object({ on: z.boolean().optional(), hz: z.number().min(20).max(2000).optional() }).nullable().optional() }).optional(),
    compressor: z
      .object({ on: z.boolean().optional(), threshold: z.number().min(-60).max(0).optional(), ratio: z.number().min(1).max(20).optional(), attack: z.number().min(0.001).max(0.2).optional(), release: z.number().min(0.02).max(1).optional(), makeup: z.number().min(0).max(24).optional(), sidechain: z.object({ source_track_id: z.string(), amount: z.number().min(0).max(1).optional() }).nullable().optional() })
      .optional(),
  },
);

tool('set_master_chain', 'The master chain, in order: EQ (tilt dB/oct around 1 kHz, low/high shelves, peaking bands) → glue compressor → stereo width (M/S, with everything below mono_below_hz in mono) → true-peak limiter (ceiling in dBTP, loudness target in LUFS). Passing a section turns it on unless on:false. With the limiter on, OpenBand renders the song to find the limiter gain that meets the target (±0.3 LU) and reports loudness and true peak; it says when a target is out of reach. platform sets the target and ceiling: spotify −14/−1, apple −16/−1, youtube −14/−1, soundcloud −11/−1, club −8/−1, cd −9/−0.5. Applies live and to every export.', {
  on: z.boolean().optional(),
  eq: z.object({ on: z.boolean().optional(), tilt: z.number().min(-3).max(3).optional(), low: z.number().min(-12).max(12).optional(), high: z.number().min(-12).max(12).optional(), bands: z.array(z.object({ hz: z.number().min(20).max(20000), gain: z.number().min(-12).max(12), q: z.number().min(0.1).max(10).optional() })).max(8).optional() }).optional(),
  glue: z.object({ on: z.boolean().optional(), threshold: z.number().min(-40).max(0).optional(), ratio: z.number().min(1).max(10).optional(), attack: z.number().min(0.001).max(0.2).optional(), release: z.number().min(0.02).max(1.5).optional(), makeup: z.number().min(0).max(12).optional() }).optional(),
  width: z.object({ on: z.boolean().optional(), amount: z.number().min(0).max(2).optional(), mono_below_hz: z.number().min(20).max(400).optional() }).optional(),
  limiter: z.object({ on: z.boolean().optional(), ceiling_dbtp: z.number().min(-6).max(0).optional(), target_lufs: z.number().min(-30).max(-4).optional(), release_ms: z.number().min(10).max(1000).optional() }).optional(),
  platform: z.enum(['spotify', 'apple', 'youtube', 'soundcloud', 'club', 'cd']).optional(),
}, { timeout: 600000 });

const Platform = z.enum(['spotify', 'apple', 'youtube', 'soundcloud', 'club', 'cd']);
const MixRole = z.enum(['kick', 'drums', 'bass', 'harmony', 'lead', 'vocal', 'texture', 'fx']);
tool('mix_pilot', 'The Mix & Master Pilot: listens to the song (renders each track) and mixes it for a genre — gain staging with trims, balance by role, EQ cuts where tracks mask each other, high-pass filters, kick → bass sidechain, pan by role and register, reverb/echo sends — then masters it (tilt EQ, glue, width, limiter at the platform\'s loudness and true peak). amount 0..1 doses every change (0 = the song as it is, 1 = the full proposal); the loudness target always applies. Roles come from set_track_role when the user set them. use_reference takes the tonal balance from the loaded reference. scope: "mix", "master" or "both" (default). One undo step; returns each change with its reason and the loudness before/after. Running it again starts from the song as it was before the last run, so it never stacks.', {
  amount: z.number().min(0).max(1).optional().describe('Default 0.7'),
  genre: z.enum(['pop', 'rock', 'hiphop', 'lofi', 'edm', 'acoustic', 'ambient', 'jazz']).optional(),
  platform: Platform.optional().describe('Default: the genre\'s (club for edm, apple for acoustic/ambient/jazz, otherwise spotify)'),
  use_reference: z.boolean().optional(),
  scope: z.enum(['mix', 'master', 'both']).optional(),
}, { timeout: 900000 });
tool('set_pilot_amount', 'Turn the mix pilot\'s dose after a run: 0 = the song as it was before, 1 = the full proposal. Re-finds the limiter gain for the loudness target.', { amount: z.number().min(0).max(1) }, { timeout: 600000 });
tool('fix_pilot', 'Keep the mix pilot\'s result as it is now: the dose stops being adjustable (the changes stay, and can be undone).', {});
tool('set_track_role', 'The role of a track in the mix, used by mix_pilot and by the stems of export_for_platforms: kick, drums, bass, harmony, lead, vocal, texture or fx. null goes back to automatic. A role the user sets survives every pilot run.', { track_id: z.string(), role: MixRole.nullable() });
add('export', 'export_for_platforms', 'Export the song for release in one zip: a master WAV per platform at its loudness and true peak (24-bit; 16-bit with TPDF dither for cd), optionally stems by role (drums, bass, harmony, lead, vocal, fx) and the instrumental / a-cappella versions — through the same master chain with the limiter linked to the full mix, so the stems add up to the master — and report.txt (LUFS, true peak, LRA, compliance per platform).', {
  platforms: z.array(Platform).min(1),
  stems: z.boolean().optional(),
  versions: z.array(z.enum(['instrumental', 'acapella'])).optional(),
  save_to: z.string().optional().describe('Optional file path to save the zip to (absolute or ~/...). Without it the browser downloads it.'),
}, { timeout: 900000 });

const AutoTargetArg = z
  .union([
    z.object({ kind: z.literal('mix'), param: z.enum(['volume', 'pan', 'tone', 'reverb', 'echo']) }),
    z.object({ kind: z.literal('fx'), unit: z.enum(['amp', 'eq', 'comp']), param: z.string().describe('amp: drive, tone, level · eq: low, mid, high (dB), midFreq (Hz) · comp: threshold, makeup (dB), ratio, attack, release (s)') }),
    z.object({ kind: z.literal('plugin'), slot_id: z.string().nullable().describe('The plugin effect slot, or null for the track\'s plugin instrument'), param_id: z.string() }),
  ])
  .describe('What to automate (list_automatable shows every target of a track with its range)');

tool(
  'set_automation',
  'Draw an automation curve on a track: a mix parameter with param (volume 0..1 with 0.8 = unity, pan -1..1, tone/reverb/echo 0..1), or any target — a built-in effect parameter (e.g. {kind:"fx", unit:"eq", param:"midFreq"} for a filter sweep in Hz) or a plugin parameter ({kind:"plugin", slot_id, param_id}) — with values in that parameter\'s own range. Points are {bar (1-based, fractional ok) or beat (0-based from song start), value}; values are interpolated linearly and held before the first / after the last point. Replaces the curve unless replace is false. Example fade-in: param "volume", [{bar:1,value:0},{bar:3,value:0.8}].',
  {
    track_id: z.string(),
    param: z.enum(['volume', 'pan', 'tone', 'reverb', 'echo']).optional(),
    target: AutoTargetArg.optional(),
    points: z.array(z.object({ bar: z.number().min(1).optional(), beat: z.number().min(0).optional(), value: z.number() })).min(1),
    replace: z.boolean().optional(),
  },
);

tool('clear_automation', 'Remove the automation curve of one parameter or target (or all of them) from a track, returning to the static value.', {
  track_id: z.string(),
  param: z.enum(['volume', 'pan', 'tone', 'reverb', 'echo']).optional(),
  target: AutoTargetArg.optional(),
});

tool('list_automatable', 'Everything on a track that can be automated: the mix, the built-in effects (with ranges and units) and the parameters of its loaded plugins, marking those that already have a curve. Use the targets with set_automation.', { track_id: z.string() }, readOnly);

tool('delete_track', 'Delete a track and all its regions.', { track_id: z.string() });

tool('add_region', 'Create a region (MIDI clip) on a track, optionally with notes. If length_bars is omitted it fits the notes. Returns region_id.', {
  track_id: z.string(),
  start_bar: z.number().min(1).optional().describe('1-based bar, may be fractional'),
  length_bars: z.number().positive().optional(),
  name: z.string().optional(),
  notes: z.array(NoteSchema).optional(),
});

tool('update_region', 'Move, resize, rename a region or move it to another track of the same kind. For audio regions also gain (0..2, 1 = unchanged), offset_seconds (where playback starts inside the sample), time-stretch — stretch_mode "follow_tempo" (the clip follows the song tempo from original_bpm; detect_tempo finds it), "fixed" with ratio (played length / original, 0.25–4) or "off" — and pitch in semitones (decimals = cents), both without changing the other.', {
  region_id: z.string(),
  start_bar: z.number().min(1).optional(),
  length_bars: z.number().positive().optional(),
  name: z.string().optional(),
  track_id: z.string().optional(),
  gain: z.number().min(0).max(2).optional(),
  offset_seconds: z.number().min(0).optional(),
  stretch_mode: z.enum(['off', 'follow_tempo', 'fixed']).optional(),
  ratio: z.number().min(0.25).max(4).optional(),
  original_bpm: z.number().min(40).max(240).optional(),
  pitch: z.number().min(-24).max(24).optional(),
});

tool('detect_tempo', 'Estimate the tempo of an audio sample (a loop): from its file name ("loop_92bpm.wav") or its onsets. Stored on the clips of that sample as their original tempo; apply=true also makes them follow the song tempo.', {
  sample_id: z.string().optional(),
  region_id: z.string().optional(),
  apply: z.boolean().optional(),
});

tool('delete_region', 'Delete a region.', { region_id: z.string() });

tool('duplicate_region', 'Repeat a region right after itself `times` times (default 1). Great for extending loops.', {
  region_id: z.string(),
  times: z.number().int().min(1).max(64).optional(),
});

tool('get_region_notes', 'Get all notes of a region (beats relative to region start).', { region_id: z.string() }, readOnly);

tool('suggest_continuation', 'Ghost notes: OpenBand\'s own musical autocomplete — local, instant, no LLM. For a region it suggests (best first, with the reasons): continue the melody (the rest of the bar and the next), a bass line under the chords, harmonize a melody (3 progressions, for a new harmony track), a counter-melody, a variation of the track\'s motif for an empty section, or for drums the rest of the groove / a fill. kind is chosen from the context when omitted. Use them as a quick draft to refine, then add_notes.', {
  region_id: z.string(),
  kind: z.enum(['continue', 'bass', 'harmonize', 'counter', 'variation', 'drum_fill']).optional(),
  count: z.number().int().min(1).max(8).optional(),
  seed: z.number().int().optional().describe('Another seed gives other ideas'),
  note_ids: z.array(z.string()).optional().describe('Harmonize / counter: only these notes (a selection)'),
}, readOnly);

tool('add_notes', 'Add notes to an existing region (replace: true to overwrite all notes). The region grows to fit unless extend is false.', {
  region_id: z.string(),
  notes: z.array(NoteSchema),
  replace: z.boolean().optional(),
  extend: z.boolean().optional(),
});

tool('remove_notes', 'Remove notes from a region, filtered by note_ids and/or pitch and/or beat range [from_beat, to_beat). With no filter it clears the region.', {
  region_id: z.string(),
  note_ids: z.array(z.string()).optional(),
  pitch: Pitch.optional(),
  from_beat: z.number().optional(),
  to_beat: z.number().optional(),
});

tool('update_notes', 'Change existing notes in place (keeping their ids): pitch, start (beats from region start), duration, velocity. Only the given fields change.', {
  region_id: z.string(),
  notes: z.array(z.object({ id: z.string(), pitch: Pitch.optional(), start: z.number().min(0).optional(), duration: z.number().positive().optional(), velocity: z.number().min(0).max(1).optional() })).min(1),
});

tool('transpose_region', 'Transpose all notes in a region by semitones.', { region_id: z.string(), semitones: z.number().int().min(-48).max(48) });

const quantizeShape = {
  grid: z.number().positive().optional().describe('Grid in beats: 1 = quarter, 0.5 = 8th, 0.25 = 16th (default), 0.125 = 32nd, 1/3 and 1/6 = triplets'),
  strength: z.number().min(0).max(1).optional().describe('How far notes move towards the grid, 0..1 (default 1; 0.5 keeps some feel)'),
  swing: z.number().min(0).max(0.75).optional().describe('Off-beat grid points this much later, as a share of the grid (0.33 ≈ triplet swing)'),
  ends: z.boolean().optional().describe('Quantize note ends too (default true)'),
};
tool('cover_song', 'A cover of a song in the studio: its audio (an imported track or a recording: region_id, or the selected / only audio region) played again in another style by a music engine that can restyle (ACE-Step on this computer, or on fal online — the audio is uploaded there). The result is a take of that region, to compare with the original. strength: how close to the original, 0..1 (default 0.5).', {
  region_id: z.string().optional(),
  style: z.string().describe('The style of the cover, in words: "acoustic bossa nova", "80s synth-pop", "string quartet"'),
  strength: z.number().min(0).max(1).optional(),
  variants: z.number().int().min(1).max(4).optional(),
  engine: z.string().optional().describe('Pin an engine by id (list_engines)'),
  confirm_spend: z.boolean().optional().describe('Online engines past the budget: only after the user agreed to the quoted cost'),
}, { timeout: 900000 });
tool('set_track_midi_input', 'Which live MIDI a track plays: a channel (1–16), optionally only from one device (by name), even when the track is not selected; null to follow the selection again. With several tracks on their channels one keyboard — or a MIDI orchestrator such as Texturium sending 16 channels on one port — plays them all at once.', {
  track_id: z.string(),
  channel: z.number().int().min(1).max(16).nullable(),
  device: z.string().optional().describe('Only from this MIDI input (its name); any device without'),
});
tool('map_midi_channels', 'Multitimbral setup in one call: channels 1–16 to the instrument and drum tracks in their order (optionally from one device), or clear: true to have every track follow the selection again.', {
  device: z.string().optional(),
  clear: z.boolean().optional(),
});
tool('quantize_region', 'Quantize the notes of a MIDI region to the song\'s grid: in full or by a strength, with swing, ends too. One undo step.', {
  region_id: z.string(),
  ...quantizeShape,
});
tool('quantize_track', 'Quantize every MIDI region of a track (instrument or drums), or only the notes between from_bar and to_bar: same options as quantize_region. One undo step.', {
  track_id: z.string(),
  ...quantizeShape,
  from_bar: z.number().int().min(1).optional(),
  to_bar: z.number().int().min(1).optional(),
});

tool(
  'add_drum_pattern',
  'Create a drum region from step strings on a drums track. Each key is a drum piece, each value a step string: "x" hit, "X" accent, "o" ghost, "." or "-" rest. Spaces and "|" are ignored. Strings repeat to fill `bars`. Example (16 steps/bar): {"kick":"x...x...x...x...","snare":"....x.......x...","hihat":"x.x.x.x.x.x.x.x."}',
  {
    track_id: z.string(),
    pattern: z.record(z.string(), z.string()),
    start_bar: z.number().min(1).optional(),
    bars: z.number().int().min(1).max(64).optional(),
    steps_per_bar: z.number().int().min(1).max(64).optional().describe('default 16; use 12 or 24 for triplet feels'),
    name: z.string().optional(),
  },
);

tool(
  'add_chord_progression',
  'Create a region of chords on an instrument track from chord symbols (C, Am, F#m7, Bbmaj7, Dsus4, G7, Cadd9, C/E, Bdim, Eaug, ...). Use "-" for a rest. style: block (sustained), arpeggio (8th notes), stabs (off-beat hits).',
  {
    track_id: z.string(),
    chords: z.array(z.string()).min(1),
    start_bar: z.number().min(1).optional(),
    beats_per_chord: z.number().positive().optional().describe('default 4 (one bar per chord)'),
    octave: z.number().int().min(1).max(6).optional().describe('octave of the chord root, default 3'),
    style: z.enum(['block', 'arpeggio', 'stabs']).optional(),
    velocity: z.number().min(0).max(1).optional(),
    name: z.string().optional(),
  },
);

tool('transport', 'Control playback: play, stop, toggle or rewind. Optionally jump to from_bar first.', {
  action: z.enum(['play', 'stop', 'toggle', 'rewind']),
  from_bar: z.number().min(1).optional(),
});

tool('set_loop', 'Set the cycle (loop) range in bars; end_bar is exclusive (1..5 loops bars 1-4).', {
  enabled: z.boolean().optional(),
  start_bar: z.number().min(1).optional(),
  end_bar: z.number().min(1).optional(),
});

tool('set_metronome', 'Turn the metronome click on or off.', { enabled: z.boolean() });
tool('open_editor', 'Select a region and show it in the piano roll / step editor so the user can see it.', { region_id: z.string() });
tool('undo', 'Undo the last change (one whole begin_change…end_change step, or one user edit). steps undoes several.', { steps: z.number().int().min(1).max(100).optional() });
tool('redo', 'Redo the last undone change.', { steps: z.number().int().min(1).max(100).optional() });
tool('begin_change', 'Start one undoable change and name it after the user\'s request (e.g. "Lo-fi beat in D minor"). Every command until end_change becomes a single undo step. Closes any change still open.', { label: z.string() });
tool('end_change', 'Close the change opened with begin_change. Returns its label and how many commands it grouped.', {});
tool('get_history', 'The undo history: past and future steps with label, source (ui/ai) and number of commands, plus the change currently open.', { limit: z.number().int().min(1).max(200).optional() }, readOnly);
tool('export_project_json', 'Export the complete project as JSON (for saving or analysis). canonical: true gives deterministic JSON (sorted keys, rounded numbers, sorted notes) for versioning songs with git.', {
  canonical: z.boolean().optional(),
}, readOnly);
tool('import_project_json', 'Replace the current project with an OpenBand project JSON (as produced by export_project_json).', {
  project: z.union([z.string(), z.record(z.string(), z.any())]),
});

exportTool('export_wav', 'Render the whole song offline (instruments, imported sounds, audio tracks, effects and automation) as a stereo WAV: 44.1 kHz 16-bit by default, or another sample rate and bit depth (24-bit, or 32-bit float that never clips). For release-ready masters at each platform\'s loudness use export_for_platforms.', {
  sample_rate: z.union([z.literal(44100), z.literal(48000), z.literal(88200), z.literal(96000)]).optional().describe('Hz (default 44100)'),
  bit_depth: z.union([z.literal(16), z.literal(24), z.literal(32)]).optional().describe('16 (default), 24, or 32 = 32-bit float'),
  dither: z.boolean().optional().describe('TPDF dither at 16 bits (default on)'),
});
exportTool('export_midi', 'Export the song as a Standard MIDI File (format 1): one track per instrument/drum track with General MIDI programs, drums on channel 10. Audio tracks are not included.');
fileTool('import_midi', 'Import a MIDI file (.mid): each part becomes a track with the closest OpenBand instrument (channel 10 → drums). Adds to the current song unless replace is true; the song tempo is used when the project is empty or replaced.', {
  replace: z.boolean().optional(),
});

fileTool('import_dawproject', 'Open a .dawproject file (the open format of Bitwig Studio, Studio One and Cubase): tracks with the closest OpenBand instruments, note and audio clips, markers as sections, volume/pan automation, mixer settings, built-in EQ and compressor. Replaces the song by default (a version of the current one is saved first); replace=false adds its tracks. Returns what could not be converted (plugins, other automation, tempo changes…): tell the user.', {
  replace: z.boolean().optional(),
});

exportTool('export_dawproject', 'Export the song as a .dawproject (with its audio) to open it in Bitwig Studio, Studio One or Cubase. OpenBand-only parts (lyrics, takes, comments, plugins) travel inside it for OpenBand and are listed in the result.');

// ---- song structure

const SectionKind = z.enum(['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'solo', 'breakdown', 'outro', 'custom']);
tool('get_structure', 'The song\'s sections (id, name, kind, start_bar, length_bars) with an energy profile each: active tracks, notes per bar (total and per track), mean velocity and register, and loudness when a full analysis is cached.', {}, readOnly);
tool('add_section', 'Mark a section of the song (sections never overlap).', { name: z.string(), kind: SectionKind, start_bar: z.number().min(1), length_bars: z.number().positive() });
tool('update_section', 'Rename, re-type, move or resize a section marker (content is not moved; use move_section for that).', {
  section_id: z.string(), name: z.string().optional(), kind: SectionKind.optional(), start_bar: z.number().min(1).optional(), length_bars: z.number().positive().optional(),
});
tool('delete_section', 'Remove a section marker; with delete_content also the music inside it (regions are split at the boundaries).', { section_id: z.string(), delete_content: z.boolean().optional() });
tool('move_section', 'Move a section WITH its content (regions split at the boundaries, automation follows) so it starts at to_bar (bar on the current timeline, e.g. the bar after another section). With ripple (default) the rest of the song closes the gap and makes room.', {
  section_id: z.string(), to_bar: z.number().min(1), ripple: z.boolean().optional(),
});
tool('duplicate_section', 'Copy a section with its content, by default right after itself ("one more chorus"), or at to_bar. With ripple (default) what follows moves later.', {
  section_id: z.string(), to_bar: z.number().min(1).optional(), ripple: z.boolean().optional(),
});
tool('split_region', 'Split a region in two at a bar (or beat): notes crossing the cut are shortened, later notes go to the new region.', {
  region_id: z.string(), at_bar: z.number().min(1).optional(), at_beat: z.number().min(0).optional(),
});
tool('auto_sections', 'Propose sections (intro, verse, chorus…) from repetitions in the music and silences. Changes nothing: add the ones you like with add_section.', {}, readOnly);

// ---- draw the song (G2): energy over time → a whole arrangement
tool('set_energy_curve', 'Draw how the song\'s energy should go over time: points [{bar (1-based), energy 0..1}] or a shape — pop (intro, verse, chorus, verse, chorus, bridge, big last chorus, outro), slow_build, edm_drop, ballad. Length: length_bars, or seconds (e.g. 210 for 3:30 at the song\'s tempo). Then arrange_from_energy.', {
  points: z.array(z.object({ bar: z.number(), energy: z.number().min(0).max(1) })).optional(),
  shape: z.enum(['pop', 'slow_build', 'edm_drop', 'ballad']).optional(),
  length_bars: z.number().int().min(4).max(512).optional(),
  seconds: z.number().min(10).max(1800).optional(),
});
tool('get_energy', 'The energy curve per bar: the one drawn (set_energy_curve) and the one the song has now, measured from who plays, how much and how loud (0..1).', {}, readOnly);
tool('arrange_from_energy', 'Build the whole arrangement from the drawn energy curve and the material there is (e.g. an 8-bar loop): sections where the curve changes (intro, verse, chorus, bridge, outro), layers that come in with the energy, the drummer busier and louder, the lead doubled an octave up on the peaks, the filter opening in crescendos, more reverb in the valleys, the second verse with one layer more, transitions (riser, downlifter, reverse cymbal, fill, a stop before a drop, impact) and an ending. The user\'s notes are never changed. By default on a new branch arrangement-<n>, opened in compare view. Same seed, same result.', {
  seed: z.number().int().optional(),
  genre: z.string().optional().describe('Drummer style for regenerated drums: pop, rock, funk, house, edm, hiphop, trap, ballad, lofi…'),
  as_branch: z.boolean().optional(),
  keep_sections: z.boolean().optional().describe('Reuse the song\'s sections: a new verse plays the old verse\'s material'),
  modulate: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional().describe('Raise the last chorus by 1 or 2 semitones'),
}, { timeout: 60000 });
tool('add_transition', 'Add one transition at a bar: riser and reverse_cymbal end on it, downlifter and impact start on it (audio, synthesized, on the "FX transitions" track); fill = a drum fill in the last two beats before it; stop = a bar of silence there.', {
  at_bar: z.number().int().min(1),
  kind: z.enum(['riser', 'downlifter', 'reverse_cymbal', 'fill', 'stop', 'impact']),
  bars: z.number().int().min(1).max(8).optional(),
}, { timeout: 30000 });

// ---- lyrics

tool('set_lyrics', 'Write lyrics: text with one line per verse line ("\\n" separated). For a section (section_id) its lines are replaced; with line_ids those lines are rewritten; otherwise all lyrics. Italian lyrics get metric syllables with synalepha; mark a melisma with "_" after a syllable. Lines are re-aligned to the melody if a melody track is set.', {
  text: z.string(), section_id: z.string().optional(), line_ids: z.array(z.string()).optional(), language: z.enum(['it', 'en']).optional(),
});
tool('get_lyrics', 'The lyrics: lines with syllables (stressed or not), the bar and note each syllable sits on, and whether each line is aligned.', { section_id: z.string().optional() }, readOnly);
tool('align_lyrics', 'Put the syllables on the notes of the melody track, in order (per section when lines belong to sections). Returns syllables or notes left over and the number of prosody issues.', {
  melody_track_id: z.string(), section_id: z.string().optional(),
});
tool('check_prosody', 'Check that melody and words fit: syllables vs notes per phrase, stressed syllables on weak beats, long notes on unstressed endings, words cut by rests.', { section_id: z.string().optional() }, readOnly);
tool('suggest_melody_rhythm', 'A rhythm for a lyric line (start and duration in beats per syllable) with stressed syllables on beats and a long final note — a starting point to write the melody with add_region / add_notes.', { line_id: z.string() }, readOnly);
special('export_chord_sheet', 'Export a chord sheet built from sections, the detected chords and the lyrics: ChordPro (.cho) or plain text with chords over the lyrics. Returns the text; with save_to it is also written to that path, otherwise the browser downloads it.', { format: z.enum(['chordpro', 'txt']).optional(), save_to: z.string().optional() }, 'chord_sheet', readOnly);

// ---- musical linter

const Severity = z.enum(['info', 'warn', 'error']);
tool(
  'lint_project',
  'Check the song for musical problems: notes out of key, overlapping notes/regions, notes past the region end, low-end clashes, crowded registers, mechanical velocity/timing, empty tracks, panned bass, gaps between sections; with include_audio also clipping, headroom, low-end masking and phase (renders the mix). Each issue has a stable id, a target and often an automatic fix.',
  { rules: z.array(z.string()).optional(), include_audio: z.boolean().optional(), min_severity: Severity.optional() },
  { ...readOnly, timeout: 180000 },
);
tool('apply_fix', 'Apply the automatic fix of a lint issue (one undo step). Returns what was done.', { issue_id: z.string() });
tool('ignore_issue', 'Stop reporting a lint issue for this song (stored in the project).', { issue_id: z.string() });

// ---- listening: mix analysis

const RangeArgs = {
  from_bar: z.number().min(1).optional(),
  to_bar: z.number().min(1).optional().describe('exclusive'),
  section_id: z.string().optional(),
};

tool(
  'analyze_mix',
  'LISTEN to the mix: renders the song (or a bar range / section) and measures it. Returns master loudness (integrated/short-term LUFS, LRA, true peak, crest), stereo (correlation, width, mono loss), energy per band (sub, bass, lowmid, mid, highmid, presence, air), per-track loudness/peak/dominant band/share of the mix, masking between tracks, the detected key, and concrete issues with suggestions. detail "full" adds 1/3-octave curves and loudness per bar.',
  { ...RangeArgs, per_track: z.boolean().optional().describe('default true'), detail: z.enum(['summary', 'full']).optional() },
  { ...readOnly, timeout: 180000 },
);

special('render_spectrogram', 'Render a spectrogram image (log frequency 30 Hz–16 kHz, bar grid, section names) of the mix or of one track, so you can SEE the arrangement: where instruments sit, density, gaps, harshness.', { ...RangeArgs, track_id: z.string().optional(), width: z.number().int().min(256).max(2048).optional(), height: z.number().int().min(128).max(1024).optional() }, 'image', readOnly);

tool('analyze_harmony', 'Chords of the MIDI parts (per bar, or per half bar when they change), with Roman numerals in the project key (I, ii7, V7/V, bVII…), harmonic function and confidence, plus cadences (authentic, plagal, ii–V–I, deceptive, half) — at section ends when sections exist. Drums are excluded.', {
  ...RangeArgs, track_ids: z.array(z.string()).optional(),
}, readOnly);

tool('detect_key', 'Detect the key of the music from the MIDI notes, from the audio tracks, or both. Returns key, confidence, alternatives and whether it matches the project key.', {
  source: z.enum(['midi', 'audio', 'both']).optional(),
}, { ...readOnly, timeout: 180000 });

// ---- multiplayer rooms

tool('create_room', 'Open a multiplayer room for this song and return a link to share (plus the password, if you set one, which the user must share separately). via "lan" uses this server as relay (needs OPENBAND_COLLAB=1, people on the same network), "p2p" connects browsers directly (WebRTC). Your commands keep working: you act through this browser and everyone sees the changes; undo only takes back each person\'s own work.', {
  password: z.string().optional(),
  via: z.enum(['lan', 'p2p']).optional(),
}, { timeout: 30000 });

tool('join_room', 'Join an existing multiplayer room (the room name from a link, and its password if it has one). The song of the room replaces the open one.', {
  room: z.string(),
  password: z.string().optional(),
  via: z.enum(['lan', 'p2p']).optional(),
}, { timeout: 30000 });

tool('leave_room', 'Leave the multiplayer room (the song stays open locally).', {});

tool('get_peers', 'Who is in the room: names, who hosts, who has an AI connected, the track each person has selected, and where their playhead is.', {}, readOnly);

// ---- jam: call-and-response

tool('play_phrase', 'Answer what the user played: the notes (beats from the phrase start, like add_region) are played live on a track at the next musical window — next_bar (default), next_loop (the cycle start) or {bar} — never earlier, and if your answer arrives too late it moves to the following window. The notes are NOT added to the song unless commit:true (the user can also press Keep). Returns its phrase_id (for keep_phrase) and when it will start.', {
  track_id: z.string().optional().describe('Default: the jam response track'),
  notes: z.array(NoteSchema),
  at: z.union([z.enum(['next_bar', 'next_loop']), z.object({ bar: z.number().int().min(1) })]).optional(),
  commit: z.boolean().optional(),
});

tool('set_jam_mode', 'Turn jam (call-and-response) mode on or off: the studio shows that you are listening, and play_phrase defaults to response_track_id and window. Then loop: wait_for_event({kinds:["phrase"]}) → compose an answer → play_phrase.', {
  enabled: z.boolean(),
  response_track_id: z.string().optional(),
  window: z.enum(['next_bar', 'next_loop']).optional(),
});

tool('keep_answer', 'Keep the last answer played with play_phrase: its notes are added to the song (one undo step).', {});

tool('keep_phrase', 'Keep one of the recent answers (the phrase_id returned by play_phrase, up to 20 back): its notes are added to the song where they were played (one undo step).', { phrase_id: z.string() });

// ---- versions and branches

tool('save_version', 'Save the current state of the song as a version on the current branch (like a commit). Do it before big changes, so the user can go back.', { label: z.string().optional() });

tool('list_versions', 'List saved versions (newest first) with branch, label, author, parents, which one is HEAD, and whether there are unsaved changes.', { branch: z.string().optional() }, readOnly);

tool('create_branch', 'Create a branch (an alternative direction for the song) from a version (default: HEAD). It does not switch to it: call checkout.', {
  name: z.string(),
  from_version_id: z.string().optional(),
});

tool('checkout', 'Switch the song to a branch (its latest version) or to a version. Unsaved changes are saved first as a "WIP" version. Undoable.', {
  branch: z.string().optional(),
  version_id: z.string().optional(),
});

tool('diff_versions', 'What changed between two versions (ids, branch names or "HEAD"); b defaults to the current state. Returns a readable summary ("Bass: 12 notes changed in Chorus; tempo 82→86") and structured changes.', {
  a: z.string(),
  b: z.string().optional(),
}, readOnly);

tool('merge', 'Three-way merge of a branch into the current one: changes made on only one side are combined; when both changed the same thing it is a conflict. strategy: manual (default: conflicts are returned and our side is kept), ours or theirs. pick resolves specific entities, e.g. [{entity:"region", id:"rgn_x", from:"b"}] = take that region from the other branch; for a track field use id "trk_x.volume"; project fields by name ("bpm"). Without conflicts a merge version is saved.', {
  from_branch: z.string(),
  strategy: z.enum(['manual', 'ours', 'theirs']).optional(),
  pick: z.array(z.object({ entity: z.enum(['project', 'track', 'region', 'section', 'lyrics', 'instrument', 'annotation']), id: z.string(), from: z.enum(['a', 'b']) })).optional(),
});

// ---- annotations ("Explain" mode)

const TargetSchema = z.object({
  type: z.enum(['project', 'track', 'region', 'notes', 'section', 'range']),
  id: z.string().optional().describe('track/region/section id (for notes: the region, optional)'),
  note_ids: z.array(z.string()).optional(),
  from_beat: z.number().min(0).optional(),
  to_beat: z.number().min(0).optional(),
}).describe('What the annotation is about. Ranges are in beats from the song start (bar n starts at beat (n-1)*4).');

tool('annotate', 'Attach a short explanation (markdown, max 500 characters) to part of the song: why a chord, voicing, rhythm or mix choice works. It appears as a pin on the arrangement / piano roll and in the Comments panel. Answer "Explain" questions (ask events with context.explain) this way.', {
  target: TargetSchema.optional().describe('What it is about (not needed with reply_to)'),
  text: z.string().max(500),
  reply_to: z.string().optional().describe('Answer this annotation (same thread; target is then taken from it)'),
});

tool('list_annotations', 'List annotations (optionally only those about a target; resolved ones only with include_resolved). Annotations whose target was deleted are marked orphaned.', {
  target: TargetSchema.partial().optional(),
  include_resolved: z.boolean().optional(),
}, readOnly);

tool('resolve_annotation', 'Mark an annotation as resolved (or resolved=false to reopen it).', { annotation_id: z.string(), resolved: z.boolean().optional() });

tool('delete_annotation', 'Delete an annotation.', { annotation_id: z.string() });

// ---- takes

const NotesArg = z.array(NoteSchema);

tool('add_take', 'Add an alternative version (take) of a MIDI region, e.g. 4 bass variations = 4 add_take calls inside one begin_change. The region\'s current content becomes "Take 1" the first time. The new take becomes active unless activate=false. Notes as in add_region (beats from the region start).', {
  region_id: z.string(),
  notes: NotesArg,
  name: z.string().optional(),
  activate: z.boolean().optional(),
});

tool('list_takes', 'List the takes of a region (id, name, author, number of notes, which is active).', { region_id: z.string() }, readOnly);

tool('set_active_take', 'Make a take the one that plays (by id or name).', { region_id: z.string(), take_id: z.string() });

tool('delete_take', 'Delete a take from a region.', { region_id: z.string(), take_id: z.string() });

tool('comp_takes', 'Build a "Comp" take from stretches of several takes: segments [{from_beat, to_beat, take_id}] in beats from the region start, non-overlapping. Notes are cut at the segment boundaries. The comp becomes active.', {
  region_id: z.string(),
  segments: z.array(z.object({ from_beat: z.number().min(0), to_beat: z.number().min(0), take_id: z.string() })).min(1),
  name: z.string().optional(),
});

tool('start_ab_test', 'Open a blind A/B listening test of 2–4 takes of a region (default: its last 4): the user hears them as A/B/C/D in random order while the region loops, ranks them, and only then sees the names. Returns test_id. The result arrives as an "ab_result" event with the take ids ranked best first (empty if cancelled): wait_for_event({kinds:["ab_result"]}).', {
  region_id: z.string(),
  take_ids: z.array(z.string()).min(2).max(4).optional(),
  loop: z.boolean().optional(),
}, readOnly);

// ---- safety net: journal and time machine

const Time = z.union([z.string(), z.number()]).describe('ISO date-time ("2026-10-20T14:32:00"), ms since epoch, or relative: "-20m", "-2h", "-90s"');

tool('get_timeline', 'Every step journaled for this song (edits, AI requests, undo/redo, loads) with its time, plus checkpoints — the time machine works without saved versions. Optional from/to.', {
  from: Time.optional(),
  to: Time.optional(),
}, readOnly);

tool('preview_at', 'The song as it was at a moment (summary like get_project), without changing anything. E.g. time "-20m" for twenty minutes ago.', { time: Time }, readOnly);

tool('restore_at', 'Go back to how the song was at a moment: replaces the song (one undo step; a version of the current state is saved first), or with as_branch (true or a name) opens it as a new branch instead.', {
  time: Time,
  as_branch: z.union([z.boolean(), z.string()]).optional(),
});

// ---- drummer

const DrumStyleArg = z.enum(['rock', 'pop', 'funk', 'boom-bap', 'trap', 'lo-fi', 'house', 'bossa', 'ballad', 'shuffle']);

tool('add_drummer', 'A human-like drum part, generated (not by you: a fast, repeatable drummer): a style, complexity 0..1 (bare groove → every variation), loudness 0..1, swing 0..1, fills ("end_of_section" default, "every_4" bars, "none") and a seed. It follows the song: simpler in verses, fuller in choruses, with fills before each new section and a crash after. For one section (section_id), a range (from_bar…to_bar) or the whole song. Uses the drum track (or creates one with a kit for the style). For alternatives use regenerate_drummer with as_take.', {
  track_id: z.string().optional(),
  section_id: z.string().optional(),
  from_bar: z.number().int().min(1).optional(),
  to_bar: z.number().int().min(1).optional().describe('Last bar played (inclusive)'),
  style: DrumStyleArg,
  complexity: z.number().min(0).max(1).optional(),
  loudness: z.number().min(0).max(1).optional(),
  swing: z.number().min(0).max(1).optional(),
  fills: z.enum(['none', 'end_of_section', 'every_4']).optional(),
  seed: z.number().int().optional(),
});

tool('regenerate_drummer', 'Play a drummer region again with a new seed (default: the next one) and optionally another style/complexity/loudness/swing/fills; as_take=true keeps the old version as a take (compare them with start_ab_test).', {
  region_id: z.string(),
  seed: z.number().int().optional(),
  as_take: z.boolean().optional(),
  style: DrumStyleArg.optional(),
  complexity: z.number().min(0).max(1).optional(),
  loudness: z.number().min(0).max(1).optional(),
  swing: z.number().min(0).max(1).optional(),
  fills: z.enum(['none', 'end_of_section', 'every_4']).optional(),
});

// ---- loop library

tool('search_loops', 'Search the CC0 loop library (drums, bass, keys, pads… made for OpenBand, free to use): words matched on name and tags (e.g. "funk drums", "lo-fi keys"), bpm keeps loops within 15% of it, key prefers that key. Loops follow the song tempo when added, so any tempo works.', {
  query: z.string().optional(),
  bpm: z.number().min(40).max(240).optional(),
  key: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
}, readOnly);

tool('add_loop', 'Add a loop from the library as an audio clip at start_bar (default: the playhead\'s bar): it follows the song tempo (follow_tempo, default true) and, when it has a key, is transposed to the song key (match_key, default true; same mode only). repeat places it several times in a row. Creates an audio track unless track_id is given.', {
  loop_id: z.string(),
  track_id: z.string().optional(),
  start_bar: z.number().int().min(1).optional(),
  repeat: z.number().int().min(1).max(16).optional(),
  follow_tempo: z.boolean().optional(),
  match_key: z.boolean().optional(),
}, { timeout: 60000 });

// ---- monitoring

tool('get_meters', 'Live loudness of the master and of each track while the song plays: momentary (400 ms), short-term (3 s) and integrated LUFS since the last reset, true peak (dBTP, last 400 ms and highest), the loudness target and whether the master meets it (green/yellow/red). Start playback first and wait 3 s for short-term values.', {}, readOnly);

tool('set_monitoring', 'What the user hears, never what is exported: mono (L+R summed, to check mono compatibility), dim (speakers −20 dB), the loudness target of the meter (streaming −14, apple −16, broadcast −23, club −8 LUFS), reset_meters (integrated loudness and true-peak hold start again).', {
  mono: z.boolean().optional(),
  dim: z.boolean().optional(),
  target: z.enum(['streaming', 'apple', 'broadcast', 'club']).optional(),
  reset_meters: z.boolean().optional(),
});

tool('level_match', 'How much louder (+) or quieter (−) a track\'s effect chain — or one plugin slot — makes it, measured offline over 3 s from the playhead (or the track\'s first region). Louder always sounds "better": call this before judging whether an effect helps. apply=true makes the compensation permanent (the chain output trim). Returns gain_change_db.', {
  track_id: z.string(),
  slot_id: z.string().optional().describe('One plugin slot; omit for the whole chain (amp, EQ, compressor, plugins)'),
  apply: z.boolean().optional(),
}, { timeout: 120000 });

// ---- flub markers

tool('add_flub', 'Mark a point of the song: kind "flub" (a mistake to fix, default), "good" (a part worth keeping) or "note". Without beat/bar it marks the playhead; during a recording the mark is bound to the take being recorded. The user marks flubs with F/G or a MIDI pedal while recording.', {
  beat: z.number().min(0).optional().describe('Beat on the timeline (0 = the start)'),
  bar: z.number().min(1).optional().describe('1-based bar, may be fractional (2.5 = middle of bar 2)'),
  kind: z.enum(['flub', 'good', 'note']).optional(),
  text: z.string().max(200).optional(),
  track_id: z.string().optional(),
});

tool('list_flubs', 'List the marks left while recording (where the user made mistakes, or liked a part), with their bar, track, region and take. Offer to fix the open ones: replace_with_best_take, re-record, or edit the notes.', {
  unresolved_only: z.boolean().optional(),
}, readOnly);

tool('resolve_flub', 'Mark a flub as fixed (or open again with resolved=false).', { flub_id: z.string(), resolved: z.boolean().optional() });

tool('delete_flub', 'Delete a flub mark.', { flub_id: z.string() });

tool('replace_with_best_take', 'Fix a flub from the other takes of its region: picks the take with no mistake within ±1 beat of the flub and the most "good" marks, and comps it in over the bars around the flub (audio takes switch as a whole). The flub is marked resolved.', { flub_id: z.string() });

// ---- reference track

fileTool('import_reference', 'Load a reference song (a commercial track the user wants to sound like) for mix matching. It is not put on the timeline. Optional from_seconds/to_seconds pick an excerpt (e.g. the chorus). Returns its loudness, dynamics, stereo width and band balance.', {
  from_seconds: z.number().min(0).optional(),
  to_seconds: z.number().min(0).optional(),
});

tool('compare_to_reference', 'Compare the mix (or bars / a section of it) with the reference track, after matching their loudness: loudness_diff_lu, crest_diff_db, width_diff, tonal_diff_db per band (mix minus reference; negative = the mix has less) and concrete suggestions (EQ on the master or on the track that has the most energy in a band, gain, compression, width).', {
  ...RangeArgs,
}, { ...readOnly, timeout: 180000 });

tool('clear_reference', 'Remove the reference track from the project.', {});

// ---- recording

tool('set_voice_control', 'Hands-free studio: the user commands the studio by voice while holding push-to-talk (the ` key or a MIDI pedal) — record, stop, again, play back, from the chorus / bar N, loop, punch, mark error / good, keep / delete the take, metronome, tempo, headphone levels, undo (Italian and English). Recognition runs in the browser with Vosk, offline (a one-time model download of 40–50 MB per language, which the user agrees to in the studio), or with the browser\'s Web Speech API (engine "webspeech": on some browsers the audio goes to an online service). Each command arrives as a "voice_command" event; a phrase outside the commands arrives as an "ask" event with context.voice. Turn it on only when the user asks.', {
  enabled: z.boolean().optional(),
  engine: z.enum(['vosk', 'webspeech']).optional(),
  language: z.enum(['it', 'en']).optional(),
  push_to_talk_cc: z.number().int().min(0).max(127).nullable().optional().describe('A MIDI CC held to talk (a pedal); null removes it'),
  feedback: z.boolean().optional().describe('Spoken answers ("Take recorded"), never while recording'),
});
tool('start_session', 'Session mode: loop a section (or bars) with a count-in and record N passes as takes (the user plays or sings; flubs marked by voice, pedal or key attach to the take). Then every take is scored bar by bar — pitch against the guide melody, timing against the grid, clipping (MIDI: timing, notes out of the key) — and the best bar of each is comped into a "Session comp" take, made active; compare it with the best single take with start_ab_test. Answers when the passes are done (or stop_session). Start it only when the user asks.', {
  section_id: z.string().optional(),
  from_bar: z.number().int().min(1).optional(),
  to_bar: z.number().int().min(1).optional().describe('Last bar (inclusive)'),
  passes: z.number().int().min(1).max(16).optional().describe('Default 5'),
  track_id: z.string().optional().describe('The audio track to record on (default: armed tracks, or a new one)'),
}, { timeout: 1800000 });
tool('stop_session', 'Stop the running session ("that\'s enough"): the passes recorded so far are kept, scored and comped.', {});
tool('get_session', 'The last session: its takes with their scores (overall and per bar), flubs, the comp and the best single take.', {}, readOnly);
tool('set_synth_params', 'Shape the sound of an instrument track playing one of OpenBand\'s synths: amplitude envelope (attack, decay, sustain, release, seconds and 0..1), filter (cutoff Hz, resonance; and on mono synths filter_env octaves and its attack/decay/sustain), FM (fm_index, fm_ratio, fm_decay, fm_sustain) on FM presets, wave (0 sine … 3 square), unison and detune (cents) on wide presets, level (dB). Only the values given change (reset: back to the preset first); one undo step. Without values it lists the parameters with their ranges and current values.', {
  track_id: z.string(),
  values: z.record(z.string(), z.number()).optional(),
  reset: z.boolean().optional(),
});
tool('sound_from_words', 'A synth sound from a description, in Italian or English: "basso caldo e plucky", "bright wide pad", "metallic bells", "soft slow strings". Descriptors pick the family and the preset and push its parameters (warm/dark = lower cutoff, plucky = no attack and sustain, wide = unison and detune, metallic = FM, slow = slow attack…). Returns a patch (candidate_id) with what each word did: apply it with apply_patch.', {
  description: z.string(),
  family: z.enum(['bass', 'pluck', 'pad', 'lead', 'keys', 'bells', 'organ', 'strings']).optional(),
});
tool('match_sound', '"I want that sound": from one note — a sample (sample_id, e.g. after import_sample), an audio region (region_id), or a stretch of the reference track (reference_from_seconds, to_seconds) — find the patches of OpenBand\'s synths that sound most like it: the note\'s pitch and envelope are read, every compatible preset is tried, then the parameters are searched (CMA-ES) with each candidate rendered at the same pitch and length. Returns the 3 closest with a similarity 0..1; the user can A/B each against the original; apply one with apply_patch. family narrows the search (bass, pluck, pad, lead, keys, bells, organ, strings); words combine a description ("warm, plucky"). budget: renders (default 300, a few seconds). In the browser: nothing is uploaded.', {
  sample_id: z.string().optional(),
  region_id: z.string().optional(),
  reference_from_seconds: z.number().min(0).optional(),
  to_seconds: z.number().min(0).optional(),
  family: z.enum(['bass', 'pluck', 'pad', 'lead', 'keys', 'bells', 'organ', 'strings']).optional(),
  words: z.string().optional(),
  budget: z.number().int().min(30).max(2000).optional(),
  target: z.enum(['synth', 'plugin', 'auto']).optional().describe('synth (default and auto); plugin: not yet'),
}, { timeout: 300000 });
tool('tone_match', 'Make an audio track sound like a reference ("make my guitar sound like the record"): six peaking EQ bands (100 Hz – 10 kHz, ±12 dB) and the amp\'s drive that bring the track\'s average spectrum closest to the reference\'s — a sample, an audio region, or a stretch of the reference track. Applied as one undo step (apply: false only proposes); answers how far apart they were before and after, in dB.', {
  track_id: z.string(),
  sample_id: z.string().optional(),
  region_id: z.string().optional(),
  reference_from_seconds: z.number().min(0).optional(),
  to_seconds: z.number().min(0).optional(),
  from_bar: z.number().int().min(1).optional(),
  to_bar: z.number().int().min(1).optional(),
  apply: z.boolean().optional(),
}, { timeout: 300000 });
tool('apply_patch', 'Put a patch (from sound_from_words, or match_sound) on an instrument track — its instrument becomes that synth with those parameters — or, without track_id, on a new track. One undo step.', {
  candidate_id: z.string(),
  track_id: z.string().optional(),
});
tool('record_audio', 'Record from the user\'s microphone or audio interface, with a one-bar count-in, starting at start_bar. The user is always asked to confirm in the studio first (returns {recorded:false} if they decline). mode "audio" makes an audio region; mode "hum" also turns the hummed/sung melody into MIDI notes on a new instrument track (the audio is kept, muted). Without bars, recording runs until the user presses stop. With the setup (use_setup, default true for audio): armed tracks (arm_track) record together, each from its input; a punch range (set_punch) records only between in and out after a pre-roll, as a new take of the clip there; with the cycle on, every pass becomes a take.', {
  mode: z.enum(['audio', 'hum']).optional(),
  track_id: z.string().optional().describe('Audio track to record onto (default: a new one; ignored when tracks are armed)'),
  start_bar: z.number().int().min(1).optional(),
  bars: z.number().int().min(1).max(64).optional(),
  use_setup: z.boolean().optional(),
}, { timeout: 600000 });

tool('arm_track', 'Arm an audio track to record from an input channel of the audio interface (1-based; e.g. input 1 on Vocal, input 2 on Guitar): armed tracks record together with record_audio. armed=false disarms.', {
  track_id: z.string(),
  input_channel: z.number().int().min(1).max(32).optional(),
  armed: z.boolean().optional(),
});

tool('set_punch', 'Punch-in/out for record_audio: only bars in_bar…out_bar (out_bar exclusive) are recorded, after pre_roll_bars of the song playing; over an existing clip the result is a new take with 5 ms crossfades. enabled=false turns it off.', {
  enabled: z.boolean().optional(),
  in_bar: z.number().min(1).optional(),
  out_bar: z.number().min(1).optional(),
  pre_roll_bars: z.number().int().min(0).max(8).optional(),
});

tool('audio_to_midi', 'Convert a monophonic audio region (voice, whistle, bass, lead) into MIDI notes: YIN pitch tracking, note segmentation, optional snap to the project key and quantize with strength. The MIDI region is placed at the same position as the audio. Returns the notes.', {
  region_id: z.string().optional(),
  sample_id: z.string().optional(),
  start_bar: z.number().int().min(1).optional().describe('With sample_id: where to place the notes'),
  track_id: z.string().optional().describe('Instrument track for the notes (default: a new one)'),
  instrument: z.string().optional(),
  snap_to_key: z.boolean().optional(),
  quantize: z.number().min(0).max(4).optional().describe('Grid in beats, 0 = off (default 0.25)'),
  strength: z.number().min(0).max(1).optional(),
}, { timeout: 180000 });

// ---- studio → AI events (answered by this server, not the studio)

const EventKind = z.enum(['phrase', 'selection', 'transport', 'user_edit', 'region_recorded', 'ask', 'ab_result', 'flub', 'voice_command', 'session_take', 'session_done']);

special('get_events', 'What the user has been doing in the studio, oldest first: phrases played live (notes in beats from the phrase\'s first bar), selection changes, transport, finished edits, recorded regions and questions asked with "Ask the AI". Pass since_id (the last_id you got) to get only new ones.', { since_id: z.number().int().optional(), kinds: z.array(EventKind).optional(), limit: z.number().int().min(1).max(500).optional() }, 'events_list', readOnly);

special('wait_for_event', 'Wait (long-poll, up to 60 s) for the next studio event of the given kinds, e.g. {kinds:["phrase"]} to answer what the user plays, or ["ask"] for questions. Returns the event, or {timeout:true}. With since_id, an event already received after it is returned immediately.', { kinds: z.array(EventKind).optional(), timeout_ms: z.number().int().min(0).max(60000).optional(), since_id: z.number().int().optional() }, 'events_wait', readOnly);

// ---- WAM plugins (Web Audio Modules 2.0, the web's open plugin standard)

tool('list_plugins', 'List the Web Audio Module plugins available from the community collection: id, name, vendor, kind (instrument/effect), description.', {
  kind: z.enum(['instrument', 'effect']).optional(),
}, { ...readOnly, timeout: 30000 });

tool('search_plugins', 'Find plugins from a plain-language description in English or Italian (e.g. "warm tube overdrive for guitar", "riverbero ampio e scuro", "monophonic analog synth"): the WAM collection, and in the desktop app the VST3 / CLAP / AU plugins installed on the computer, which rank first when they fit. Returns ranked matches with id, format and score.', {
  description: z.string(),
  kind: z.enum(['instrument', 'effect']).optional(),
}, { ...readOnly, timeout: 30000 });

tool('list_native_plugins', 'Desktop app: the VST3, CLAP and Audio Unit plugins installed on this computer (id "native:<format>:<id>", name, vendor, version, format, kind, features). query ranks them by a plain-language description. In the browser: available:false.', {
  kind: z.enum(['instrument', 'effect']).optional(),
  query: z.string().optional(),
}, { ...readOnly, timeout: 60000 });

tool('rescan_plugins', 'Desktop app: look at the plugin folders again (new or updated plugins; ignored ones are retried). Returns how many plugins were found and which were set aside, with the reason.', {}, { timeout: 120000 });

tool(
  'add_plugin',
  'Add a WAM plugin by simply describing it (or by id/URL via plugin). The best match is added: instruments get a new track (or replace the instrument of track_id), effects are appended to track_id (or the selected track) after Amp → EQ → Compressor. Returns what was added plus alternatives.',
  {
    description: z.string().optional().describe('What you want, in words, e.g. "a shimmering ambient reverb"'),
    plugin: z.string().optional().describe('Exact plugin id, name or index.js URL instead of a description'),
    track_id: z.string().optional(),
    kind: z.enum(['instrument', 'effect']).optional(),
    format: z.enum(['wam', 'clap', 'vst3', 'au']).optional().describe('Only this format; without it installed plugins are preferred'),
  },
  { timeout: 60000 },
);

tool('add_plugin_instrument', 'Load an instrument plugin: an installed one (desktop app: its "native:…" id, id or name) or a WAM (id, name or index.js URL). Creates a track, or replaces the instrument of track_id. Returns instrument_id and track_id.', {
  plugin: z.string(),
  track_id: z.string().optional(),
  format: z.enum(['wam', 'clap', 'vst3', 'au']).optional(),
}, { timeout: 60000 });

tool('add_plugin_effect', 'Append an effect plugin to a track\'s effect chain: an installed one (desktop app: its "native:…" id, id or name) or a WAM (id, name or index.js URL). Returns slot_id.', {
  track_id: z.string(),
  plugin: z.string(),
  format: z.enum(['wam', 'clap', 'vst3', 'au']).optional(),
}, { timeout: 60000 });

tool('remove_plugin_effect', 'Remove a WAM effect from a track.', { track_id: z.string(), slot_id: z.string() });
tool('set_plugin_bypass', 'Turn a WAM effect on or off without removing it.', { track_id: z.string(), slot_id: z.string(), on: z.boolean() });

tool('get_plugin_params', 'List the parameters of a loaded plugin (id, label, value, range, units, choices). Omit slot_id for the track\'s plugin instrument.', {
  track_id: z.string(),
  slot_id: z.string().optional(),
}, { ...readOnly, timeout: 30000 });

tool('set_plugin_params', 'Set parameters of a loaded plugin: values maps parameter id (or label) to a value in the parameter\'s own range. Omit slot_id for the plugin instrument.', {
  track_id: z.string(),
  slot_id: z.string().optional(),
  values: z.record(z.string(), z.number()),
}, { timeout: 30000 });

tool('show_plugin', 'Open the plugin\'s own window in the studio so the user can see and tweak it. Omit slot_id for the plugin instrument.', {
  track_id: z.string(),
  slot_id: z.string().optional(),
});

// ---- imported sounds

fileTool('import_sample', 'Load an audio file (WAV, MP3, OGG, FLAC, AIFF…) into the studio. Returns sample_id, duration and the detected root note (from the file name or the pitch).', {});

tool('list_samples', 'List the samples loaded in the studio (ids, names, durations).', {}, readOnly);

tool(
  'create_sampler_instrument',
  'Build a playable instrument from imported samples. Melodic (kind "instrument"): samples [{sample_id, root?, lo?, hi?}] — without lo/hi each sample covers the keys nearest its root. Drum kit (kind "drums"): pads {kick: sample_id, snare: ..., hihat, openhat, clap, rim, lowtom, midtom, hightom, crash, ride}, or samples to auto-assign by name. Returns instrument_id for add_track/update_track.',
  {
    name: z.string().optional(),
    kind: z.enum(['instrument', 'drums']).optional(),
    samples: z.array(z.object({ sample_id: z.string(), root: z.union([z.number().int(), z.string()]).optional(), lo: z.number().int().optional(), hi: z.number().int().optional() })).optional(),
    pads: z.record(z.string(), z.string()).optional(),
    attack: z.number().min(0).max(5).optional().describe('seconds'),
    release: z.number().min(0).max(10).optional().describe('seconds'),
  },
);

fileTool('import_soundfont', 'Import from a SoundFont 2 (.sf2) file. Without preset it lists the presets (index, name, bank:program). With preset (index, name or "bank:program") it imports that preset as an instrument and returns instrument_id.', {
  preset: z.union([z.string(), z.number()]).optional(),
});

tool('add_audio_region', 'Place an imported sample on the timeline as an audio clip. Without track_id a new audio track is created. Length defaults to the sample length (audio is not time-stretched).', {
  sample_id: z.string(),
  track_id: z.string().optional(),
  start_bar: z.number().min(1).optional(),
  name: z.string().optional(),
  offset_seconds: z.number().min(0).optional(),
  length_bars: z.number().positive().optional(),
  gain: z.number().min(0).max(2).optional(),
});

// ---- Ensemble (SPEC v0.6): OpenBand as a client of OMEP engines
tool('create', 'Make a musical part from a description: OpenBand picks the capability (drums, accompaniment, an audio layer…) and the engine — its own algorithms or the OMEP engines the user installed — within the user\'s licence and privacy policy, sends it the song\'s context (tempo, key, sections, harmony), then conforms the result (tempo, key, length) and puts it in the song as one undo step. Ask for variants (up to 4, from different engines when several can play) to get takes for a blind test. Do not pin an engine unless the user asks. The answer says which engine played and what OpenBand had to correct.', {
  text: z.string().optional().describe('What to make, in words: "arpeggiated piano, intimate", "funk drums", "a lo-fi keys loop"'),
  capability: z.enum(['symbolic.drums', 'symbolic.accompany', 'symbolic.continue', 'symbolic.harmonize', 'music.add_layer', 'music.repaint', 'music.extend']).optional().describe('Only when you need a specific one; inferred otherwise'),
  track_id: z.string().optional().describe('Target track (otherwise one is found or created)'),
  section_id: z.string().optional(),
  from_bar: z.number().int().min(1).optional(),
  to_bar: z.number().int().min(1).optional().describe('Last bar (inclusive)'),
  role: z.string().optional().describe('drums, bass, harmony, lead, texture…'),
  instrument: z.string().optional(),
  variants: z.number().int().min(1).max(4).optional(),
  seed: z.number().int().optional(),
  engine: z.string().optional().describe('Pin an engine id (see list_engines) — only if the user asked for it'),
  confirm_spend: z.boolean().optional().describe('Online engines past the budget: true only after the user agreed to that cost'),
  confirm_download: z.boolean().optional().describe('When a layer comes back as a full mix, OpenBand isolates it with Demucs in the browser: true only after the user agreed to download its model (166 MB, once)'),
}, { timeout: 900000 });
tool('sing', 'A voice sings a melody on the lyrics: the notes of the melody track (default: the lyrics\' melody track) with the syllables aligned to them — OpenBand gives the engine the phonemes too (Italian by rule). By default OpenBand\'s guide voice sings, instantly and offline (a synthetic guide vocal to hear the topline with its words); a singing engine the user installed (DiffSinger) sings instead when present, or when pinned. The voice lands on a new audio track as one undo step. Without lyrics the melody is sung on "a" (set_lyrics and align_lyrics first for words).', {
  track_id: z.string().optional().describe('The melody track'),
  section_id: z.string().optional(),
  from_bar: z.number().int().min(1).optional(),
  to_bar: z.number().int().min(1).optional().describe('Last bar (inclusive)'),
  voice: z.string().optional().describe('The voice in words, for engines that take it ("warm, breathy")'),
  engine: z.string().optional().describe('Pin an engine id — only if the user asked for it'),
  variants: z.number().int().min(1).max(4).optional(),
  seed: z.number().int().optional(),
  confirm_spend: z.boolean().optional(),
}, { timeout: 900000 });
tool('separate', 'Separate an audio region into stems — drums, bass, other, vocals — each on its own track under the original (which is muted, not removed), as one undo step. By default Demucs runs in the browser: free, private, offline once its model is downloaded (166 MB, once: ask the user, then retry with confirm_download: true). Online separators are used only if the user allows online engines. Silent stems are left out. Takes two to three times the length of the audio on a typical computer (the first time also the download).', {
  region_id: z.string().optional().describe('The audio region (or give a track with one audio region)'),
  track_id: z.string().optional(),
  stems: z.array(z.enum(['drums', 'bass', 'other', 'vocals'])).optional().describe('Only these stems (all by default)'),
  engine: z.string().optional().describe('Pin an engine id — only if the user asked for it'),
  confirm_download: z.boolean().optional().describe('true only after the user agreed to download the separation model'),
  confirm_spend: z.boolean().optional(),
}, { timeout: 1800000 });
tool('transform', 'Change a part that is there, through OpenBand\'s engines: continue it, harmonize it (chords on a new track), repaint or restyle it. Give the region (or a track with a section or bars) and what you want in words; the capability is inferred when omitted. The result arrives as takes of that region to compare (start_ab_test) — the user\'s version is kept — and the answer says which engine played and what OpenBand corrected.', {
  region_id: z.string().optional(),
  track_id: z.string().optional(),
  section_id: z.string().optional(),
  from_bar: z.number().int().min(1).optional(),
  to_bar: z.number().int().min(1).optional(),
  intent: z.string().optional().describe('e.g. "harmonize with warm jazz chords", "continue for two bars", "make it a bossa nova"'),
  capability: z.enum(['symbolic.continue', 'symbolic.harmonize', 'music.repaint', 'music.restyle', 'music.extend']).optional(),
  variants: z.number().int().min(1).max(4).optional(),
  engine: z.string().optional(),
  seed: z.number().int().optional(),
  confirm_spend: z.boolean().optional(),
}, { timeout: 600000 });

// ---- the release (G6): metadata, licence, cover, checks, the Release Kit
const LicenseCode = z.enum(['all-rights-reserved', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-NC-ND-4.0']);
tool('get_release', 'The release of the song: title, artist, genre, tags, description, language, date, credits, licence (what it means, and the warnings that go with Creative Commons), the AI-use statement prefilled from the ledger, every piece of material with its licence (engine parts, CC0 loops, recordings, imported samples), and the platforms OpenBand can publish to (only ones with an open upload API).', {}, readOnly);
tool('set_release', 'Set the release\'s metadata. The licence by code, or from three answers (choose: commercial use allowed? changes allowed? same licence for changed versions? or public domain) — Creative Commons licences cannot be withdrawn for copies already shared, so confirm with the user. sample_licenses declares the licence of imported samples (by sample id) for the licence check. One undo step.', {
  title: z.string().optional(), artist: z.string().optional(), featuring: z.string().optional(), genre: z.string().optional(),
  tags: z.array(z.string()).optional(), description: z.string().optional(), language: z.string().optional(), explicit: z.boolean().optional(),
  date: z.string().optional().describe('YYYY-MM-DD'), credits: z.array(z.object({ role: z.string(), name: z.string() })).optional(),
  license: LicenseCode.optional(), contact: z.string().optional(), ai_disclosure: z.string().optional(),
  choose: z.object({ commercial: z.boolean(), derivatives: z.boolean(), share_alike: z.boolean().optional(), public_domain: z.boolean().optional() }).optional(),
  sample_licenses: z.record(z.string(), z.string()).optional(),
});
tool('check_release', 'What stands between the song and each platform: missing title or cover, a licence the platform refuses (Wikimedia Commons only CC0/BY/BY-SA, YouTube only CC BY, the Internet Archive needs CC), material whose licence the chosen Creative Commons licence doesn\'t allow (named), too many tags… Answers the issues, the platforms ready, and with a CC licence the ones "Publish in CC" can go to.', {
  platforms: z.array(z.enum(['soundcloud', 'youtube', 'mixcloud', 'audius', 'archive', 'funkwhale', 'wikimedia'])).optional(),
}, readOnly);
tool('generate_cover', 'Make a typographic cover for the release — deterministic for a style (bold, grid, waves, minimal), a palette (night, sunset, ocean, forest, paper, mono) and a seed — with the title and the artist. Answers a preview.', {
  style: z.enum(['bold', 'grid', 'waves', 'minimal']).optional(), palette: z.enum(['night', 'sunset', 'ocean', 'forest', 'paper', 'mono']).optional(), seed: z.number().int().optional(),
});
tool('export_release_kit', 'Everything a release needs, in one zip saved to the user\'s downloads: the master as 24-bit FLAC with its tags (title, artist, licence, copyright, contact, AI use) and cover, the cover (3000 px), LICENSE.txt, the lyrics as text and as LRC synchronised from their alignment, the credits.', {}, { timeout: 300000 });
tool('list_publish_targets', 'The platforms a song can be published to and, for each, whether OpenBand publishes there yet (this version: Internet Archive and Wikimedia Commons), whether the user\'s account is set up (they do it in Release → Accounts; keys never pass through you), and what blocks it (licence, tags, cover). Publishing needs the local OpenBand (npx openband or the desktop app).', {}, readOnly);
tool('publish', 'Publish the song to platforms. ALWAYS needs the user to confirm it in the studio: this opens a confirmation there and waits for their click; if they cancel or don\'t answer, it fails — never retry to get around it. Run check_release first and fix what it names. The master (24-bit FLAC with its tags and cover) and, for the Internet Archive, the cover, LRC, LICENSE.txt and CREDITS.txt are sent; Archive and Commons uploads are public and permanent. Returns the URLs; each is kept in the song (get_publications).', {
  platforms: z.array(z.string()).min(1).describe('Platform ids: archive, wikimedia'),
  privacy: z.enum(['private', 'unlisted', 'public']).optional().describe('public (default; the only choice on Archive and Commons)'),
}, { timeout: 1800000 });
tool('get_publications', 'Where the song has been published: platform, URL, id, when, and which master (hash) went out.', {}, readOnly);
tool('render_video', 'The video for YouTube, saved to the user\'s downloads: the cover, the spectrum moving with the music and the aligned lyrics in time, as an MP4 (H.264 and AAC; VP9 or Opus where the browser has no H.264 or AAC encoder). format 16:9 is the whole song (1920×1080); 9:16 is a Short (1080×1920) of 15–60 s from the chorus, or from section_id, at most max_seconds. Rendered in the browser; takes about as long as the song or less.', {
  format: z.enum(['16:9', '9:16']).optional().describe('16:9 (default, the whole song) or 9:16 (a Short from the chorus)'),
  section_id: z.string().optional().describe('9:16: the section to show instead of the first chorus'),
  max_seconds: z.number().min(15).max(60).optional().describe('9:16: at most this long (default 60)'),
}, { timeout: 900000 });

tool('get_context', 'The Song Context Package (OMEP SCP 1.0) of the song, a section or some bars: tempo, key, length, sections with their energy, the chords bar by bar, the tracks with their roles, the melody and the lyrics — what you need to know before writing or changing a part, in one call instead of five analyses. Also as the resource openband://context/song (or /section/<id>, /bars/<a>-<b>).', {
  section_id: z.string().optional(),
  from_bar: z.number().int().min(1).optional(),
  to_bar: z.number().int().min(1).optional(),
}, readOnly);

tool('list_engines', 'The music engines OpenBand can use (OpenBand\'s own algorithms and the OMEP engines the user configured): capabilities, where they run, licence, the GPU state of those that take turns on it, and — under the user\'s policy and taste — the order a request would try them in, what it would exclude and why, and what blind tests taught (score, interval, comparisons).', { capability: z.string().optional() }, readOnly);
tool('get_ledger', 'Who made what: every part an engine contributed (engine, model, seed, licence, the request, the corrections OpenBand applied) and the human / AI share of each track.', {}, readOnly);
tool('set_engine_policy', 'The user\'s engine policy: commercial use only (licences that forbid it are excluded), local engines only, online engines allowed (they cost money and send data). Change it only when the user asks.', {
  commercial_only: z.boolean().optional(),
  local_only: z.boolean().optional(),
  allow_cloud: z.boolean().optional(),
});

// ---- levels and toolsets (SPEC v0.6 §8.1): what an AI sees first, and what it loads when it needs it.
// Core and capability tools are always there; the domain toolsets come with load_toolset. Clients that
// can't follow tools/list_changed get every tool, as before (--toolsets=all is the default for MCP).

/** Always loaded: the song, its tracks and regions, notes, transport, undo, structure. */
export const CORE = [
  'get_project', 'get_status', 'list_instruments', 'new_project', 'set_tempo', 'set_key', 'add_track', 'update_track', 'delete_track',
  'add_region', 'update_region', 'delete_region', 'duplicate_region', 'get_region_notes', 'add_notes', 'remove_notes', 'transport',
  'undo', 'redo', 'begin_change', 'end_change', 'get_structure', 'get_context', 'load_toolset',
];
/** Always loaded: one generic tool per kind of musical job; the router and OpenBand's engines do the rest. */
export const CAPABILITY = ['create', 'transform', 'separate', 'sing', 'suggest_continuation', 'mix_pilot', 'arrange_from_energy', 'export_for_platforms', 'set_jam_mode'];

export const TOOLSETS = {
  editing: { description: 'Detailed note and region editing: transpose, quantize, update notes, drum patterns and chord progressions written out, the drummer, loop and metronome, the editor', tools: ['rename_project', 'set_master_volume', 'update_notes', 'transpose_region', 'quantize_region', 'quantize_track', 'add_drum_pattern', 'add_chord_progression', 'set_loop', 'set_metronome', 'open_editor', 'split_region', 'detect_tempo', 'add_drummer', 'regenerate_drummer'] },
  structure: { description: 'Sections (add, move, duplicate with ripple), automatic sections, the energy curve and transitions', tools: ['add_section', 'update_section', 'delete_section', 'move_section', 'duplicate_section', 'auto_sections', 'set_energy_curve', 'get_energy', 'add_transition'] },
  mix: { description: 'Effects per track, master chain, the mix pilot\'s knob, automation, meters and listening (analyze_mix, spectrogram), reference tracks', tools: ['set_track_effects', 'set_master_chain', 'set_pilot_amount', 'fix_pilot', 'set_track_role', 'set_automation', 'clear_automation', 'list_automatable', 'get_meters', 'set_monitoring', 'level_match', 'analyze_mix', 'render_spectrogram', 'import_reference', 'compare_to_reference', 'clear_reference'] },
  analysis: { description: 'Harmony and key analysis, the song linter and its fixes', tools: ['analyze_harmony', 'detect_key', 'lint_project', 'apply_fix', 'ignore_issue'] },
  recording: { description: 'Recording audio and MIDI, punch-in, takes and comping, blind A/B tests, flub marks', tools: ['record_audio', 'arm_track', 'set_track_midi_input', 'map_midi_channels', 'set_punch', 'audio_to_midi', 'add_take', 'list_takes', 'set_active_take', 'delete_take', 'comp_takes', 'start_ab_test', 'add_flub', 'list_flubs', 'resolve_flub', 'delete_flub', 'replace_with_best_take', 'set_voice_control', 'start_session', 'stop_session', 'get_session'] },
  versions: { description: 'History, versions and branches, merge, the time machine', tools: ['get_history', 'save_version', 'list_versions', 'create_branch', 'checkout', 'diff_versions', 'merge', 'get_timeline', 'preview_at', 'restore_at'] },
  lyrics: { description: 'Lyrics, aligning them to the melody, prosody, chord sheets', tools: ['set_lyrics', 'get_lyrics', 'align_lyrics', 'check_prosody', 'suggest_melody_rhythm', 'export_chord_sheet'] },
  plugins: { description: 'WAM plugins and the user\'s installed VST3 / CLAP / AU plugins', tools: ['list_plugins', 'search_plugins', 'list_native_plugins', 'rescan_plugins', 'add_plugin', 'add_plugin_instrument', 'add_plugin_effect', 'remove_plugin_effect', 'set_plugin_bypass', 'get_plugin_params', 'set_plugin_params', 'show_plugin'] },
  sounds: { description: 'Imported samples, sampler instruments, SoundFonts, audio regions, the CC0 loop library', tools: ['import_sample', 'list_samples', 'create_sampler_instrument', 'import_soundfont', 'add_audio_region', 'search_loops', 'add_loop', 'set_synth_params', 'sound_from_words', 'apply_patch', 'match_sound', 'tone_match'] },
  files: { description: 'Exports and imports: WAV, MIDI, project JSON, DAWproject', tools: ['export_project_json', 'import_project_json', 'export_wav', 'export_midi', 'import_midi', 'import_dawproject', 'export_dawproject'] },
  collab: { description: 'Rooms with other people, comments and explanations on the song', tools: ['create_room', 'join_room', 'leave_room', 'get_peers', 'annotate', 'list_annotations', 'resolve_annotation', 'delete_annotation'] },
  jam: { description: 'Jamming: answering the user\'s phrases, keeping answers, the studio\'s event stream', tools: ['play_phrase', 'keep_answer', 'keep_phrase', 'get_events', 'wait_for_event'] },
  release: { description: 'The release: metadata, licence (Creative Commons chooser and checks), cover, the Release Kit', tools: ['get_release', 'set_release', 'check_release', 'generate_cover', 'export_release_kit', 'render_video', 'list_publish_targets', 'publish', 'get_publications'] },
  engines: { description: 'OMEP engines: which are installed, who made what (ledger), the engine policy, covers of a song in another style', tools: ['list_engines', 'get_ledger', 'set_engine_policy', 'cover_song'] },
};

add('toolset', 'load_toolset', `Load a toolset when the request needs tools that are not loaded yet (they appear right after). Core and capability tools are always there. Toolsets: ${Object.entries(TOOLSETS).map(([n, t]) => `${n} — ${t.description}`).join('; ')}. "all" loads everything.`, {
  name: z.enum([...Object.keys(TOOLSETS), 'all']),
}, { annotations: { readOnlyHint: true } });

/** The toolset a tool belongs to, or 'core' / 'capability'. */
export function levelOf(name) {
  if (CORE.includes(name)) return 'core';
  if (CAPABILITY.includes(name)) return 'capability';
  for (const [set, t] of Object.entries(TOOLSETS)) if (t.tools.includes(name)) return set;
  return null;
}

/**
 * The toolsets a request obviously needs, from its words (English and Italian): the page chat preloads
 * them, so the first turn already has the right tools.
 */
const PLAN = [
  ['mix', /\b(mix|mixa|master|loud|lufs|eq\b|equaliz|compress|sidechain|riverbero|reverb|automat|volume curve|fade)/],
  ['lyrics', /\b(lyric|testo|testi|parole|sing|canta|prosod|chord sheet|accordi per chitarra)/],
  ['recording', /\b(record|registr|take|comp\b|punch|microphone|microfono|flub|errore)/],
  ['versions', /\b(version|versione|branch|merge|go back|torna indietro|history|cronologia|what if|e se)/],
  ['plugins', /\b(plugin|vst|clap|audio unit|\bau\b|wam|synth plugin)/],
  ['sounds', /\b(sample|campion|soundfont|\.sf2|loop library|loop cc0|import.*(wav|mp3|audio))/],
  ['files', /\b(export|esporta|import|importa|midi file|\.mid\b|dawproject|bitwig|cubase|studio one|wav\b)/],
  ['structure', /\b(section|sezion|verse|strofa|chorus|ritornello|bridge|intro|outro|structure|struttura|energy|energia|arrang|song from|canzone intera|3 min)/],
  ['editing', /\b(transpose|traspon|quantiz|drum pattern|pattern|chord progression|progressione|drummer|batterist|metronom|split|dividi)/],
  ['analysis', /\b(harmony|armonia|key\b|tonalit|lint|check|controlla|problem)/],
  ['collab', /\b(room|stanza|together|insieme|comment|comment[oi]|explain|spiega)/],
  ['jam', /\b(jam|improvvis|answer my|rispondi)/],
  ['engines', /\b(engine|motor[ei]|ledger|who made|chi ha fatto|policy)/],
];
export function planToolsets(text) {
  const t = String(text).toLowerCase();
  return PLAN.filter(([, re]) => re.test(t)).map(([name]) => name);
}
