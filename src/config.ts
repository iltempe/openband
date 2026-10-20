// Instance settings read at start from ./config.json (optional), so a self-hosted OpenBand can be
// configured without rebuilding: its name, the default language, features to turn off (e.g. the
// in-browser chat in a school), the plugin catalog and the collaboration server.
import { create } from 'zustand';

export interface Features {
  /** In-browser chat with the user's own API key (D4). */
  byoKey: boolean;
  /** The WAM plugin catalog and plugin loading. */
  plugins: boolean;
  /** Multiplayer rooms. */
  collab: boolean;
}
export interface InstanceConfig {
  instanceName: string | null;
  defaultLanguage: 'en' | 'it' | null;
  features: Features;
  pluginCatalogUrl: string | null;
  /** y-websocket relay (ws(s)://host) for rooms "on this network", and WebRTC signaling servers. */
  collabServer: { relay?: string; signaling?: string[] } | null;
}

export const DEFAULT_CONFIG: InstanceConfig = {
  instanceName: null,
  defaultLanguage: null,
  features: { byoKey: true, plugins: true, collab: true },
  pluginCatalogUrl: null,
  collabServer: null,
};

/** Merge a config file over the defaults, ignoring anything malformed. */
export function parseConfig(raw: unknown): InstanceConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const f = (c.features && typeof c.features === 'object' ? c.features : {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const cs = c.collabServer && typeof c.collabServer === 'object' ? (c.collabServer as Record<string, unknown>) : null;
  return {
    instanceName: str(c.instanceName),
    defaultLanguage: c.defaultLanguage === 'it' || c.defaultLanguage === 'en' ? c.defaultLanguage : null,
    features: { byoKey: bool(f.byoKey, true), plugins: bool(f.plugins, true), collab: bool(f.collab, true) },
    pluginCatalogUrl: str(c.pluginCatalogUrl),
    collabServer: cs ? { relay: str(cs.relay) ?? undefined, signaling: Array.isArray(cs.signaling) ? cs.signaling.filter((x): x is string => typeof x === 'string') : undefined } : null,
  };
}

export const useConfig = create<InstanceConfig>(() => DEFAULT_CONFIG);
export const getConfig = () => useConfig.getState();

/** The "Connect AI" tabs this instance offers. */
export const connectTabs = (f: Features): ('desktop' | 'cli' | 'key')[] => (f.byoKey ? ['desktop', 'cli', 'key'] : ['desktop', 'cli']);

/** Fetch ./config.json (no file = defaults). Never blocks the start for long. */
export async function loadConfig() {
  try {
    const res = await fetch('./config.json', { cache: 'no-cache', signal: AbortSignal.timeout(1500) });
    if (!res.ok) return;
    const cfg = parseConfig(await res.json());
    useConfig.setState(cfg);
    if (cfg.instanceName) document.title = `${cfg.instanceName} · OpenBand`;
  } catch {
    // defaults
  }
}
