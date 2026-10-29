// Core data model. All musical times are expressed in beats (quarter notes).
// The project is 4/4: one bar = 4 beats.

export type TrackKind = 'instrument' | 'drums' | 'audio';

export interface Note {
  id: string;
  /** MIDI pitch 0..127. For drum tracks the pitch selects the kit piece (GM drum map). */
  pitch: number;
  /** Start in beats, relative to the region start. */
  start: number;
  /** Duration in beats. */
  duration: number;
  /** 0..1 */
  velocity: number;
}

export interface Region {
  id: string;
  trackId: string;
  name: string;
  /** Start in beats on the timeline. */
  start: number;
  /** Length in beats. */
  length: number;
  notes: Note[];
  /** Audio regions (on audio tracks) play a stored sample instead of notes. */
  audio?: AudioClip;
  /** Alternative versions of the content (F12); notes/audio above always hold the active one. */
  takes?: Take[];
  activeTakeId?: string;
  /** The contribution (ledger entry, SPEC v0.6 §6) that made this region, when an engine did. */
  contribution?: string;
  /** Made by the drummer (F24): how, so it can be regenerated with another seed. */
  drummer?: { style: string; complexity: number; loudness: number; swing: number; fills: 'none' | 'end_of_section' | 'every_4'; seed: number };
}

export interface Take {
  id: string;
  name: string;
  notes: Note[];
  audio?: AudioClip;
  createdAt: number;
  author: 'user' | 'ai';
  /** Session mode's score, 0..100 (G4). */
  score?: number;
}

export interface AudioClip {
  sampleId: string;
  /** Seconds into the sample where the region starts playing. */
  offset: number;
  /** Linear gain 0..2 (1 = unchanged). */
  gain: number;
  /**
   * Time-stretch (F23): off; fixed (ratio = played length / original length); follow_tempo (the clip
   * follows the song's tempo, from originalBpm, which is also kept, estimated, while off).
   */
  stretch?: { mode: 'off' | 'follow_tempo' | 'fixed'; ratio?: number; originalBpm?: number };
  /** Pitch shift in semitones (decimals = cents). */
  pitch?: number;
}

/** One sample mapped onto a key range of a sampler instrument. */
export interface SampleZone {
  sampleId: string;
  /** MIDI pitch at which the sample plays at its original speed. */
  root: number;
  lo: number;
  hi: number;
  /** Fine tuning in cents. */
  tune?: number;
  /** Loop points in seconds (sustaining samples, e.g. from SoundFonts). */
  loopStart?: number;
  loopEnd?: number;
  /** Linear gain applied to this zone. */
  gain?: number;
}

/** A user instrument built from imported samples (sampler, custom drum kit or SoundFont preset). */
export interface CustomInstrument {
  id: string;
  name: string;
  kind: 'instrument' | 'drums';
  source: 'sampler' | 'soundfont' | 'wam' | 'native';
  zones: SampleZone[];
  /** Web Audio Module plugin instrument: where to load it from and its saved state. */
  wam?: { url: string; state?: unknown };
  /** A native plugin instrument (G8); missing = WAM when source is 'wam'. */
  format?: PluginFormat;
  native?: NativePluginRef;
  /** Envelope in seconds. */
  attack: number;
  release: number;
}

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  /** Instrument preset id, see audio/instruments.ts */
  instrument: string;
  color: string;
  /** Fader 0..1 (0.8 = 0 dB). */
  volume: number;
  /** -1..1 */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Send levels 0..1 */
  reverb: number;
  delay: number;
  /** Smart control "tone" (low-pass cutoff) 0..1 */
  cutoff: number;
  /** Insert effects, applied in this order: amp → EQ → compressor. Missing = all off. */
  fx?: TrackFx;
  /** Polarity inverted (F20): monitoring and render. */
  polarity?: boolean;
  /** Automation lanes (schema v3): a parameter with points follows its curve instead of its static value. */
  automation?: AutomationLane[];
  /** The role in the mix, set by the user (G1): the mix pilot classifies the others itself. */
  role?: MixRole;
  /** The synth preset's parameters that differ from the preset (G5), by id (attack, cutoff, fm_index…). */
  synthParams?: Record<string, number>;
  /**
   * Live MIDI in (issue #9): a track with a channel plays what arrives on it (from that device, if named)
   * even when not selected — one keyboard or a MIDI orchestrator (Texturium) drives up to 16 tracks by
   * channel. Without: the selected track plays what no other track takes.
   */
  midiIn?: { channel: number; device?: string };
  /**
   * The render cache of a track with native plugins (G8.4): its audio before the fader, played where the
   * plugins can't run (the browser, a computer without them). hash: of what it was made from.
   */
  frozen?: { sampleId: string; hash: string; plugins: string[]; seconds: number };
}

export type MixRole = 'kick' | 'drums' | 'bass' | 'harmony' | 'lead' | 'vocal' | 'texture' | 'fx';
export const MIX_ROLES: MixRole[] = ['kick', 'drums', 'bass', 'harmony', 'lead', 'vocal', 'texture', 'fx'];

/** What the mix pilot sets on a track (G1). */
export interface TrackMix {
  volume: number;
  pan: number;
  reverb: number;
  delay: number;
  fx?: TrackFx;
}

/** A pilot run that hasn't been fixed yet: the knob blends from `before` to `full` (G1). */
export interface PilotState {
  amount: number;
  genre: string;
  platform: string;
  before: { tracks: Record<string, TrackMix>; master: MasterChain | null };
  /** master null: the run left the master alone (scope "mix"). */
  full: { tracks: Record<string, TrackMix>; master: MasterChain | null };
  decisions: PilotDecision[];
  /** Loudness before and after (LUFS) for the level-matched comparison. */
  lufsBefore: number;
  lufsAfter: number;
}

export interface PilotDecision {
  trackId?: string;
  kind: 'role' | 'gain' | 'balance' | 'eq' | 'hpf' | 'sidechain' | 'pan' | 'space' | 'master';
  text: string;
}

export type AutoParam = 'volume' | 'pan' | 'tone' | 'reverb' | 'echo';
export type FxUnit = 'amp' | 'eq' | 'comp';

/** What a lane automates (F22): the mix, a built-in effect parameter, or a plugin parameter. */
export type AutoTarget =
  | { kind: 'mix'; param: AutoParam }
  | { kind: 'fx'; unit: FxUnit; param: string }
  /** slotId null = the track's plugin instrument. */
  | { kind: 'plugin'; slotId: string | null; paramId: string };

export interface AutomationLane {
  target: AutoTarget;
  /** Values in the parameter's own range (plugins: as getParameterInfo reports it). */
  points: AutoPoint[];
}

export interface AutoPoint {
  /** Position in beats from the song start. */
  beat: number;
  /** In the parameter's own range: volume/tone/reverb/echo 0..1, pan −1..1. */
  value: number;
}

export interface TrackFx {
  amp: { on: boolean; /** 0..1 */ drive: number; /** cabinet brightness 0..1 */ tone: number; /** output 0..1 */ level: number };
  eq: {
    on: boolean;
    /** dB −15..15 */ low: number;
    mid: number;
    high: number;
    /** Hz */ midFreq: number;
    /** High-pass filter, 12 dB/oct, before the EQ (G1); works with the EQ off too. */
    hpf?: { on: boolean; hz: number };
    /** Peaking bands after the EQ (G1, the mix pilot's cuts); like the high-pass they work with the EQ off. */
    bands?: { hz: number; gain: number; q: number }[];
  };
  comp: {
    on: boolean;
    /** dB −60..0 */ threshold: number;
    /** 1..20 */ ratio: number;
    /** seconds */ attack: number;
    release: number;
    /** dB 0..24 */ makeup: number;
    /** Keyed by another track, before its fader (G1): kick → bass. amount 0..1 scales the reduction. */
    sidechain?: { sourceTrackId: string; amount: number };
  };
  /** Web Audio Module effect plugins, after the built-in units, in order. */
  plugins?: PluginSlot[];
  /** Output trim of the chain in dB (a level-match compensation made permanent, F20). */
  trim?: number;
}

export interface PluginSlot {
  id: string;
  /** WAM: where the plugin loads from ('' for native plugins). */
  url: string;
  name: string;
  on: boolean;
  /** Plugin state from getState(), restored when the plugin loads (WAM). */
  state?: unknown;
  /** Plugin format (G8): a Web Audio Module, a native plugin of the desktop app, or an in-process test
   *  plugin. Missing = 'wam' (projects saved before G8). */
  format?: PluginFormat;
  native?: NativePluginRef;
}

export type PluginFormat = 'wam' | 'clap' | 'vst3' | 'au' | 'test';

/** Which native plugin, and its state (G8). */
export interface NativePluginRef {
  /** CLAP id, VST3 class UID, AU type/subtype/manufacturer, or a test plugin id. */
  id: string;
  vendor?: string;
  version?: string;
  /** Where it was found, to tell the user which one is missing on another computer. */
  path_hint?: string;
  /** The plugin's state (the format's own state chunk), base64. */
  state_b64?: string;
}

export interface LoopRange {
  enabled: boolean;
  start: number;
  end: number;
}

export interface Project {
  version: 3;
  name: string;
  bpm: number;
  key: string;
  tracks: Track[];
  regions: Region[];
  loop: LoopRange;
  masterVolume: number;
  metronome: boolean;
  /** Imported instruments, referenced by Track.instrument. */
  instruments?: CustomInstrument[];
  // ---- schema v2 (all optional) ----
  /** Song structure (F8): ordered, non-overlapping. */
  sections?: Section[];
  /** The energy curve drawn for the song (G2): what "Arrange" builds from. */
  energy?: { points: { bar: number; energy: number }[]; length_bars: number; shape?: string };
  /** Lyrics aligned to a melody (F10). */
  lyrics?: LyricsDoc;
  /** Comments/explanations attached to parts of the song (F14). */
  annotations?: Annotation[];
  /** Reference track for mix matching (F6); not on the timeline. */
  reference?: ReferenceTrack;
  /** What a release says about the song (G6): metadata, licence, credits. */
  release?: ReleaseMeta;
  /** Licences the user declared for imported samples (by sample id), for the release's licence check. */
  sampleLicenses?: Record<string, string>;
  /** Where the song has been published (G6). */
  publications?: Publication[];
  protections?: Protection[];
  /** Linter configuration (F7). */
  lint?: LintConfig;
  /** Marks left while recording (F18): mistakes to fix, good parts, notes. */
  flubs?: Flub[];
  /** The master chain (G1): EQ, glue compressor, stereo width, true-peak limiter. Missing = no processing. */
  master?: MasterChain;
  /** The mix pilot's last run, while its knob is live (G1). Removed by "Fix". */
  pilot?: PilotState;
  /** Who made what (SPEC v0.6 §6): one entry per engine contribution. */
  ledger?: LedgerEntry[];
  meta?: ProjectMeta;
}

export interface MasterChain {
  on: boolean;
  /** tilt: dB/oct around 1 kHz (−3..+3); low / high: shelves at 100 Hz / 8 kHz in dB; bands: peaking filters. */
  eq: { on: boolean; tilt: number; low: number; high: number; bands?: { hz: number; gain: number; q: number }[] };
  /** A gentle bus compressor (dB, ratio, seconds, makeup dB). */
  glue: { on: boolean; threshold: number; ratio: number; attack: number; release: number; makeup: number };
  /** M/S width: 0..2 (1 = unchanged); everything below monoBelowHz in mono. */
  width: { on: boolean; amount: number; monoBelowHz: number };
  /** True-peak limiter: ceiling in dBTP, loudness target in LUFS, release in ms; inputGainDb is found by
   *  rendering until the target is met (set_master_chain does it), and kept for live playback. */
  limiter: { on: boolean; ceilingDbtp: number; targetLufs: number; release: number; inputGainDb?: number };
}

export interface LedgerEntry {
  id: string;
  at: number;
  /** builtin: OpenBand's own algorithm; engine: an OMEP engine; conductor: an LLM writing notes itself. */
  source: 'builtin' | 'engine' | 'conductor';
  engine: string;
  engineName?: string;
  engineVersion?: string;
  capability: string;
  modelHash?: string;
  seed?: number;
  prompt?: string;
  /** The request as asked (by the user or the conductor). */
  request?: string;
  requestedBy: 'user' | 'ai';
  contextHash?: string;
  /** Corrections the studio applied (tempo, key, length…). */
  conform: string[];
  license: { code: string; weights: string | null; commercial: 'yes' | 'no' | 'conditional'; attribution?: string | null; conditions?: string | null; url?: string };
  costUsd?: number;
  trackId: string;
  regionIds: string[];
  takeIds?: string[];
}

export type FlubKind = 'flub' | 'good' | 'note';

export interface Flub {
  id: string;
  /** Beat on the timeline (follows its region when the region moves). */
  beat: number;
  trackId?: string;
  /** The region it was recorded into, and the take (no take id = the region's first take). */
  regionId?: string;
  takeId?: string;
  kind: FlubKind;
  text?: string;
  createdAt: number;
  resolved?: boolean;
  author?: 'user' | 'ai';
}

export interface ProjectMeta {
  createdAt: number;
  updatedAt: number;
  /** Stable identity of the song across saves, versions and copies. */
  projectId: string;
}

export type SectionKind = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'solo' | 'breakdown' | 'outro' | 'custom';

export interface Section {
  id: string;
  name: string;
  kind: SectionKind;
  /** Beats. */
  start: number;
  length: number;
  color?: string;
}

export interface LyricsDoc {
  language: 'it' | 'en';
  /** Track carrying the vocal melody. */
  melodyTrackId?: string;
  lines: LyricLine[];
}

export interface LyricLine {
  id: string;
  sectionId?: string;
  text: string;
  syllables: Syllable[];
}

export interface Syllable {
  text: string;
  stressed: boolean;
  /** Absolute beat assigned by alignment. */
  beat?: number;
  noteId?: string;
  /** Continues over the next note. */
  melisma?: boolean;
}

export interface AnnotationTarget {
  type: 'project' | 'track' | 'region' | 'notes' | 'section' | 'range';
  id?: string;
  note_ids?: string[];
  from_beat?: number;
  to_beat?: number;
}

export interface AnnotationAuthor {
  kind: 'user' | 'ai';
  name: string;
}

export interface Annotation {
  id: string;
  target: AnnotationTarget;
  /** Short markdown, at most 500 characters. */
  text: string;
  /** Who wrote it (F16): a person (their room name) or an AI (acting for someone). */
  author: AnnotationAuthor;
  /** The comment this one answers (same target, same thread). */
  replyTo?: string;
  txId?: string;
  createdAt: number;
  resolved?: boolean;
  /** Set when the target no longer exists. */
  orphaned?: boolean;
}

export interface ReferenceTrack {
  sampleId: string;
  name: string;
  loudnessMatched: boolean;
  /** Part of the file used, seconds. */
  from?: number;
  to?: number;
  /** Cached analysis of the reference (format of analyze_mix's master block). */
  analysis?: Record<string, unknown>;
}

export type Severity = 'info' | 'warn' | 'error';

export interface LintConfig {
  disabled?: string[];
  severity?: Record<string, Severity>;
  /** Issue ids the user chose to ignore. */
  ignored?: string[];
}

export type BottomPanel = 'smart' | 'editor' | 'mixer' | 'fx' | 'analysis' | 'problems' | 'lyrics' | 'comments' | 'versions' | 'flubs' | 'ensemble' | 'pilot' | 'release' | null;

export interface BridgeLogEntry {
  id: string;
  time: number;
  method: string;
  ok: boolean;
  summary: string;
  /** The transaction (undo step) the command belongs to. */
  txId?: string;
}

/** One undo step: the project as it was before the change, and what the change was. */
export interface HistoryEntry {
  id: string;
  project: Project;
  label: string;
  source: 'ui' | 'ai';
  /** How many commands the step groups. */
  commands: number;
  at: number;
  /** Plugin states of this step were dropped to save memory (F19): undoing to it leaves plugins as they are. */
  pluginStateDropped?: boolean;
}

export interface ActiveTransaction {
  id: string;
  label: string;
  source: 'ui' | 'ai';
  commands: number;
  snapshot: Project;
  /** Nesting depth: only the outermost begin/end pair counts. */
  depth: number;
  /** Opened automatically for AI commands (closed after a pause) rather than by begin_change. */
  auto?: boolean;
}

export type BridgeStatus = 'connecting' | 'connected' | 'disconnected';

export interface ReleaseMeta {
  title?: string;
  artist?: string;
  featuring?: string;
  genre?: string;
  tags?: string[];
  description?: string;
  /** ISO 639-1. */
  language?: string;
  explicit?: boolean;
  /** ISO date of the release. */
  date?: string;
  credits?: { role: string; name: string }[];
  /** A licence code (all-rights-reserved, CC0-1.0, CC-BY-4.0…). */
  license?: string;
  contact?: string;
  /** The cover: generated (deterministic: the recipe is enough) or an image of the user's (data URL). */
  cover?: { kind: 'generated'; style: string; palette: string; seed: number } | { kind: 'image'; dataUrl: string };
  /** How AI was used, in words (prefilled from the ledger). */
  aiDisclosure?: string;
}

/** A proof of the work's existence at a date (G7): an OpenTimestamps proof of its manifest. */
export interface Protection {
  id: string;
  kind: 'opentimestamps';
  /** When it was made (ms). */
  at: number;
  /** The manifest, as stamped (its exact bytes). */
  manifest: string;
  /** SHA-256 of the manifest (hex). */
  digest: string;
  /** The .ots proof, base64. */
  ots: string;
  state: 'pending' | 'confirmed';
  height?: number;
  /** The Bitcoin block's time (s), once verified. */
  blockTime?: number;
  includes: string[];
  /**
   * The master as it was stamped, kept as a sample (renders differ in the last bits from one to the next, so
   * the proof keeps the very bytes it hashed; it also travels in .openband files).
   */
  masterSampleId?: string;
}

export interface Publication {
  platform: string;
  id: string;
  url: string;
  at: number;
  /** The master that was published (the version's hash). */
  master?: string;
  privacy?: 'private' | 'unlisted' | 'public';
}
