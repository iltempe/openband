// What a cassette is (D1.1), and how it is packed for delivery. Pure, apart from WebCrypto.
import { canonical, open, seal, sha256, signText, verifyText } from './crypto';

export type BlobRef = { id: string; type: string; bytes: number; sha256: string };

export interface CassetteTrack {
  id: string;
  title: string;
  durationS: number;
  projectId: string;
  versionId: string;
  audio: BlobRef;
  stems?: { part: string; blob: BlobRef }[];
  sections?: { name: string; startS: number; endS: number }[];
  lyrics?: { t: number; end: number; text: string }[];
  chords?: { t: number; chord: string }[];
  beatMap: { bpm: number; offsetS: number };
  note?: string;
}

export type ReturnChannel = { kind: 'https'; url: string } | { kind: 'webrtc'; signaling: string[]; room: string };

export interface CassetteOptions {
  download: boolean;
  reactions: boolean;
  voiceNotes: boolean;
  overdub: boolean;
  duplicate: boolean;
  listenStats: boolean;
  tapeSound: 'off' | 'soft' | 'worn';
}

export interface CassetteManifest {
  format: 'openband-cassette/1';
  seriesId: string;
  edition: number;
  createdAt: number;
  title: string;
  artist: string;
  dedication?: string;
  notes?: string;
  jcard: { cover: BlobRef; style: string; handwritten?: boolean };
  intro?: BlobRef;
  sides: { name: 'A' | 'B'; tracks: CassetteTrack[] }[];
  options: CassetteOptions;
  author: { name: string; signKey: JsonWebKey; boxKey: JsonWebKey };
  returns: ReturnChannel[];
  updates?: string[];
}

export const DEFAULT_OPTIONS: CassetteOptions = { download: true, reactions: true, voiceNotes: true, overdub: false, duplicate: true, listenStats: false, tapeSound: 'soft' };

export const blobRef = async (id: string, type: string, data: Uint8Array): Promise<BlobRef> => ({ id, type, bytes: data.length, sha256: await sha256(data) });

/** The package: everything sealed. Whoever hosts these files sees only noise, not even the titles. */
export interface Package {
  manifest: Uint8Array;
  blobs: Record<string, Uint8Array>;
}

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

export async function packCassette(m: CassetteManifest, blobs: Record<string, Uint8Array>, key: string, signPrivate: JsonWebKey): Promise<Package> {
  const signature = await signText(signPrivate, canonical(m));
  const out: Record<string, Uint8Array> = {};
  for (const [id, data] of Object.entries(blobs)) out[id] = await seal(key, data);
  return { manifest: await seal(key, json({ manifest: m, signature })), blobs: out };
}

export interface Opened {
  manifest: CassetteManifest;
  signature: string;
  /** The signature matches the key inside the manifest. Who that key belongs to is the next question. */
  signed: boolean;
}

export async function openManifest(sealed: Uint8Array, key: string): Promise<Opened> {
  const { manifest, signature } = JSON.parse(new TextDecoder().decode(await open(key, sealed))) as { manifest: CassetteManifest; signature: string };
  return { manifest, signature, signed: await verifyText(manifest.author.signKey, canonical(manifest), signature).catch(() => false) };
}

/** Trust on first use: the first print's signer is remembered; a later one by another key is reported. */
export function signerState(remembered: string | null, current: string): 'first' | 'same' | 'changed' {
  return remembered === null ? 'first' : remembered === current ? 'same' : 'changed';
}

/** Blob ids a manifest refers to. */
export function blobIds(m: CassetteManifest) {
  return [m.jcard.cover.id, ...(m.intro ? [m.intro.id] : []), ...m.sides.flatMap((s) => s.tracks.flatMap((t) => [t.audio.id, ...(t.stems ?? []).map((x) => x.blob.id)]))];
}

export const sideSeconds = (s: { tracks: { durationS: number }[] }) => s.tracks.reduce((n, t) => n + t.durationS, 0);

/** The share link: the key only in the fragment, which browsers never send to a server. */
export const cassetteLink = (base: string, seriesId: string, key: string | null, via?: string) => `${base}#${key ? `k=${key}&` : ''}s=${seriesId}${via ? `&via=${via}` : ''}`;

export function parseLink(hash: string) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  return { key: p.get('k'), seriesId: p.get('s'), via: p.get('via') };
}
