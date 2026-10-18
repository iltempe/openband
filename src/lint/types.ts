import type { Project, Severity } from '../types';

export type LintCategory = 'harmony' | 'rhythm' | 'arrangement' | 'mix' | 'lyrics' | 'structure';

export interface LintTarget {
  track_id?: string;
  region_id?: string;
  note_ids?: string[];
  section_id?: string;
  from_beat?: number;
  to_beat?: number;
}

export interface LintFix {
  label: string;
  /** OpenBand commands (same names/arguments as the MCP tools) applied in one transaction. */
  commands: { method: string; params: Record<string, unknown> }[];
}

export interface LintIssue {
  /** Deterministic: the same problem gets the same id across runs. */
  id: string;
  rule: string;
  severity: Severity;
  category: LintCategory;
  message: string;
  target: LintTarget;
  /** Values for the UI's translated message. */
  params?: Record<string, string | number>;
  fix?: LintFix;
}

export interface LintContext {
  /** Pitch classes of the project key's scale. */
  scale: Set<number>;
}

export interface LintRule {
  id: string;
  category: LintCategory;
  severity: Severity;
  /** Audio rules run only in the browser (they render and analyse the mix). */
  needsAudio?: boolean;
  check(p: Project, ctx: LintContext): Omit<LintIssue, 'id' | 'rule' | 'severity' | 'category'>[];
}
