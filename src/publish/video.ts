// The video for YouTube (SPEC v0.6 G6): the cover, the spectrum moving with the music and the lyrics in
// time, encoded with WebCodecs (H.264 + AAC, in a worker) into an MP4. 16:9 for the whole song, or 9:16 for
// Shorts with 15–60 s taken from the chorus. The timing is pure and tested here; drawing is in the worker.
import { create } from 'zustand';
import type { Project } from '../types';
import { renderBuffer } from '../audio/render';
import { releaseOf } from './release';
import { coverPng, PALETTES } from './cover';

export type VideoFormat = '16:9' | '9:16';
export const VIDEO_SIZE: Record<VideoFormat, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
};
export const FPS = 30;
const SHORT_MIN = 15;
const SHORT_MAX = 60;

const secondsOf = (p: Project, beats: number) => (beats * 60) / p.bpm;

/** Which stretch of the song a Short shows: the section asked, else the first chorus, else the middle. */
export function shortsExcerpt(p: Project, songSeconds: number, o: { section_id?: string; max_seconds?: number } = {}): { from: number; to: number; section?: string } {
  const max = Math.max(SHORT_MIN, Math.min(SHORT_MAX, o.max_seconds ?? SHORT_MAX));
  const sections = p.sections ?? [];
  const s = o.section_id ? sections.find((x) => x.id === o.section_id) : sections.find((x) => x.kind === 'chorus');
  if (o.section_id && !s) throw new Error(`Section "${o.section_id}" not found. Call get_structure.`);
  let from = s ? secondsOf(p, s.start) : Math.max(0, songSeconds / 2 - max / 2);
  let to = s ? secondsOf(p, s.start + s.length) : from + max;
  // At least 15 s (a short chorus takes what follows), at most the limit, never past the song.
  if (to - from < SHORT_MIN) to = from + SHORT_MIN;
  to = Math.min(to, from + max, songSeconds);
  if (to - from < SHORT_MIN) from = Math.max(0, to - SHORT_MIN);
  return { from, to, ...(s ? { section: s.name } : {}) };
}

export interface LyricCue {
  /** Seconds from the start of the video. */
  t: number;
  end: number;
  text: string;
}

/** The aligned lyric lines as cues for the stretch [from, to): each line from its first syllable to the next line. */
export function lyricCues(p: Project, from: number, to: number): LyricCue[] {
  const lines = (p.lyrics?.lines ?? [])
    .map((l) => {
      const beats = l.syllables.map((s) => s.beat).filter((b): b is number => typeof b === 'number');
      return beats.length ? { text: l.text.replace(/(\p{L})-(?=\p{L})/gu, '$1'), start: secondsOf(p, Math.min(...beats)), last: secondsOf(p, Math.max(...beats) + 1) } : null;
    })
    .filter((l): l is NonNullable<typeof l> => !!l)
    .sort((a, b) => a.start - b.start);
  return lines
    .map((l, i) => ({ text: l.text, t: l.start - from, end: Math.min(lines[i + 1]?.start ?? Infinity, l.last + 2) - from }))
    .filter((c) => c.end > 0 && c.t < to - from)
    .map((c) => ({ ...c, t: Math.max(0, c.t), end: Math.min(c.end, to - from) }));
}

/** The first frame at or after each cue: when a line really appears on screen. */
export const cueFrames = (cues: LyricCue[], fps = FPS) => cues.map((c) => Math.ceil(c.t * fps - 1e-6) / fps);

export interface VideoResult {
  mp4: Uint8Array;
  format: VideoFormat;
  width: number;
  height: number;
  seconds: number;
  videoCodec: string;
  audioCodec: string;
  from: number;
  to: number;
  section?: string;
  cues: LyricCue[];
  /** When each cue's line first shows, in video seconds. */
  shownAt: number[];
}

export const useVideo = create<{ progress: number | null; url: string | null; format: VideoFormat | null }>(() => ({ progress: null, url: null, format: null }));

/** Render the song, draw and encode the video in a worker. */
export async function renderVideo(p: Project, o: { format?: VideoFormat; section_id?: string; max_seconds?: number } = {}): Promise<VideoResult> {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') throw new Error('This browser has no WebCodecs encoder: make the video in Chrome, Edge or the desktop app');
  const format: VideoFormat = o.format === '9:16' ? '9:16' : '16:9';
  const { width, height } = VIDEO_SIZE[format];
  useVideo.setState({ progress: 0, format });
  try {
    const buf = await renderBuffer(p, { sampleRate: 48000 });
    const songSeconds = buf.duration;
    const range = format === '9:16' ? shortsExcerpt(p, songSeconds, o) : { from: 0, to: songSeconds };
    const a = Math.floor(range.from * buf.sampleRate);
    const b = Math.ceil(range.to * buf.sampleRate);
    const channels = [0, 1].map((c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).slice(a, b));
    if (format === '9:16') fade(channels, buf.sampleRate);
    // The buffers move to the worker: measure them first.
    const seconds = channels[0].length / buf.sampleRate;
    const r = releaseOf(p);
    const recipe = r.cover?.kind === 'generated' ? r.cover : { style: 'bold', palette: 'night', seed: 1 };
    const png = r.cover?.kind === 'image' ? await (await fetch(r.cover.dataUrl)).arrayBuffer() : await coverPng(recipe, { title: r.title, artist: r.artist }, 1080);
    const cover = await createImageBitmap(new Blob([png as BlobPart]));
    const cues = lyricCues(p, range.from, range.to);
    const out = await encodeInWorker({ width, height, fps: FPS, channels, sampleRate: buf.sampleRate, cues, cover, title: r.title, artist: r.artist ?? '', colors: PALETTES[recipe.palette] ?? PALETTES.night, short: format === '9:16' });
    const old = useVideo.getState().url;
    if (old) URL.revokeObjectURL(old);
    useVideo.setState({ progress: null, url: URL.createObjectURL(new Blob([out.mp4 as BlobPart], { type: 'video/mp4' })) });
    return { ...out, format, width, height, seconds, from: range.from, to: range.to, ...('section' in range && range.section ? { section: range.section } : {}), cues, shownAt: cueFrames(cues) };
  } catch (e) {
    useVideo.setState({ progress: null });
    throw e;
  }
}

/** A Short starts and ends softly: 0.3 s in, 1.5 s out. */
function fade(channels: Float32Array[], sr: number) {
  const n = channels[0].length;
  const fin = Math.min(n, Math.round(0.3 * sr));
  const fout = Math.min(n, Math.round(1.5 * sr));
  for (const ch of channels) {
    for (let i = 0; i < fin; i++) ch[i] *= i / fin;
    for (let i = 0; i < fout; i++) ch[n - 1 - i] *= i / fout;
  }
}

export interface WorkerJob {
  width: number;
  height: number;
  fps: number;
  channels: Float32Array[];
  sampleRate: number;
  cues: LyricCue[];
  cover: ImageBitmap;
  title: string;
  artist: string;
  /** Background, accent, ink. */
  colors: [string, string, string];
  short: boolean;
}

function encodeInWorker(job: WorkerJob): Promise<{ mp4: Uint8Array; videoCodec: string; audioCodec: string }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./video.worker.ts', import.meta.url), { type: 'module', name: 'openband-video' });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') return useVideo.setState({ progress: m.value });
      w.terminate();
      if (m.type === 'done') resolve({ mp4: new Uint8Array(m.mp4), videoCodec: m.videoCodec, audioCodec: m.audioCodec });
      else reject(new Error(m.message));
    };
    w.onerror = (e) => (w.terminate(), reject(new Error(e.message || 'the video worker stopped')));
    w.postMessage(job, [job.cover, ...job.channels.map((c) => c.buffer)]);
  });
}
