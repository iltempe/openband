// "Is there a newer OpenBand?" — asks this repository's latest GitHub release at most once a day (cached
// in a small file; not npm: the npm name "openband" is someone else's, see server/package.mjs),
// never when OPENBAND_NO_UPDATE_CHECK=1. Failures are silent: an update check must never get in the way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO } from './package.mjs';

const DAY = 24 * 60 * 60 * 1000;
export const defaultCacheFile = () => path.join(os.homedir(), '.openband', 'update-check.json');

/** Semver comparison of x.y.z (pre-release tags sort before the release). */
export function newer(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, '').split('-');
    return { n: core.split('.').map((x) => Number(x) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  if (x.pre === y.pre) return false;
  return x.pre === null; // 1.0.0 > 1.0.0-beta
}

/**
 * @param {{ current: string, now?: number, cacheFile?: string, fetchImpl?: typeof fetch, env?: Record<string,string|undefined> }} o
 * @returns {Promise<{ current: string, latest: string, update_available: boolean, checked_at: number } | null>}
 */
export async function checkForUpdate(o) {
  const env = o.env ?? process.env;
  if (env.OPENBAND_NO_UPDATE_CHECK === '1') return null;
  const now = o.now ?? Date.now();
  const file = o.cacheFile ?? defaultCacheFile();
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // no cache yet
  }
  let latest = cached?.latest;
  let checkedAt = cached?.checked_at ?? 0;
  if (!latest || now - checkedAt >= DAY) {
    try {
      const res = await (o.fetchImpl ?? fetch)(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: AbortSignal.timeout(4000), headers: { accept: 'application/vnd.github+json' } });
      if (!res.ok) return null; // also: no release yet
      latest = String((await res.json()).tag_name ?? '').replace(/^v/, '');
      checkedAt = now;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ latest, checked_at: checkedAt }));
    } catch {
      return null;
    }
  }
  if (!latest) return null;
  return { current: o.current, latest, update_available: newer(latest, o.current), checked_at: checkedAt };
}
