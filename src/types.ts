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
}

export interface Take {
  id: string;
  name: string;
  notes: Note[];
  audio?: AudioClip;
  createdAt: number;
  author: 'user' | 'ai';
}

export interface AudioClip {
  sampleId: string;
  /** Seconds into the sample where the region starts playing. */
  offset: number;
  /** Linear gain 0..2 (1 = unchanged). */
  gain: number;
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
  source: 'sampler' | 'soundfont' | 'wam';
  zones: SampleZone[];
  /** Web Audio Module plugin instrument: where to load it from and its saved state. */
  wam?: { url: string; state?: unknown };
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
  /** Automation curves; a parameter with points follows its curve instead of the static value. */
  automation?: Partial<Record<AutoParam, AutoPoint[]>>;
}

export type AutoParam = 'volume' | 'pan' | 'tone' | 'reverb' | 'echo';

export interface AutoPoint {
  /** Position in beats from the song start. */
  beat: number;
  /** In the parameter's own range: volume/tone/reverb/echo 0..1, pan −1..1. */
  value: number;
}

export interface TrackFx {
  amp: { on: boolean; /** 0..1 */ drive: number; /** cabinet brightness 0..1 */ tone: number; /** output 0..1 */ level: number };
  eq: { on: boolean; /** dB −15..15 */ low: number; mid: number; high: number; /** Hz */ midFreq: number };
  comp: { on: boolean; /** dB −60..0 */ threshold: number; /** 1..20 */ ratio: number; /** seconds */ attack: number; release: number; /** dB 0..24 */ makeup: number };
  /** Web Audio Module effect plugins, after the built-in units, in order. */
  plugins?: PluginSlot[];
}

export interface PluginSlot {
  id: string;
  url: string;
  name: string;
  on: boolean;
  /** Plugin state from getState(), restored when the plugin loads. */
  state?: unknown;
}

export interface LoopRange {
  enabled: boolean;
  start: number;
  end: number;
}

export interface Project {
  version: 2;
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
  /** Lyrics aligned to a melody (F10). */
  lyrics?: LyricsDoc;
  /** Comments/explanations attached to parts of the song (F14). */
  annotations?: Annotation[];
  /** Reference track for mix matching (F6); not on the timeline. */
  reference?: ReferenceTrack;
  /** Linter configuration (F7). */
  lint?: LintConfig;
  /** Marks left while recording (F18): mistakes to fix, good parts, notes. */
  flubs?: Flub[];
  meta?: ProjectMeta;
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

export interface Annotation {
  id: string;
  target: AnnotationTarget;
  /** Short markdown, at most 500 characters. */
  text: string;
  author: 'ai' | 'user';
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

export type BottomPanel = 'smart' | 'editor' | 'mixer' | 'fx' | 'analysis' | 'problems' | 'lyrics' | 'comments' | 'versions' | 'flubs' | null;

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
