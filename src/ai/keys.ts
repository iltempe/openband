// The user's API key: kept only in this browser's IndexedDB ("secrets" store) — never in the
// project, the autosave, a .openband bundle or an export. "Forget key" deletes it.
import { create } from 'zustand';
import { db } from '../audio/samples';
import type { ModelId } from './models';

export interface KeyStore {
  get(): Promise<string | null>;
  set(key: string): Promise<void>;
  clear(): Promise<void>;
}

const REC = 'anthropic-api-key';
async function req<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction('secrets', mode).objectStore('secrets'));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const idbKeyStore: KeyStore = {
  get: async () => ((await req<{ id: string; value: string } | undefined>('readonly', (s) => s.get(REC)))?.value ?? null),
  set: async (key) => void (await req('readwrite', (s) => s.put({ id: REC, value: key }))),
  clear: async () => void (await req('readwrite', (s) => s.delete(REC))),
};

/** Whether a key is stored (the key itself stays out of React state), and the model picked. */
export const useApiKey = create<{ hasKey: boolean; model: ModelId }>(() => ({ hasKey: false, model: 'claude-opus-5-5' }));

let store: KeyStore = idbKeyStore;
export const setKeyStore = (s: KeyStore) => void (store = s);
export const getKey = () => store.get();
export async function saveKey(key: string) {
  const k = key.trim();
  if (!/^sk-ant-[\w-]{10,}$/.test(k)) throw new Error('That does not look like an Anthropic API key (it starts with sk-ant-)');
  await store.set(k);
  useApiKey.setState({ hasKey: true });
}
export async function forgetKey() {
  await store.clear();
  useApiKey.setState({ hasKey: false });
}
export async function loadKeyState() {
  try {
    useApiKey.setState({ hasKey: !!(await store.get()) });
  } catch {
    // IndexedDB unavailable: no key
  }
}
