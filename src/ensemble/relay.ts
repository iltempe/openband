// Online engines without a local server (SPEC v0.6 §9-bis): the fal models of omep/fal-catalog.json,
// reached through the relay the user deployed on their own account (deploy/relay/). The page knows the
// relay's address and the user's relay token — never the provider's key, which only the relay holds.
import catalog from '../../omep/fal-catalog.json';
import { FalQueue, inputFor, manifestFor, outputsOf } from '../../omep/lib/fal.mjs';
import type { EngineInfo } from './router';
import type { Capability, Contribution, Manifest, ToolInput } from './types';

const KEY = 'openband.ensemble.relay';
export interface RelaySettings {
  url: string;
  token: string;
}

export function relaySettings(): RelaySettings | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as RelaySettings | null;
    return s?.url && s.token ? s : null;
  } catch {
    return null;
  }
}

export function setRelay(s: RelaySettings | null) {
  try {
    if (s) {
      if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(s.url)) throw new Error('The relay address must be https://');
      localStorage.setItem(KEY, JSON.stringify({ url: s.url.replace(/\/+$/, ''), token: s.token }));
    } else localStorage.removeItem(KEY);
  } catch (e) {
    if ((e as Error).message.includes('https')) throw e;
  }
}

type Model = (typeof catalog.models)[number];

/** The catalog's models as engines, when a relay is set. */
export function relayEngines(): EngineInfo[] {
  if (!relaySettings()) return [];
  return catalog.models.map((m) => ({ id: `fal-${m.id}`, manifest: manifestFor(m, catalog.verified) as unknown as Manifest, transport: 'relay' as const, status: 'ready' as const }));
}

/** Run a model through the relay; the audio comes back through it too (as data: URIs). */
export async function callRelay(engineId: string, capability: Capability, input: ToolInput, opts: { fetch?: typeof fetch; pollMs?: number } = {}): Promise<Contribution> {
  const s = relaySettings();
  if (!s) throw new Error('No relay is set up (Ensemble → Online engines)');
  const model = catalog.models.find((m) => `fal-${m.id}` === engineId) as Model | undefined;
  if (!model) throw new Error(`Unknown online engine ${engineId}`);
  const f = opts.fetch ?? fetch.bind(globalThis);
  const queue = new FalQueue({ base: `${s.url}/fal`, token: s.token, fetch: f });
  const scp = input.context;
  const req = input.request ?? {};
  const answer = await queue.run(model.endpoint, inputFor(model, scp, req, input.seed ?? 1), { pollMs: opts.pollMs ?? 1500 });
  const files: NonNullable<Contribution['files']> = [];
  for (const o of outputsOf(model, answer)) {
    const res = await f(`${s.url}/media?url=${encodeURIComponent(o.url)}`, { headers: { 'x-relay-token': s.token } });
    if (!res.ok) throw new Error(`Downloading ${o.role} through the relay: HTTP ${res.status}`);
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const mime = blob.type || 'audio/wav';
    const role = o.role === 'audio' ? (capability === 'music.song' ? 'full' : 'layer') : o.role;
    files.push({ uri: `data:${mime};base64,${btoa(bin)}`, role, format: /mpeg/.test(mime) ? 'mp3' : 'wav' });
  }
  if (!files.length) throw new Error(`${model.name} answered without audio`);
  const seconds = Number(req.seconds) || ((scp.scope?.to_bar ?? 9) - (scp.scope?.from_bar ?? 1)) * 4 * (60 / scp.song.bpm);
  const from = scp.scope?.from_bar ?? 1;
  return {
    kind: capability === 'audio.separate' ? 'stems' : 'audio',
    files,
    alignment: { start_bar: from },
    claims: capability === 'audio.separate' ? {} : { bpm: scp.song.bpm, key: scp.song.key, length_bars: (scp.scope?.to_bar ?? from + scp.song.length_bars) - from },
    provenance: { engine: engineId, engine_version: `1.0.0 (${model.endpoint})`, model_hash: 'none', seed: input.seed ?? 1, capability },
    license: model.license as Contribution['license'],
    cost_usd: Math.round(seconds * model.price.usd * 1e6) / 1e6,
  };
}
