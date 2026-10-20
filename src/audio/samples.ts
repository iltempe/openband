// Imported audio: raw bytes live in IndexedDB (they are too big for the project JSON), decoded
// AudioBuffers are cached in memory. Projects reference samples by id.
import { create } from 'zustand';
import { yinTrack } from '../analysis/pitchtrack';

export interface SampleInfo {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
}

interface StoredSample {
  id: string;
  name: string;
  type: string;
  data: ArrayBuffer;
}

const DB_NAME = 'openband';
const STORE = 'samples';

let dbPromise: Promise<IDBDatabase> | null = null;
/** The app's IndexedDB: v1 = samples; v2 adds versions and branches (F13); v3 the user's secrets (D4); v4 the journal (F21). */
export function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of [STORE, 'versions', 'branches', 'secrets']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('journal')) d.createObjectStore('journal', { keyPath: 'id' }).createIndex('projectId', 'projectId');
    };
    // Another tab still has the older version open: it will reload on its next start.
    req.onblocked = () => console.warn('[openband] close other OpenBand tabs to finish upgrading local storage');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const buffers = new Map<string, AudioBuffer>();
const raw = new Map<string, StoredSample>();
const loading = new Map<string, Promise<AudioBuffer | null>>();

/** Reactive index of the samples known in this session, so the UI can re-render when they load. */
export const useSamples = create<{ info: Record<string, SampleInfo>; missing: Record<string, true> }>(() => ({ info: {}, missing: {} }));

const listeners = new Set<() => void>();
/** Called whenever a sample finishes loading (the engine rebuilds what depends on it). */
export const onSamplesChanged = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));

let decodeCtx: BaseAudioContext | null = null;
const ctx = () => (decodeCtx ??= new OfflineAudioContext(1, 1, 44100));

async function decode(data: ArrayBuffer): Promise<AudioBuffer> {
  // decodeAudioData detaches its input, so give it a copy.
  return ctx().decodeAudioData(data.slice(0));
}

async function hashId(data: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return 'smp_' + [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function register(s: StoredSample, buf: AudioBuffer) {
  buffers.set(s.id, buf);
  raw.set(s.id, s);
  useSamples.setState((st) => {
    const missing = { ...st.missing };
    delete missing[s.id];
    return {
      info: { ...st.info, [s.id]: { id: s.id, name: s.name, duration: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels } },
      missing,
    };
  });
  listeners.forEach((fn) => fn());
}

/** Store and decode an audio file (WAV, MP3, OGG, FLAC, AIFF… whatever the browser decodes). */
export async function importSample(data: ArrayBuffer, name: string, type = 'audio/wav'): Promise<SampleInfo> {
  const id = await hashId(data);
  if (!buffers.has(id)) {
    let buf: AudioBuffer;
    try {
      buf = await decode(data);
    } catch {
      throw new Error(`Could not decode “${name}”: unsupported or damaged audio file`);
    }
    const stored = { id, name, type, data };
    try {
      await idb('readwrite', (s) => s.put(stored));
    } catch {
      // storage full or unavailable: the sample still works for this session
    }
    register(stored, buf);
  }
  return useSamples.getState().info[id];
}

/** Make sure the given samples are decoded in memory (loads them from IndexedDB). */
export async function ensureSamples(ids: Iterable<string>): Promise<void> {
  await Promise.all([...new Set(ids)].map(loadSample));
}

function loadSample(id: string): Promise<AudioBuffer | null> {
  if (buffers.has(id)) return Promise.resolve(buffers.get(id)!);
  if (!loading.has(id)) {
    loading.set(
      id,
      (async () => {
        try {
          const s = (await idb<StoredSample | undefined>('readonly', (st) => st.get(id))) ?? null;
          if (!s) throw new Error('missing');
          const buf = await decode(s.data);
          register(s, buf);
          return buf;
        } catch {
          useSamples.setState((st) => ({ missing: { ...st.missing, [id]: true } }));
          return null;
        } finally {
          loading.delete(id);
        }
      })(),
    );
  }
  return loading.get(id)!;
}

export const getBuffer = (id: string) => buffers.get(id);
export const getStoredSample = (id: string) => raw.get(id);
export const sampleName = (id: string) => useSamples.getState().info[id]?.name ?? id;

// ---------- analysis ----------

const peakCache = new Map<string, Float32Array>();
const PEAK_RES = 256; // frames per peak bucket

/** Max-abs peaks of a sample (mono mix), at PEAK_RES frames per value. */
export function getPeaks(id: string): { peaks: Float32Array; secondsPerPeak: number } | null {
  const buf = buffers.get(id);
  if (!buf) return null;
  let peaks = peakCache.get(id);
  if (!peaks) {
    const n = Math.ceil(buf.length / PEAK_RES);
    peaks = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        let m = 0;
        const end = Math.min(d.length, (i + 1) * PEAK_RES);
        for (let j = i * PEAK_RES; j < end; j++) {
          const v = Math.abs(d[j]);
          if (v > m) m = v;
        }
        if (m > peaks[i]) peaks[i] = m;
      }
    }
    peakCache.set(id, peaks);
  }
  return { peaks, secondsPerPeak: PEAK_RES / buf.sampleRate };
}

/** Fundamental of a sample (YIN over its steady part) → nearest MIDI pitch, or undefined if unclear. */
export function detectPitch(id: string): number | undefined {
  const buf = buffers.get(id);
  if (!buf) return undefined;
  const rate = buf.sampleRate;
  const d = buf.getChannelData(0);
  // Skip the attack, look at up to half a second.
  const x = d.subarray(Math.min(d.length, Math.floor(rate * 0.05)), Math.min(d.length, Math.floor(rate * 0.55)));
  const voiced = yinTrack(x, rate).filter((f) => f.midi !== null).map((f) => f.midi!);
  if (voiced.length < 4) return undefined;
  voiced.sort((a, b) => a - b);
  return Math.round(voiced[Math.floor(voiced.length / 2)]);
}

/** Note name in a file name ("Piano_C#4.wav", "bass-A2") → MIDI pitch. */
export function pitchFromName(name: string): number | undefined {
  const m = name.replace(/\.[^.]+$/, '').match(/(?:^|[^a-z])([A-G])([#b]?)(-?\d)(?![a-z0-9])/i);
  if (!m) return undefined;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase() as 'C'];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + base + acc;
}

/** Encode mono float PCM as a 16-bit WAV file (used for samples extracted from SoundFonts). */
export function encodeMonoWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const data = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  data.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  str(36, 'data');
  data.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    data.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return data.buffer;
}
