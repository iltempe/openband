// Open Music Engine Profile 1.0 in TypeScript: the shapes of omep/schemas/*.json (the schemas are the
// source of truth; omep/conformance.mjs validates against them).

export type Capability =
  | 'music.song'
  | 'music.add_layer'
  | 'music.repaint'
  | 'music.extend'
  | 'music.restyle'
  | 'music.arrange'
  | 'symbolic.continue'
  | 'symbolic.harmonize'
  | 'symbolic.accompany'
  | 'symbolic.drums'
  | 'voice.sing'
  | 'audio.separate'
  | 'audio.transcribe'
  | 'audio.match_sound'
  | 'mix.assist'
  | 'stream.jam'
  | `x-${string}`;

export interface OmepLicense {
  code: string;
  weights: string | null;
  commercial: 'yes' | 'no' | 'conditional';
  attribution?: string | null;
  conditions?: string | null;
  url?: string;
}

export type Where = 'builtin' | 'browser' | 'local' | 'lan' | 'cloud';

export interface Manifest {
  omep: '1.0';
  engine: { id: string; name: string; version: string; homepage?: string };
  license: OmepLicense;
  runtime: {
    where: Where;
    device?: string[];
    vram_gb?: number;
    realtime?: boolean;
    provider?: string;
    pricing?: { unit: string; usd: number; verified?: string };
    data_policy?: { uploads_audio: boolean; retention?: string; training_on_inputs: 'no' | 'yes' | 'unknown'; terms_url: string; verified: string };
    output_rights?: { commercial: 'yes' | 'no' | 'conditional'; terms_url?: string };
  };
  capabilities: Partial<Record<Capability, { conditioning?: string[]; max_seconds?: number; max_variants?: number; roles?: string[]; experimental?: boolean }>>;
  outputs: string[];
  languages?: string[];
  determinism: 'seeded' | 'stochastic' | 'deterministic';
}

export interface ScpNote {
  pitch: number;
  /** Beats from scope.from_bar. */
  start: number;
  duration: number;
  velocity?: number;
}

/** Song Context Package 1.0. */
export interface Scp {
  scp: '1.0';
  song: { title?: string; bpm: number; meter: string; key: string; length_bars: number; tempo_map?: { bar: number; bpm: number }[] };
  scope?: { from_bar: number; to_bar: number; section_id?: string };
  sections?: { id: string; kind: string; name?: string; from_bar: number; bars: number; energy?: number }[];
  harmony?: { bar: number; beat?: number; chord: string; roman?: string; beats?: number }[];
  melody?: { track_id?: string; notes: ScpNote[] };
  lyrics?: { language: string; lines: { text: string; section_id?: string; syllables?: { text: string; stressed?: boolean; start_beat?: number; dur?: number; phonemes?: string[] }[] }[] };
  tracks?: { id: string; name?: string; role: string; summary?: string; stem_uri?: string }[];
  context_audio?: { mix_uri?: string; stems?: Record<string, string>; from_bar?: number; to_bar?: number };
  references?: { uri: string; excerpt?: [number, number]; note?: string }[];
  intent?: { text?: string; role?: string; energy?: number; instrument?: string };
  constraints?: {
    hard?: { key?: boolean; bpm?: boolean; length?: boolean; sections?: boolean; range?: [string, string] };
    soft?: { style?: string[]; avoid?: string[]; density?: number };
  };
  policy?: { commercial_only?: boolean; local_only?: boolean };
  context_hash?: string;
}

export interface Contribution {
  kind: 'audio' | 'notes' | 'stems' | 'params' | 'stream';
  files?: { uri: string; role: string; format: 'wav' | 'flac' | 'ogg' | 'mp3'; sample_rate?: number; channels?: number; expires?: string }[];
  notes?: ScpNote[];
  params?: Record<string, unknown>;
  stream?: { transport: 'ws-pcm' | 'webrtc-opus'; url: string; clock_url?: string; sample_rate?: number };
  alignment?: { start_bar?: number; bpm_detected?: number; downbeat_offset_ms?: number; syllables?: { text: string; start_ms: number; end_ms: number }[] };
  claims: { key?: string; bpm?: number; length_bars?: number; meter?: string };
  provenance: { engine: string; engine_version?: string; model_hash?: string; seed?: number; prompt?: string; context_hash?: string; capability?: string; voice?: string; conform?: string[] };
  license: OmepLicense;
  cost_usd?: number;
}

export interface ToolInput {
  context: Scp;
  request?: { text?: string; role?: string; instrument?: string; style?: string; complexity?: number; [k: string]: unknown };
  seed?: number;
  variants?: number;
}
