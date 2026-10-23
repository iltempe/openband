// The capability router (SPEC v0.6 §4): for each request, which engine plays. Pure.
//   1. hard filters — licence (commercial_only), privacy (local_only / cloud allowed), status, capability,
//      the conditioning the request needs (e.g. lyrics), language; each exclusion says why;
//   2. a score — measured adherence, the user's learned preference (E4), expected latency;
//   3. strategies — best (one engine), fallback (the ordered list to try), pinned (an engine named by the
//      user or the conductor; it still has to pass the hard filters).
import type { Capability, Manifest, Where } from './types';

export interface EngineInfo {
  id: string;
  manifest: Manifest;
  /** builtin: runs in the page; bridge: an external engine hosted by the local server. */
  transport: 'builtin' | 'bridge';
  status: 'ready' | 'error' | 'unavailable';
  error?: string;
  /** Measured by conformance or by the studio's corrections (0..1); unknown engines start at 0.7. */
  adherence?: number;
}

export interface Policy {
  /** Exclude engines (and online providers) whose licence doesn't allow commercial use. Default on. */
  commercial_only: boolean;
  /** Only engines on this computer (builtin, browser, local). */
  local_only: boolean;
  /** Online engines (they cost money and send data): off until the user turns them on. */
  allow_cloud: boolean;
  /** Engines with a conditional licence whose conditions the user accepted. */
  accepted_conditions: string[];
}

export const DEFAULT_POLICY: Policy = { commercial_only: true, local_only: false, allow_cloud: false, accepted_conditions: [] };

export interface RouteRequest {
  capability: Capability;
  /** Conditioning the request depends on (lyrics to sing, a melody to harmonize…). */
  needs?: string[];
  language?: string;
  /** A pinned engine id. */
  engine?: string;
}

export interface Route {
  capability: Capability;
  /** Best first: the first is used, the others are the fallback chain. */
  candidates: (EngineInfo & { score: number })[];
  excluded: { id: string; name: string; reason: string }[];
}

const LATENCY: Record<Where, number> = { builtin: 1, browser: 0.9, local: 0.6, lan: 0.5, cloud: 0.4 };

/** Why an engine can't take this request, or null. */
export function exclusion(e: EngineInfo, req: RouteRequest, policy: Policy): string | null {
  const m = e.manifest;
  const cap = m.capabilities[req.capability];
  if (!cap) return `doesn't offer ${req.capability}`;
  if (e.status !== 'ready') return e.error ? `not available: ${e.error}` : 'not available';
  const where = m.runtime.where;
  if (policy.local_only && (where === 'cloud' || where === 'lan')) return `runs ${where === 'cloud' ? 'online' : 'on another computer'}, and only local engines are allowed`;
  if (where === 'cloud' && !policy.allow_cloud) return 'online engines are off (they cost money and send data): turn them on in Ensemble';
  const commercial = [m.license.commercial, ...(m.runtime.output_rights ? [m.runtime.output_rights.commercial] : [])];
  if (policy.commercial_only && commercial.includes('no')) return 'its licence doesn’t allow commercial use (turn off “commercial use only” to use it)';
  if (commercial.includes('conditional') && !policy.accepted_conditions.includes(e.id)) return `conditional licence, accept its conditions first: ${m.license.conditions ?? 'see the licence'}`;
  const missing = (req.needs ?? []).filter((n) => !(cap.conditioning ?? []).includes(n));
  if (missing.length) return `doesn't use ${missing.join(', ')}`;
  if (req.language && m.languages?.length && !m.languages.some((l) => l === req.language || l.startsWith(`${req.language}-`))) return `doesn't support ${req.language}`;
  return null;
}

/** Preferences learned from blind tests (E4): capability → engine id → 0..1. */
export type Preferences = Record<string, Record<string, number>>;

export function route(req: RouteRequest, engines: EngineInfo[], policy: Policy = DEFAULT_POLICY, prefs: Preferences = {}): Route {
  const excluded: Route['excluded'] = [];
  const ok: (EngineInfo & { score: number })[] = [];
  for (const e of engines) {
    if (!e.manifest.capabilities[req.capability]) continue;
    const why = exclusion(e, req, policy);
    if (why) {
      excluded.push({ id: e.id, name: e.manifest.engine.name, reason: why });
      continue;
    }
    const adherence = e.adherence ?? (e.transport === 'builtin' ? 0.95 : 0.7);
    const pref = prefs[req.capability]?.[e.id] ?? 0.5;
    ok.push({ ...e, score: 0.6 * adherence + 0.25 * pref + 0.15 * LATENCY[e.manifest.runtime.where] });
  }
  ok.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (req.engine) {
    const pinned = ok.find((e) => e.id === req.engine);
    if (!pinned) {
      const why = excluded.find((x) => x.id === req.engine)?.reason ?? (engines.some((e) => e.id === req.engine) ? `doesn't offer ${req.capability}` : 'is not installed');
      throw new Error(`The engine "${req.engine}" can't do this: ${why}`);
    }
    return { capability: req.capability, candidates: [pinned], excluded };
  }
  return { capability: req.capability, candidates: ok, excluded };
}

/**
 * Which capability a request is, when the caller doesn't say: the target track and the words decide.
 * (The conductor can always name one; E2 adds `transform` and the rest of the catalog.)
 */
export function inferCapability(o: { capability?: string; trackKind?: 'instrument' | 'drums' | 'audio'; text?: string }): Capability {
  if (o.capability) return o.capability as Capability;
  const t = (o.text ?? '').toLowerCase();
  if (/\b(sing|canta|cantat|vocal|voce)\b/.test(t)) return 'voice.sing';
  if (/\b(drum|drums|batteria|beat|groove|percuss|ritmica)\w*/.test(t) || o.trackKind === 'drums') return 'symbolic.drums';
  if (/\b(audio|recorded|registrat|loop)\b/.test(t) || o.trackKind === 'audio') return 'music.add_layer';
  return 'symbolic.accompany';
}
