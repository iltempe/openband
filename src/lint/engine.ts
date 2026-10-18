// The linter: runs rules over a project, applies the project's lint settings, gives each issue a
// stable id. Pure (no store, no audio): also used by the openband-lint CLI in CI.
import type { Project, Severity } from '../types';
import type { LintIssue, LintRule } from './types';
import { SYMBOLIC_RULES } from './rules/symbolic';
import { hash } from './util';
import { scalePitchClasses } from '../analysis/key';

const ORDER: Record<Severity, number> = { info: 0, warn: 1, error: 2 };

/** Extra rules (lyrics prosody from F10, audio rules in the browser) register here. */
const extra: LintRule[] = [];
export const registerLintRule = (r: LintRule) => void (extra.some((x) => x.id === r.id) || extra.push(r));
export const allRules = () => [...SYMBOLIC_RULES, ...extra];

export interface LintOptions {
  rules?: string[];
  minSeverity?: Severity;
  /** Include issues the user chose to ignore (default false). */
  includeIgnored?: boolean;
}

export function lint(p: Project, o: LintOptions = {}): { issues: LintIssue[]; counts: Record<Severity, number> } {
  const cfg = p.lint ?? {};
  const ctx = { scale: scalePitchClasses(p.key) };
  const issues: LintIssue[] = [];
  for (const rule of allRules()) {
    if (rule.needsAudio) continue;
    if (o.rules && !o.rules.includes(rule.id)) continue;
    if (cfg.disabled?.includes(rule.id)) continue;
    const severity = cfg.severity?.[rule.id] ?? rule.severity;
    for (const found of rule.check(p, ctx)) {
      const id = `${rule.id}:${hash(JSON.stringify(found.target))}`;
      if (!o.includeIgnored && cfg.ignored?.includes(id)) continue;
      issues.push({ id, rule: rule.id, severity, category: rule.category, ...found });
    }
  }
  const min = ORDER[o.minSeverity ?? 'info'];
  const kept = issues.filter((i) => ORDER[i.severity] >= min).sort((a, b) => ORDER[b.severity] - ORDER[a.severity]);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const i of kept) counts[i.severity]++;
  return { issues: kept, counts };
}
