// The HT-Demucs model for separation in the browser (SPEC v0.6 §10): 166 MB, so it is never bundled and
// never fetched without the user's OK. Once downloaded (from Hugging Face, pinned to a commit and checked
// against its SHA-256) it stays in this browser's Cache Storage, and separating works offline after.
import { create } from 'zustand';

export interface ModelSource {
  url: string;
  sha256: string;
  bytes: number;
  name: string;
  license: string;
  homepage: string;
}

/** HT-Demucs v4 (Meta, MIT), single-file ONNX export with fp16 weights by StemSplit (MIT). */
export const DEMUCS_MODEL: ModelSource = {
  url: 'https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/d54ed9eb60e258ea82131c6ee14578628816456a/htdemucs_fp16weights.onnx',
  sha256: 'd05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a',
  bytes: 165612636,
  name: 'HT-Demucs v4 (ONNX, fp16 weights)',
  license: 'MIT',
  homepage: 'https://huggingface.co/StemSplitio/htdemucs-onnx',
};

const CACHE = 'openband-models';
let source: ModelSource = DEMUCS_MODEL;
/** Tests point the studio at a stand-in model (same inputs and outputs, a few bytes). */
export function setModelSource(s: ModelSource | null) {
  source = s ?? DEMUCS_MODEL;
  useSeparationModel.setState({ status: 'unknown' });
}
export const modelSource = () => source;

export type ModelStatus = 'unknown' | 'absent' | 'downloading' | 'ready' | 'error';
export const useSeparationModel = create<{ status: ModelStatus; received: number; total: number; error?: string }>(() => ({ status: 'unknown', received: 0, total: 0 }));

/** The user's OK to download, remembered (they can remove the model in Ensemble). */
const CONSENT_KEY = 'openband.separate.consent';
export function hasConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === source.sha256;
  } catch {
    return false;
  }
}
function remember(ok: boolean) {
  try {
    if (ok) localStorage.setItem(CONSENT_KEY, source.sha256);
    else localStorage.removeItem(CONSENT_KEY);
  } catch {
    // not kept: asked again next time
  }
}

const hasCaches = () => typeof caches !== 'undefined';
/** Where Cache Storage isn't available (some embedded browsers): kept in memory for this page. */
let memory: ArrayBuffer | null = null;

export async function cachedModel(): Promise<ArrayBuffer | null> {
  if (memory) return memory;
  if (!hasCaches()) return null;
  try {
    const hit = await (await caches.open(CACHE)).match(source.url);
    return hit ? await hit.arrayBuffer() : null;
  } catch {
    return null;
  }
}

export async function refreshModelStatus(): Promise<ModelStatus> {
  if (useSeparationModel.getState().status === 'downloading') return 'downloading';
  let ok = !!memory;
  if (!ok && hasCaches())
    try {
      ok = !!(await (await caches.open(CACHE)).match(source.url));
    } catch {
      ok = false;
    }
  const status: ModelStatus = ok ? 'ready' : 'absent';
  useSeparationModel.setState({ status, error: undefined });
  return status;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class NeedsDownload extends Error {}

let inflight: Promise<ArrayBuffer> | null = null;

/** Download (with the user's OK), check and keep the model. */
export function downloadModel(o: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<ArrayBuffer> {
  inflight ??= (async () => {
    const s = source;
    useSeparationModel.setState({ status: 'downloading', received: 0, total: s.bytes, error: undefined });
    try {
      const res = await (o.fetch ?? fetch)(s.url, { signal: o.signal });
      if (!res.ok) throw new Error(`Could not download the separation model (HTTP ${res.status})`);
      const total = Number(res.headers.get('content-length')) || s.bytes;
      const parts: Uint8Array[] = [];
      let received = 0;
      const reader = res.body?.getReader();
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          received += value.length;
          useSeparationModel.setState({ received, total });
        }
      else parts.push(new Uint8Array(await res.arrayBuffer()));
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        bytes.set(p, at);
        at += p.length;
      }
      const hash = await sha256Hex(bytes.buffer);
      if (hash !== s.sha256) throw new Error(`The separation model downloaded does not match its checksum (got ${hash.slice(0, 12)}…): not used`);
      remember(true);
      if (hasCaches())
        try {
          await (await caches.open(CACHE)).put(s.url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } }));
        } catch {
          memory = bytes.buffer;
        }
      else memory = bytes.buffer;
      useSeparationModel.setState({ status: 'ready', received: bytes.length, total: bytes.length });
      return bytes.buffer;
    } catch (e) {
      useSeparationModel.setState({ status: 'error', error: (e as Error).message });
      throw e;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The model, downloading it if the user agreed now (confirm) or before. */
export async function ensureModel(confirm = false): Promise<ArrayBuffer> {
  const hit = await cachedModel();
  if (hit) return hit;
  if (!confirm && !hasConsent())
    throw new NeedsDownload(
      `Separating stems in the browser needs a one-time download of the HT-Demucs model (${Math.round(source.bytes / 1e6)} MB, MIT, from Hugging Face); after that it works offline and nothing leaves this computer. Ask the user, then retry with confirm_download: true — or they can download it in Ensemble → Stem separation.`,
    );
  return downloadModel();
}

/** Forget the model (and the OK to download it). */
export async function removeModel() {
  memory = null;
  remember(false);
  if (hasCaches())
    try {
      await (await caches.open(CACHE)).delete(source.url);
    } catch {
      // nothing kept
    }
  useSeparationModel.setState({ status: 'absent', received: 0, total: 0 });
}
