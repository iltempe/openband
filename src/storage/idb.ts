// The app's IndexedDB: v1 = samples; v2 adds versions and branches (F13); v3 the user's secrets (D4); v4 the journal (F21).
const DB_NAME = 'openband';

let dbPromise: Promise<IDBDatabase> | null = null;
export function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of ['samples', 'versions', 'branches', 'secrets']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('journal')) d.createObjectStore('journal', { keyPath: 'id' }).createIndex('projectId', 'projectId');
    };
    // Another tab still has the older version open: it will reload on its next start.
    req.onblocked = () => console.warn('[openband] close other OpenBand tabs to finish upgrading local storage');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
