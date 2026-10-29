// Money for online engines (SPEC v0.6 §9-bis): a quote before every run, a budget per session and per
// month, and a log of what each engine cost. Past the budget nothing online starts without the user's
// confirmation. Kept in this browser (per user, not per song).
import type { EngineInfo } from './router';
import type { Capability, Scp } from './types';

const LOG_KEY = 'openband.ensemble.spend';
export const DEFAULT_BUDGET = { session_usd: 1, month_usd: 5 };

export interface SpendEntry {
  at: number;
  engine: string;
  capability: string;
  usd: number;
}
interface SpendLog {
  month: string;
  entries: SpendEntry[];
}

const monthOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
let session = 0;
/** Where storage isn't available (tests, private windows): kept in memory for this page. */
let memory: SpendLog | null = null;
const hasStorage = () => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
};

function readLog(): SpendLog {
  if (!hasStorage()) return memory && memory.month === monthOf() ? memory : (memory = { month: monthOf(), entries: [] });
  try {
    const l = JSON.parse(localStorage.getItem(LOG_KEY) ?? 'null') as SpendLog | null;
    if (l && l.month === monthOf()) return l;
  } catch {
    // none yet
  }
  return { month: monthOf(), entries: [] };
}

/** What has been spent: this session, this month, and by engine this month. */
export function spending() {
  const log = readLog();
  const byEngine: Record<string, number> = {};
  for (const e of log.entries) byEngine[e.engine] = (byEngine[e.engine] ?? 0) + e.usd;
  return { session_usd: round(session), month_usd: round(log.entries.reduce((s, e) => s + e.usd, 0)), byEngine: Object.fromEntries(Object.entries(byEngine).map(([k, v]) => [k, round(v)])), entries: log.entries.slice(-50) };
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Seconds of music a context asks for. */
export function contextSeconds(scp: Scp) {
  const bpb = Number(String(scp.song.meter ?? '4/4').split('/')[0]) || 4;
  const from = scp.scope?.from_bar ?? 1;
  const to = scp.scope?.to_bar ?? from + scp.song.length_bars;
  return Math.max(1, ((to - from) * bpb * 60) / scp.song.bpm);
}

/** The estimated cost of running an engine (0 for free ones), times the variants. */
export function estimate(e: EngineInfo, _capability: Capability, scp: Scp, variants = 1): number {
  const p = e.manifest.runtime.pricing;
  if (!p) return 0;
  // Per second or per minute of music asked for; per call or per track as it is.
  const one = p.unit === 'second' ? contextSeconds(scp) * p.usd : p.unit === 'minute' ? (contextSeconds(scp) / 60) * p.usd : p.usd;
  return round(one * variants);
}

export class OverBudget extends Error {}

/** Throws (OverBudget) when this run would go past the session or month budget and isn't confirmed. */
export function checkBudget(usd: number, budget: { session_usd: number; month_usd: number }, confirmed = false) {
  if (usd <= 0 || confirmed) return;
  const s = spending();
  if (s.session_usd + usd > budget.session_usd + 1e-9)
    throw new OverBudget(`This would cost about ${usd.toFixed(4)} USD and go past the session budget (${s.session_usd.toFixed(4)} of ${budget.session_usd} USD spent). Ask the user, then retry with confirm_spend: true — or raise the budget in Ensemble.`);
  if (s.month_usd + usd > budget.month_usd + 1e-9)
    throw new OverBudget(`This would cost about ${usd.toFixed(4)} USD and go past the monthly budget (${s.month_usd.toFixed(4)} of ${budget.month_usd} USD spent). Ask the user, then retry with confirm_spend: true — or raise the budget in Ensemble.`);
}

/** Record what a run cost. */
export function recordSpend(engine: string, capability: string, usd: number) {
  if (!(usd > 0)) return;
  session += usd;
  const log = readLog();
  log.entries.push({ at: Date.now(), engine, capability, usd: round(usd) });
  if (!hasStorage()) return void (memory = log);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch {
    // not kept
  }
}

/** For tests. */
export function resetSpending() {
  session = 0;
  memory = null;
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {
    // no storage
  }
}
