// The user's API keys, one per provider: kept only in this browser's IndexedDB ("secrets" store) — never
// in the project, the autosave, a .openband bundle, an export or localStorage. "Forget key" deletes it.
// Which provider, model and server address were picked (not secret) is remembered in localStorage.
import { create } from 'zustand';
import { db } from '../audio/samples';
import { providerInfo, type ProviderId } from './models';

export interface KeyStore {
  get(record?: string): Promise<string | null>;
  set(key: string, record?: string): Promise<void>;
  clear(record?: string): Promise<void>;
}

/** The Anthropic record keeps its old name, so keys saved before other providers existed still work. */
const recordOf = (p: ProviderId) => `${p}-api-key`;
async function req<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction('secrets', mode).objectStore('secrets'));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const idbKeyStore: KeyStore = {
  get: async (rec = recordOf('anthropic')) => ((await req<{ id: string; value: string } | undefined>('readonly', (s) => s.get(rec)))?.value ?? null),
  set: async (key, rec = recordOf('anthropic')) => void (await req('readwrite', (s) => s.put({ id: rec, value: key }))),
  clear: async (rec = recordOf('anthropic')) => void (await req('readwrite', (s) => s.delete(rec))),
};

export interface AiChoice {
  provider: ProviderId;
  model: string;
  /** Server address for Ollama and custom OpenAI-compatible servers. */
  baseUrl: string;
}

const PREFS = 'openband.ai';
function loadPrefs(): AiChoice {
  const fallback: AiChoice = { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: '' };
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? 'null') as Partial<AiChoice> | null;
    if (p?.provider && providerInfo(p.provider).id === p.provider) return { ...fallback, ...p };
  } catch {
    // no storage
  }
  return fallback;
}
function savePrefs(c: AiChoice) {
  try {
    localStorage.setItem(PREFS, JSON.stringify({ provider: c.provider, model: c.model, baseUrl: c.baseUrl }));
  } catch {
    // no storage
  }
}

/** The chosen provider and model, and whether it is ready (a key stored, or none needed). The key itself
 *  stays out of React state. */
export const useApiKey = create<AiChoice & { hasKey: boolean; picking: boolean }>(() => ({ ...loadPrefs(), hasKey: false, picking: false }));

/** Back to the AI picker from the chat ("Change AI"). */
export const changeAi = () => useApiKey.setState({ hasKey: false, picking: true });

/** Pick a provider (its first model and default address) or change model / address. */
export function chooseAi(c: Partial<AiChoice>) {
  const cur = useApiKey.getState();
  const provider = c.provider ?? cur.provider;
  const info = providerInfo(provider);
  const switching = provider !== cur.provider;
  const next: AiChoice = {
    provider,
    model: c.model ?? (switching ? (info.models[0]?.id ?? '') : cur.model),
    baseUrl: c.baseUrl ?? (switching ? '' : cur.baseUrl),
  };
  useApiKey.setState(next);
  savePrefs(next);
}

/** The address requests go to: the one typed for Ollama / custom servers, else the provider's. */
export const baseUrlOf = (c: AiChoice) => (c.baseUrl || providerInfo(c.provider).baseUrl).replace(/\/+$/, '');

let store: KeyStore = idbKeyStore;
export const setKeyStore = (s: KeyStore) => void (store = s);
export const getKey = (provider: ProviderId = useApiKey.getState().provider) => store.get(recordOf(provider));

/** Save the key for the chosen provider (or just mark a keyless one as ready). */
export async function saveKey(key: string) {
  const { provider } = useApiKey.getState();
  const info = providerInfo(provider);
  const k = key.trim();
  if (info.needsKey || k) {
    if (info.keyPattern && !info.keyPattern.test(k)) throw new Error(`That does not look like a ${info.name} API key (it starts with ${info.keyHint})`);
    if (!k) throw new Error('Paste an API key');
    await store.set(k, recordOf(provider));
  } else await store.set('none', recordOf(provider));
  useApiKey.setState({ hasKey: true, picking: false });
}
export async function forgetKey() {
  await store.clear(recordOf(useApiKey.getState().provider));
  useApiKey.setState({ hasKey: false });
}
export async function loadKeyState() {
  try {
    useApiKey.setState({ hasKey: !!(await getKey()) });
  } catch {
    // IndexedDB unavailable: no key
  }
}
