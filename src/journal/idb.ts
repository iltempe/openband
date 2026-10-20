// The journal in IndexedDB (store `journal`, indexed by projectId). Patches and checkpoints are gzipped.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { db } from '../audio/samples';
import type { JournalEntry, JournalStore } from './timeline';

interface Row extends Omit<JournalEntry, 'patch' | 'project'> {
  data: Uint8Array;
}

function done(t: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const idbJournal: JournalStore = {
  async load(projectId) {
    const d = await db();
    const rows = await new Promise<Row[]>((resolve, reject) => {
      const req = d.transaction('journal', 'readonly').objectStore('journal').index('projectId').getAll(projectId);
      req.onsuccess = () => resolve(req.result as Row[]);
      req.onerror = () => reject(req.error);
    });
    return rows
      .sort((a, b) => a.seq - b.seq)
      .map(({ data, ...r }) => {
        const body = JSON.parse(strFromU8(gunzipSync(data)));
        return { ...r, ...(r.kind === 'checkpoint' ? { project: body } : { patch: body }) } as JournalEntry;
      });
  },
  async put(entries) {
    const d = await db();
    const t = d.transaction('journal', 'readwrite');
    const s = t.objectStore('journal');
    for (const { patch, project, ...r } of entries) {
      const data = gzipSync(strToU8(JSON.stringify(r.kind === 'checkpoint' ? project : patch)));
      s.put({ ...r, size: data.length, data } satisfies Row);
    }
    await done(t);
  },
  async remove(ids) {
    const d = await db();
    const t = d.transaction('journal', 'readwrite');
    for (const id of ids) t.objectStore('journal').delete(id);
    await done(t);
  },
};
