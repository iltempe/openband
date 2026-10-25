// The speech models for voice commands (SPEC v0.6 G4): Vosk's small Italian and English models (Apache-2.0,
// ~40–50 MB each), downloaded once with the user's OK, checked against the SHA-256 of the official files,
// and kept in this browser — recognition is then offline and private. The official host sends no CORS
// headers, so the files come from Hugging Face mirrors (byte-identical, checked), pinned to a commit; they
// are zips, and vosk-browser reads a .tar.gz, so the page repacks them once.
import { create } from 'zustand';
import { gzipSync, unzipSync } from 'fflate';
import type { Lang } from './grammar';

export interface VoskModel {
  name: string;
  url: string;
  sha256: string;
  bytes: number;
}

export const VOSK_MODELS: Record<Lang, VoskModel> = {
  it: {
    name: 'vosk-model-small-it-0.22',
    url: 'https://huggingface.co/ambind/vosk-model-small-it-0.22/resolve/a1e27778d4c7f7da6162c6d84685921462a59f7f/vosk-model-small-it-0.22.zip',
    sha256: '9ec65e75861d1c6c2e457cccd932705340dcdf233f5b239f00733b4de0bf3267',
    bytes: 49665141,
  },
  en: {
    name: 'vosk-model-small-en-us-0.15',
    url: 'https://huggingface.co/ambind/vosk-model-small-en-us-0.15/resolve/fce51643869da71f41241c10a524f7d5c0fed16e/vosk-model-small-en-us-0.15_c_.zip',
    sha256: '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498',
    bytes: 41205931,
  },
};

const CACHE = 'openband-models';
let sources: Record<Lang, VoskModel> = VOSK_MODELS;
/** Tests point the studio at their own copies. */
export function setVoskSources(s: Partial<Record<Lang, VoskModel>> | null) {
  sources = { ...VOSK_MODELS, ...(s ?? {}) };
}
export const voskSource = (lang: Lang) => sources[lang];

export const useVoiceModels = create<{ status: Partial<Record<Lang, 'absent' | 'downloading' | 'ready' | 'error'>>; received: number; total: number; error?: string }>(() => ({ status: {}, received: 0, total: 0 }));

const consentKey = (lang: Lang) => `openband.voice.consent.${lang}`;
export const hasVoiceConsent = (lang: Lang) => {
  try {
    return localStorage.getItem(consentKey(lang)) === sources[lang].sha256;
  } catch {
    return false;
  }
};

export class NeedsVoiceModel extends Error {}

/** A POSIX tar (ustar) of the files, directories first: what vosk-browser unpacks. */
export function tarOf(files: Record<string, Uint8Array>): Uint8Array {
  const dirs = new Set<string>();
  for (const name of Object.keys(files)) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  const entries: [string, Uint8Array | null][] = [...[...dirs].sort().map((d) => [d, null] as [string, null]), ...Object.entries(files).filter(([n]) => !n.endsWith('/'))];
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, data] of entries) {
    const h = new Uint8Array(512);
    const put = (s: string, at: number, len: number) => h.set(enc.encode(s).subarray(0, len), at);
    const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
    // Long paths: the prefix field (ustar) holds the directories.
    let base = name;
    let prefix = '';
    if (name.length > 100) {
      const cut = name.lastIndexOf('/', name.length - 2 > 155 ? 155 : name.length - 2);
      prefix = name.slice(0, cut);
      base = name.slice(cut + 1);
    }
    put(base, 0, 100);
    put(octal(data ? 0o644 : 0o755, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(data?.length ?? 0, 12), 124, 12);
    put(octal(0, 12), 136, 12);
    h.fill(32, 148, 156); // checksum placeholder: spaces
    h[156] = (data ? '0' : '5').charCodeAt(0);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    put(prefix, 345, 155);
    let sum = 0;
    for (const b of h) sum += b;
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(h);
    if (data) {
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) blocks.push(new Uint8Array(pad));
    }
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const cacheKey = (m: VoskModel) => `${m.url}#tar.gz`;
const memory = new Map<string, Blob>();

/** The model as a blob: URL vosk-browser can load — from this browser, or downloaded now (with OK). */
export async function voskModelUrl(lang: Lang, confirm = false): Promise<string> {
  const m = sources[lang];
  const key = cacheKey(m);
  let blob = memory.get(key) ?? null;
  if (!blob && typeof caches !== 'undefined')
    try {
      const hit = await (await caches.open(CACHE)).match(key);
      if (hit) blob = await hit.blob();
    } catch {
      // no cache
    }
  if (!blob) {
    if (!confirm && !hasVoiceConsent(lang))
      throw new NeedsVoiceModel(`Voice commands in ${lang === 'it' ? 'Italian' : 'English'} need a one-time download of a speech model (${Math.round(m.bytes / 1e6)} MB, Apache-2.0, from Hugging Face); after that they work offline and your voice never leaves this computer.`);
    useVoiceModels.setState((s) => ({ status: { ...s.status, [lang]: 'downloading' }, received: 0, total: m.bytes, error: undefined }));
    try {
      const res = await fetch(m.url);
      if (!res.ok) throw new Error(`Could not download the speech model (HTTP ${res.status})`);
      const reader = res.body?.getReader();
      const parts: Uint8Array[] = [];
      let received = 0;
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          received += value.length;
          useVoiceModels.setState({ received });
        }
      else parts.push(new Uint8Array(await res.arrayBuffer()));
      const zip = new Uint8Array(received || parts[0].length);
      let at = 0;
      for (const p of parts) {
        zip.set(p, at);
        at += p.length;
      }
      if ((await sha256Hex(zip)) !== m.sha256) throw new Error('The speech model downloaded does not match its checksum: not used');
      const files = unzipSync(zip);
      blob = new Blob([gzipSync(tarOf(files), { mtime: 0 })], { type: 'application/gzip' });
      try {
        localStorage.setItem(consentKey(lang), m.sha256);
      } catch {
        // asked again next time
      }
      try {
        await (await caches.open(CACHE)).put(key, new Response(blob));
      } catch {
        memory.set(key, blob);
      }
      useVoiceModels.setState((s) => ({ status: { ...s.status, [lang]: 'ready' } }));
    } catch (e) {
      useVoiceModels.setState((s) => ({ status: { ...s.status, [lang]: 'error' }, error: (e as Error).message }));
      throw e;
    }
  }
  return URL.createObjectURL(blob);
}

export async function voiceModelReady(lang: Lang): Promise<boolean> {
  const key = cacheKey(sources[lang]);
  if (memory.has(key)) return true;
  try {
    return typeof caches !== 'undefined' && !!(await (await caches.open(CACHE)).match(key));
  } catch {
    return false;
  }
}

export async function removeVoiceModel(lang: Lang) {
  memory.delete(cacheKey(sources[lang]));
  try {
    localStorage.removeItem(consentKey(lang));
    await (await caches.open(CACHE)).delete(cacheKey(sources[lang]));
  } catch {
    // nothing kept
  }
  useVoiceModels.setState((s) => ({ status: { ...s.status, [lang]: 'absent' } }));
}

