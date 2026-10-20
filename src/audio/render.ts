// Offline rendering: the whole song, a range, or single tracks (stems), as AudioBuffers or a WAV.
import * as Tone from 'tone';
import type { Project, TrackFx } from '../types';
import { faderToDb, sendToDb } from '../music';
import { projectEnd, projectSampleIds } from '../store';
import { ensureSamples, getBuffer } from './samples';
import { createInstrument, makeImpulse, seeded } from './instruments';
import { FxChain, normalizeFx } from './fx';
import { effectiveValue, hasAutomation } from '../automation';

const dbToGain = (db: number) => (db === -Infinity ? 0 : Math.pow(10, db / 20));

export interface RenderOptions {
  /** Range in beats (default: the whole song). */
  fromBeat?: number;
  toBeat?: number;
  /** Only these tracks (stems), ignoring mute/solo. Default: the mix, respecting mute/solo. */
  tracks?: string[];
  /** Apply the master volume (default true). */
  includeMaster?: boolean;
  sampleRate?: number;
  /** Extra seconds after toBeat for reverb/delay tails (default 3; 0 for section analysis). */
  tailSeconds?: number;
  /** Render one track with its FX chain (slotId null) or one plugin bypassed (level match, F20). */
  bypass?: { trackId: string; slotId: string | null };
}

/** A chain with everything off (slotId null) or without one plugin, and without the output trim. */
export function bypassed(fx: TrackFx | undefined, slotId: string | null): TrackFx | undefined {
  if (!fx) return fx;
  if (slotId === null) {
    const n = normalizeFx(fx);
    return { amp: { ...n.amp, on: false }, eq: { ...n.eq, on: false }, comp: { ...n.comp, on: false }, plugins: [] };
  }
  return { ...fx, plugins: (fx.plugins ?? []).filter((s) => s.id !== slotId) };
}

// Small LRU of recent renders: analysis tools often render the same song several times in a row.
const CACHE_SIZE = 3;
const cache = new Map<string, Promise<AudioBuffer>>();
export const clearRenderCache = () => cache.clear();

/** Render a project (or part of it) offline into an AudioBuffer. */
export function renderBuffer(p: Project, o: RenderOptions = {}): Promise<AudioBuffer> {
  const key = JSON.stringify([p, o]);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const job = renderUncached(p, o);
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return job;
}

/** Each track rendered on its own (in sequence, to limit memory), over the same range. */
export async function renderStems(p: Project, o: RenderOptions = {}): Promise<Record<string, AudioBuffer>> {
  const ids = o.tracks ?? p.tracks.filter((t) => !t.mute).map((t) => t.id);
  const out: Record<string, AudioBuffer> = {};
  for (const id of ids) out[id] = await renderBuffer(p, { ...o, tracks: [id] });
  return out;
}

/** The whole song as a 16-bit stereo WAV (what "Export song as WAV" does). */
export async function renderProject(p: Project): Promise<Blob> {
  return encodeWav(await renderBuffer(p));
}

async function renderUncached(p: Project, o: RenderOptions): Promise<AudioBuffer> {
  const bypass = o.bypass;
  const fromBeat = Math.max(0, o.fromBeat ?? 0);
  const toBeat = Math.max(fromBeat + 0.25, o.toBeat ?? Math.max(projectEnd(p), 4));
  const sampleRate = o.sampleRate ?? 44100;
  const seconds = ((toBeat - fromBeat) * 60) / p.bpm + (o.tailSeconds ?? 3);
  const anySolo = p.tracks.some((t) => t.solo);
  const included = (id: string, mute: boolean, solo: boolean) => (o.tracks ? o.tracks.includes(id) : !mute && !(anySolo && !solo));
  await ensureSamples(projectSampleIds(p));

  // Like Tone.Offline, but on a native OfflineAudioContext (WAM plugins need one) and waiting for
  // plugins to load before rendering.
  const ctx = new Tone.OfflineContext(new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate));
  const loading: Promise<unknown>[] = [];
  const live = Tone.getContext();
  Tone.setContext(ctx);
  try {
    const transport = ctx.transport;
    transport.bpm.value = p.bpm;
    const PPQ = transport.PPQ;
    const ticks = (beat: number) => `${Math.round(beat * PPQ)}i`;
    const secs = (beats: number) => (beats * 60) / p.bpm;
    const master = new Tone.Gain(o.includeMaster === false ? 1 : dbToGain(faderToDb(p.masterVolume))).toDestination();
    const reverb = new Tone.Convolver(makeImpulse(2.8, 3.2)).connect(master);
    const delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.34, wet: 1 }).connect(master);

    for (const track of p.tracks) {
      if (!included(track.id, track.mute, track.solo)) continue;
      const inst = createInstrument(track.instrument, p.instruments?.find((c) => c.id === track.instrument));
      inst.setCutoff(track.cutoff);
      const ch = new Tone.Channel({ volume: faderToDb(track.volume), pan: track.pan }).connect(master);
      if ('ready' in inst) loading.push((inst as { ready: Promise<void> }).ready);
      const fx = new FxChain();
      fx.update(bypass?.trackId === track.id ? bypassed(track.fx, bypass.slotId) : track.fx);
      loading.push(fx.ready);
      inst.output.connect(fx.input);
      // Polarity is part of the mix (exported); mono and dim are monitoring only and never get here.
      fx.output.connect(new Tone.Gain(track.polarity ? -1 : 1).connect(ch));
      const revSend = new Tone.Gain(dbToGain(sendToDb(track.reverb))).connect(reverb);
      const delSend = new Tone.Gain(dbToGain(sendToDb(track.delay)) * 0.7).connect(delay);
      ch.connect(revSend);
      ch.connect(delSend);
      if (hasAutomation(track)) {
        const auto = track.automation!;
        transport.scheduleRepeat((time) => {
          const beat = transport.getTicksAtTime(time) / PPQ;
          const v = (p: 'volume' | 'pan' | 'tone' | 'reverb' | 'echo') => effectiveValue(track, p, beat);
          if (auto.volume?.length) ch.volume.rampTo(Math.max(-100, faderToDb(v('volume'))), 0.03, time);
          if (auto.pan?.length) ch.pan.rampTo(v('pan'), 0.03, time);
          if (auto.reverb?.length) revSend.gain.rampTo(dbToGain(sendToDb(v('reverb'))), 0.03, time);
          if (auto.echo?.length) delSend.gain.rampTo(dbToGain(sendToDb(v('echo'))) * 0.7, 0.03, time);
          if (auto.tone?.length) inst.setCutoff(v('tone'), time);
        }, '32n', 0);
      }

      for (const region of p.regions.filter((r) => r.trackId === track.id)) {
        if (region.start >= toBeat || region.start + region.length <= fromBeat) continue;
        if (region.audio) {
          const clip = region.audio;
          const buffer = getBuffer(clip.sampleId);
          if (!buffer) continue;
          // A clip already playing at fromBeat starts from the right point inside the sample.
          const skip = Math.max(0, fromBeat - region.start);
          const offset = clip.offset + secs(skip);
          const dur = Math.min(secs(region.length - skip), buffer.duration - offset);
          if (dur <= 0) continue;
          const player = new Tone.Player({ url: new Tone.ToneAudioBuffer(buffer), fadeIn: 0.004, fadeOut: 0.01 }).connect(inst.output);
          player.volume.value = clip.gain > 0 ? 20 * Math.log10(clip.gain) : -Infinity;
          transport.schedule((time) => player.start(time, offset, dur), ticks(region.start + skip));
          continue;
        }
        for (const n of region.notes) {
          if (n.start < 0 || n.start >= region.length) continue;
          const at = region.start + n.start;
          const end = region.start + Math.min(n.start + n.duration, region.length);
          if (at >= toBeat || end <= fromBeat) continue;
          // Notes held across fromBeat sound from fromBeat for their remaining length.
          const from = Math.max(at, fromBeat);
          transport.schedule((time) => {
            inst.trigger(n.pitch, secs(end - from), time, n.velocity);
          }, ticks(from));
        }
      }
    }
    transport.start(0, ticks(fromBeat));
  } finally {
    Tone.setContext(live);
  }
  await Promise.all(loading);
  // Some WAM instruments keep MIDI events in a main-thread queue that is drained as audio time
  // advances, which never happens while an offline context renders in one go. Pause every 20 ms
  // of audio and yield to the main thread so those queues keep up.
  if (p.instruments?.some((c) => c.source === 'wam' && p.tracks.some((t) => t.instrument === c.id && included(t.id, t.mute, t.solo)))) {
    const raw = ctx.rawContext as unknown as OfflineAudioContext;
    const step = 0.02;
    const pause = (at: number) =>
      raw.suspend(at).then(() =>
        setTimeout(() => {
          if (at + step < seconds) void pause(+(at + step).toFixed(6));
          void raw.resume();
        }, 0),
      );
    void pause(step);
  }
  // Tone starts noise sources (snares, hats, claps) at a random point of a noise buffer. Seed it for
  // the duration of the render so the same song always renders to the same audio (stems add up to
  // the mix, analyses are repeatable). Live playback is untouched.
  // Tone builds its noise buffers lazily on first use; build them now, outside the seeded section.
  for (const type of ['white', 'pink', 'brown'] as const) {
    const n = new Tone.Noise({ type, context: ctx });
    n.start(0).stop(0);
    n.dispose();
  }
  const random = Math.random;
  Math.random = seeded(0x5eed);
  try {
    const buffer = await ctx.render();
    return buffer.get() as AudioBuffer;
  } finally {
    Math.random = random;
  }
}

export function encodeWav(buf: AudioBuffer): Blob {
  const chans = Math.min(2, buf.numberOfChannels);
  const len = buf.length;
  const data = new DataView(new ArrayBuffer(44 + len * chans * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  data.setUint32(4, 36 + len * chans * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, chans, true);
  data.setUint32(24, buf.sampleRate, true);
  data.setUint32(28, buf.sampleRate * chans * 2, true);
  data.setUint16(32, chans * 2, true);
  data.setUint16(34, 16, true);
  str(36, 'data');
  data.setUint32(40, len * chans * 2, true);
  const channels = Array.from({ length: chans }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < chans; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data], { type: 'audio/wav' });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
