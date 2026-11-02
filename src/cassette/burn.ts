// Burning a cassette (D1.4): a render per version, the same loudness across the tape, AAC, a sealed package.
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { create } from 'zustand';
import { renderBuffer } from '../audio/render';
import { loudness, truePeak } from '../analysis/loudness';
import { analyzeChords } from '../analysis/harmony';
import { idbKeyStore } from '../ai/keys';
import { lyricCues } from '../publish/video';
import { coverPng } from '../publish/cover';
import { uid } from '../music';
import { tx } from '../storage/idb';
import type { Project } from '../types';
import { getSnapshot } from '../versioning';
import { zipSync } from 'fflate';
import { ACCOMPANIMENT, mixStems, packName, partOf } from './parts';
import { newIdentity, newSeriesKey, type Identity } from './crypto';
import { returnsRoom } from './p2p';
import { DEFAULT_OPTIONS, blobRef, packCassette, type CassetteManifest, type CassetteOptions, type CassetteTrack, type Package } from './format';

export const TARGET_LUFS = -14;
export const TARGET_PEAK = -1;
const RATE = 48000;

/** The gain that brings a song to the target without passing the ceiling. Pure. */
export function tapeGain(lufs: number, peakDb: number, target = TARGET_LUFS, ceiling = TARGET_PEAK) {
  if (!Number.isFinite(lufs)) return 1;
  return 10 ** (Math.min(target - lufs, ceiling - peakDb) / 20);
}

/** Tape lengths: minutes per side. */
export const TAPES = { C60: 30, C90: 45 };

export async function encodeAac(channels: Float32Array[], sampleRate: number, bitrate: number) {
  if (typeof AudioEncoder === 'undefined') throw new Error('This browser cannot encode AAC. Use a recent Chrome, Edge or Safari.');
  // Some builds of Chromium on Linux have no AAC encoder: Opus then, which every recent browser plays.
  const aac = (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate }).catch(() => null))?.supported;
  if (!aac) useBurn.setState({ warning: 'opus' });
  const muxer = new Muxer({ target: new ArrayBufferTarget(), audio: { codec: aac ? 'aac' : 'opus', numberOfChannels: 2, sampleRate }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let failed: Error | null = null;
  const enc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (failed = e) });
  enc.configure({ codec: aac ? 'mp4a.40.2' : 'opus', sampleRate, numberOfChannels: 2, bitrate });
  const [L, R] = [channels[0], channels[1] ?? channels[0]];
  for (let i = 0; i < L.length; i += 4800) {
    const n = Math.min(4800, L.length - i);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(i, i + n), 0);
    data.set(R.subarray(i, i + n), n);
    const frame = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / sampleRate) * 1e6), data });
    if (failed) throw failed;
    enc.encode(frame);
    frame.close();
    while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 1));
  }
  await enc.flush();
  enc.close();
  if (failed) throw failed;
  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}

const cache = new Map<string, { channels: Float32Array[]; durationS: number }>();
/** A version already burnt isn't rendered again. */
async function renderVersion(versionId: string, p: Project) {
  const hit = cache.get(versionId);
  if (hit) return hit;
  const buf = await renderBuffer(p, { sampleRate: RATE, tailSeconds: 1 });
  const r = { channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)), durationS: buf.duration };
  cache.set(versionId, r);
  return r;
}

function trackInfo(p: Project, versionId: string, durationS: number, audio: CassetteTrack['audio'], title?: string, note?: string): CassetteTrack {
  const spb = 60 / p.bpm;
  const end = (durationS / spb) | 0;
  const melodic = new Set(p.tracks.filter((t) => t.kind === 'instrument' && !t.mute).map((t) => t.id));
  const notes = p.regions.filter((r) => melodic.has(r.trackId) && !r.audio && r.trackId !== p.lyrics?.melodyTrackId).flatMap((r) => r.notes.map((n) => ({ ...n, start: r.start + n.start })));
  return {
    id: uid('tk'),
    title: title || p.name,
    durationS,
    projectId: p.meta?.projectId ?? 'local',
    versionId,
    audio,
    sections: (p.sections ?? []).map((s) => ({ name: s.name, startS: s.start * spb, endS: (s.start + s.length) * spb })),
    lyrics: lyricCues(p, 0, end),
    chords: analyzeChords(notes as never, p.key, 0, end).map((c) => ({ t: c.start * spb, chord: c.chord })),
    beatMap: { bpm: p.bpm, offsetS: 0 },
    note,
  };
}

/** A render per part and one of the rest, at 96 kbps: the weight stays near the plain cassette's. */
export async function stemsOf(p: Project) {
  const parts = new Map<string, string[]>();
  for (const t of p.tracks) {
    const part = partOf(t.name) ?? ACCOMPANIMENT;
    parts.set(part, [...(parts.get(part) ?? []), t.id]);
  }
  const out: { part: string; channels: Float32Array[] }[] = [];
  for (const [part, ids] of parts) {
    const buf = await renderBuffer(p, { tracks: ids, includeMaster: false, sampleRate: RATE, tailSeconds: 1 });
    out.push({ part, channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)) });
  }
  return out;
}

async function burnStems(p: Project, g: number, blobs: Record<string, Uint8Array>) {
  const out: NonNullable<CassetteTrack['stems']> = [];
  for (const s of await stemsOf(p)) {
    const data = await encodeAac(s.channels.map((c) => c.map((v) => v * g)), RATE, 96000);
    const id = uid('blob');
    blobs[id] = data;
    out.push({ part: s.part, blob: await blobRef(id, 'audio/mp4', data) });
  }
  return out;
}

/** The classic pack: for each part in evidence, muted and on the left, plus the balanced mix. */
export async function partsPack(versionIds: { versionId: string; title?: string }[]) {
  const files: Record<string, Uint8Array> = {};
  for (const [i, v] of versionIds.entries()) {
    const p = await getSnapshot(v.versionId);
    const title = v.title || p.name;
    useBurn.setState({ step: title });
    const stems = await stemsOf(p);
    files[packName(i + 1, title, null)] = await encodeAac(mixStems(stems, 'all', null), RATE, 128000);
    for (const s of stems.filter((x) => x.part !== ACCOMPANIMENT))
      for (const mode of ['highlight', 'mute', 'left'] as const) files[packName(i + 1, title, s.part, mode)] = await encodeAac(mixStems(stems, mode, s.part), RATE, 128000);
  }
  useBurn.setState({ step: null });
  return zipSync(files, { level: 0 });
}

export interface BurnSpec {
  title: string;
  artist: string;
  dedication?: string;
  notes?: string;
  sides: { name: 'A' | 'B'; tracks: { versionId: string; title?: string; note?: string }[] }[];
  options?: Partial<CassetteOptions>;
  quality?: 96 | 160 | 256;
  normalize?: boolean;
  intro?: { channels: Float32Array[]; sampleRate: number };
  /** Each song with its parts (D4). */
  parts?: boolean;
  /** The instance that serves it: returns go straight there, and later prints are announced there. */
  instance?: string;
  /** Signaling servers the musician chose: the P2P road for returns. */
  signaling?: string[];
  /** An existing series: a new print keeps its key and signature. */
  series?: { seriesId: string; key: string; edition: number };
  returns?: CassetteManifest['returns'];
}

export interface StoredCassette {
  id: string;
  seriesId: string;
  edition: number;
  key: string;
  title: string;
  manifest: CassetteManifest;
  pkg: Package;
  createdAt: number;
  password?: boolean;
}

export const useBurn = create<{ step: string | null; warning?: 'opus' }>(() => ({ step: null }));

const IDENTITY = 'cassette-identity';
/** The musician's keys, made at the first cassette. They never leave this instance. */
export async function identity(): Promise<Identity> {
  const saved = await idbKeyStore.get(IDENTITY);
  if (saved) return JSON.parse(saved) as Identity;
  const id = await newIdentity();
  await idbKeyStore.set(JSON.stringify(id), IDENTITY);
  return id;
}

export async function burn(spec: BurnSpec): Promise<StoredCassette> {
  if (!spec.sides.some((s) => s.tracks.length)) throw new Error('A cassette needs at least one song');
  const id = await identity();
  const seriesId = spec.series?.seriesId ?? uid('tape');
  const key = spec.series?.key ?? newSeriesKey();
  const edition = spec.series ? spec.series.edition + 1 : 1;
  const blobs: Record<string, Uint8Array> = {};
  const sides: CassetteManifest['sides'] = [];
  const bitrate = (spec.quality ?? 160) * 1000;
  for (const side of spec.sides) {
    const tracks: CassetteTrack[] = [];
    for (const t of side.tracks) {
      const p = await getSnapshot(t.versionId);
      useBurn.setState({ step: `${side.name}: ${t.title || p.name}` });
      const r = await renderVersion(t.versionId, p);
      const st = loudness(r.channels, RATE);
      const peak = Math.max(...r.channels.map(truePeak));
      const g = spec.normalize === false ? 1 : tapeGain(st.integrated, peak);
      const data = await encodeAac(r.channels.map((c) => c.map((v) => v * g)), RATE, bitrate);
      const bid = uid('blob');
      blobs[bid] = data;
      const info = trackInfo(p, t.versionId, r.durationS, await blobRef(bid, 'audio/mp4', data), t.title, t.note);
      if (spec.parts) info.stems = await burnStems(p, g, blobs);
      tracks.push(info);
    }
    sides.push({ name: side.name, tracks });
  }
  useBurn.setState({ step: 'cover' });
  const cover = await coverPng({ style: 'bold', palette: 'night', seed: seriesId.length * 7 + edition } as never, { title: spec.title, artist: spec.artist }, 800);
  blobs.cover = cover;
  let intro: CassetteManifest['intro'];
  if (spec.intro) {
    const data = await encodeAac(spec.intro.channels, spec.intro.sampleRate, 96000);
    blobs.intro = data;
    intro = await blobRef('intro', 'audio/mp4', data);
  }
  const manifest: CassetteManifest = { format: 'openband-cassette/1', seriesId, edition, createdAt: Date.now(), title: spec.title, artist: spec.artist, dedication: spec.dedication, notes: spec.notes, jcard: { cover: await blobRef('cover', 'image/png', cover), style: 'bold' }, intro, sides, options: { ...DEFAULT_OPTIONS, ...spec.options }, author: { name: spec.artist, signKey: id.sign.publicKey, boxKey: id.box.publicKey }, updates: spec.instance ? [`${spec.instance}/c/${seriesId}/latest.bin`] : undefined, returns: [...(spec.returns ?? []).filter((r) => r.kind !== 'webrtc'), ...(spec.instance?.startsWith('https:') ? [{ kind: 'https' as const, url: spec.instance }] : []), ...(spec.signaling?.length ? [{ kind: 'webrtc' as const, signaling: spec.signaling, room: await returnsRoom(key) }] : [])] };
  useBurn.setState({ step: 'sealing' });
  const pkg = await packCassette(manifest, blobs, key, id.sign.privateKey);
  const stored: StoredCassette = { id: `${seriesId}:${edition}`, seriesId, edition, key, title: spec.title, manifest, pkg, createdAt: manifest.createdAt };
  await tx('cassettes', 'readwrite', (s) => s.put(stored));
  useBurn.setState({ step: null });
  return stored;
}

export const listCassettes = async () => ((await tx<StoredCassette[]>('cassettes', 'readonly', (s) => s.getAll())) ?? []).sort((a, b) => b.createdAt - a.createdAt);
export const getCassette = async (id: string) => (await tx<StoredCassette | undefined>('cassettes', 'readonly', (s) => s.get(id))) ?? null;
export const latestOf = async (seriesId: string) => (await listCassettes()).filter((c) => c.seriesId === seriesId).sort((a, b) => b.edition - a.edition)[0] ?? null;
