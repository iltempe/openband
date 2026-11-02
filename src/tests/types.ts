// Song tests (C2): a song described by assertions, checked like a CI. Project.tests holds them.
import type { SectionKind } from '../types';

export type TrackRef = 'master' | { track: string } | { role: 'vocal' | 'drums' | 'kick' | 'bass' | 'harmony' | 'lead' };
export type Measure = 'lufs_i' | 'lufs_s_max' | 'true_peak' | 'rms' | 'plr' | 'band_energy' | 'masking' | 'width' | 'correlation' | 'mono_below';

export interface Metric {
  of: TrackRef;
  measure: Measure;
  /** Hz, for band_energy, masking and mono_below. */
  band?: [number, number];
  /** For masking. */
  against?: TrackRef;
}

export type Assertion =
  | { kind: 'compare'; left: Metric; op: '>=' | '<=' | '>' | '<' | 'between'; right: Metric | number | [number, number]; margin?: number }
  | { kind: 'baseline'; metric: Metric; tolerance: number; baseline: string }
  | { kind: 'symbolic'; rule: 'pitch_range' | 'no_overlap' | 'in_key' | 'max_polyphony'; track: string; args?: Record<string, number | string> };

export interface SongTest {
  id: string;
  name: string;
  enabled: boolean;
  severity: 'error' | 'warning';
  scope?: { sections?: (SectionKind | string)[]; tracks?: string[] };
  assert: Assertion;
  /** The line of text it came from, to show and edit. */
  source?: string;
}

export interface TestResult {
  testId: string;
  pass: boolean;
  /** No audio here (the command line without a browser): not judged. */
  skipped?: boolean;
  value?: number;
  expected?: string;
  where?: { section_id?: string; from_beat?: number; to_beat?: number; track_id?: string };
}

export interface TestRun {
  at: number;
  versionId?: string;
  results: TestResult[];
}
