// Offline rendering: the whole song, a range, or single tracks (stems), as AudioBuffers or a WAV.
import * as Tone from 'tone';
import type { AutoPoint, Project, TrackFx } from '../types';
import { faderToDb, sendToDb } from '../music';
import { projectEnd, projectSampleIds } from '../store';
import { ensureSamples } from './samples';
import { clipBuffer, ensureClipBuffer, needsProcessing, processingOf } from './processed';
import { createInstrument, makeImpulse, seeded } from './instruments';
import { FxChain, normalizeFx } from './fx';
import { MasterChainNode, limiterLatency } from './master';
import { effectiveValue, hasAutomation, isAutomated, mix, valueAt } from '../automation';
import { applyFxAutomation, automatePlugin } from './automate';
import type { WamInstance } from './wam';

const dbToGain = (db: number) => (db === -Infinity ? 0 : Math.pow(10, db / 20));

export interface RenderOptions {
  /** Range in beats (default: the whole song). */
  fromBeat?: number;
  toBeat?: number;
  /** Only these tracks (stems), ignoring mute/solo. Default: the mix, respecting mute/solo. */
  tracks?: string[];
  /** Apply the master volume and the master chain (default true). */
  includeMaster?: boolean;
  /** Render with this master chain instead of the song's (null: none) — e.g. to find the limiter gain. */
  masterChain?: import('../types').MasterChain | null;
  sampleRate?: number;
  /** Extra seconds after toBeat for reverb/delay tails (default 3; 0 for section analysis). */
  tailSeconds?: number;
  /**
   * A stem through a master chain linked to the full mix (export for platforms, G1): these tracks are
   * heard, while the mix (mute/solo respected) drives the chain's glue and limiter, so the stems of a
   * song add up to its master. Needs a master chain.
   */
  linked?: string[];
  /** Render one track with its FX chain (slotId null) or one plugin bypassed (level match, F20). */
  bypass?: { trackId: string; slotId: string | null };
}

/** A chain with everything off (slotId null) or without one plugin, and without the output trim. */
export function bypassed(fx: TrackFx | undefined, slotId: string | null): TrackFx | undefined {
  if (!fx) return fx;
  if (slotId === null) {
    const n = normalizeFx(fx);
    return { amp: { ...n.amp, on: false }, eq: { ...n.eq, on: false, hpf: undefined, bands: undefined }, comp: { ...n.comp, on: false }, plugins: [] };
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
  /** Plugin automation, sent to the plugins while the render runs (see the pause loop below). */
  const pluginLanes: { points: AutoPoint[]; paramId: string; instance: () => WamInstance | null }[] = [];
  const fromBeat = Math.max(0, o.fromBeat ?? 0);
  const toBeat = Math.max(fromBeat + 0.25, o.toBeat ?? Math.max(projectEnd(p), 4));
  const sampleRate = o.sampleRate ?? 44100;
  const seconds = ((toBeat - fromBeat) * 60) / p.bpm + (o.tailSeconds ?? 3);
  const anySolo = p.tracks.some((t) => t.solo);
  const included = (id: string, mute: boolean, solo: boolean) => (o.tracks ? o.tracks.includes(id) : !mute && !(anySolo && !solo));
  await ensureSamples(projectSampleIds(p));
  // Stretched / pitch-shifted clips (F23) are processed first.
  await Promise.all(p.regions.flatMap((r) => (r.audio && needsProcessing(r.audio, p.bpm) ? [ensureClipBuffer(r.audio, p.bpm)] : [])));

  // Like Tone.Offline, but on a native OfflineAudioContext (WAM plugins need one) and waiting for
  // plugins to load before rendering.
  // Automated plugins get a short lead-in, trimmed afterwards: they start from their saved state and
  // glide to the automated value, and some need a moment to start listening.
  const preRoll = p.tracks.some((t) => included(t.id, t.mute, t.solo) && (t.automation ?? []).some((l) => l.target.kind === 'plugin' && l.points.length)) ? 0.5 : 0;
  // The master chain's limiter delays everything by a few ms: render that much longer and trim it.
  const chainSpec = o.includeMaster === false ? null : o.masterChain !== undefined ? o.masterChain : (p.master ?? null);
  const latencyMax = chainSpec?.on && chainSpec.limiter.on ? limiterLatency(sampleRate) : 0;
  const linked = o.linked && chainSpec ? new Set(o.linked) : null;
  const ctx = new Tone.OfflineContext(new OfflineAudioContext(2, Math.ceil((seconds + preRoll) * sampleRate) + latencyMax, sampleRate));
  let chain: MasterChainNode | null = null;
  let keyChain: MasterChainNode | null = null;
  const loading: Promise<unknown>[] = [];
  const live = Tone.getContext();
  Tone.setContext(ctx);
  try {
    const transport = ctx.transport;
    transport.bpm.value = p.bpm;
    const PPQ = transport.PPQ;
    const ticks = (beat: number) => `${Math.round(beat * PPQ)}i`;
    const secs = (beats: number) => (beats * 60) / p.bpm;
    const masterGain = o.includeMaster === false ? 1 : dbToGain(faderToDb(p.masterVolume));
    const master = new Tone.Gain(masterGain);
    // Linked: `master` carries the whole mix into a chain that only keys the heard one (`heard`).
    const heard = linked ? new Tone.Gain(masterGain) : master;
    if (chainSpec) {
      chain = new MasterChainNode();
      heard.connect(chain.input);
      chain.output.toDestination();
      chain.update(chainSpec);
      loading.push(chain.ready());
      if (linked) {
        keyChain = new MasterChainNode();
        master.connect(keyChain.input);
        keyChain.update(chainSpec);
        loading.push(keyChain.ready());
      }
    } else master.toDestination();
    // Sidechain sources (G1) play into the key of their target even when they aren't heard (muted, or
    // outside a stem): the key is pre-fader and pre-mute, as live.
    const keySources = new Set(p.tracks.filter((t) => included(t.id, t.mute, t.solo) && t.fx?.comp.on && t.fx.comp.sidechain).map((t) => t.fx!.comp.sidechain!.sourceTrackId));
    const fxById = new Map<string, FxChain>();
    const reverb = new Tone.Convolver(makeImpulse(2.8, 3.2)).connect(master);
    const delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.34, wet: 1 }).connect(master);
    const reverbHeard = linked ? new Tone.Convolver(makeImpulse(2.8, 3.2)).connect(heard) : null;
    const delayHeard = linked ? new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.34, wet: 1 }).connect(heard) : null;

    for (const track of p.tracks) {
      const audible = included(track.id, track.mute, track.solo);
      if (!audible && !keySources.has(track.id)) continue;
      const inst = createInstrument(track.instrument, p.instruments?.find((c) => c.id === track.instrument));
      inst.setCutoff(track.cutoff);
      const ch = new Tone.Channel({ volume: faderToDb(track.volume), pan: track.pan });
      if (audible) ch.connect(master);
      if ('ready' in inst) loading.push((inst as { ready: Promise<void> }).ready);
      const fx = new FxChain();
      fx.update(bypass?.trackId === track.id ? bypassed(track.fx, bypass.slotId) : track.fx);
      for (const lane of track.automation ?? []) {
        const tg = lane.target;
        if (tg.kind !== 'plugin' || !lane.points.length) continue;
        pluginLanes.push({ points: lane.points, paramId: tg.paramId, instance: () => (tg.slotId === null ? (inst as { instance?: WamInstance | null }).instance ?? null : fx.plugin(tg.slotId)) });
      }
      loading.push(fx.ready);
      fxById.set(track.id, fx);
      inst.output.connect(fx.input);
      // Polarity is part of the mix (exported); mono and dim are monitoring only and never get here.
      fx.output.connect(new Tone.Gain(track.polarity ? -1 : 1).connect(ch));
      const revSend = new Tone.Gain(dbToGain(sendToDb(track.reverb)));
      const delSend = new Tone.Gain(dbToGain(sendToDb(track.delay)) * 0.7);
      if (audible) {
        revSend.connect(reverb);
        delSend.connect(delay);
      }
      if (linked?.has(track.id) && audible) {
        ch.connect(heard);
        revSend.connect(reverbHeard!);
        delSend.connect(delayHeard!);
      }
      ch.connect(revSend);
      ch.connect(delSend);
      if (hasAutomation(track)) {
        const on = (p: 'volume' | 'pan' | 'tone' | 'reverb' | 'echo') => isAutomated(track, mix(p));
        transport.scheduleRepeat((time) => {
          const beat = transport.getTicksAtTime(time) / PPQ;
          const v = (p: 'volume' | 'pan' | 'tone' | 'reverb' | 'echo') => effectiveValue(track, p, beat);
          if (on('volume')) ch.volume.rampTo(Math.max(-100, faderToDb(v('volume'))), 0.03, time);
          if (on('pan')) ch.pan.rampTo(v('pan'), 0.03, time);
          if (on('reverb')) revSend.gain.rampTo(dbToGain(sendToDb(v('reverb'))), 0.03, time);
          if (on('echo')) delSend.gain.rampTo(dbToGain(sendToDb(v('echo'))) * 0.7, 0.03, time);
          if (on('tone')) inst.setCutoff(v('tone'), time);
          // Effect lanes as live; plugin lanes are sent during the render (below).
          applyFxAutomation(track, beat, time, fx, inst as { instance?: WamInstance | null }, { plugins: false });
        }, '32n', 0);
      }

      for (const region of p.regions.filter((r) => r.trackId === track.id)) {
        if (region.start >= toBeat || region.start + region.length <= fromBeat) continue;
        if (region.audio) {
          const clip = region.audio;
          const buffer = clipBuffer(clip, p.bpm);
          if (!buffer) continue;
          // A clip already playing at fromBeat starts from the right point inside the (processed) sample.
          const skip = Math.max(0, fromBeat - region.start);
          const offset = clip.offset * processingOf(clip, p.bpm).factor + secs(skip);
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
    for (const t of p.tracks) {
      const side = t.fx?.comp.on ? t.fx.comp.sidechain : undefined;
      const src = side && fxById.get(side.sourceTrackId);
      const dst = fxById.get(t.id);
      if (src && dst && included(t.id, t.mute, t.solo)) src.output.connect(dst.key);
    }
    transport.start(preRoll, ticks(fromBeat));
  } finally {
    Tone.setContext(live);
  }
  await Promise.all(loading);
  if (keyChain) chain!.link(keyChain);
  // Automated plugins must be listening before the render starts: a round trip to each one.
  await Promise.all(pluginLanes.map((l) => l.instance()?.audioNode.getParameterValues(false).catch(() => null)));
  // Some WAM instruments keep MIDI events in a main-thread queue that is drained as audio time
  // advances, which never happens while an offline context renders in one go; and plugin automation
  // (F22) reaches the plugin's audio thread through its message port. Pause every 20 ms of audio and
  // yield to the main thread so both keep up with the render.
  const wamInstrument = p.instruments?.some((c) => c.source === 'wam' && p.tracks.some((t) => t.instrument === c.id && included(t.id, t.mute, t.solo)));
  if (wamInstrument || pluginLanes.length) {
    const raw = ctx.rawContext as unknown as OfflineAudioContext;
    const step = 0.02;
    // Plugin automation: sent at each pause for the render's own time (every 20 ms), the same event the
    // live engine sends. Events scheduled far ahead are not reliable offline.
    const setAutomation = (at: number) => {
      const beat = fromBeat + (Math.max(0, at - preRoll) * p.bpm) / 60;
      for (const l of pluginLanes) {
        const inst = l.instance();
        if (inst) automatePlugin(inst, l.paramId, valueAt(l.points, beat)!, at);
      }
    };
    setAutomation(0);
    // Plugins that pass parameter changes on from main-thread timers need a little main-thread time per step.
    const yieldMs = 8;
    const pause = (at: number) =>
      raw.suspend(at).then(() =>
        setTimeout(() => {
          if (pluginLanes.length) setAutomation(at);
          if (at + step < seconds) void pause(+(at + step).toFixed(6));
          void raw.resume();
        }, pluginLanes.length ? yieldMs : 0),
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
    const buffer = (await ctx.render()).get() as AudioBuffer;
    const latency = (chain as MasterChainNode | null)?.latency ?? 0;
    if (!preRoll && !latencyMax) return buffer;
    const skip = Math.round(preRoll * sampleRate) + latency;
    const length = buffer.length - skip - (latencyMax - latency);
    const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length, sampleRate });
    for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(skip, skip + length), c);
    return out;
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

/**
 * A stereo WAV at 16 or 24 bits. 16 bits can be dithered (TPDF, ±1 LSB triangular noise, seeded so the
 * same song always gives the same file): what a CD master needs.
 */
export function encodePcm(channels: Float32Array[], sampleRate: number, bits: 16 | 24, dither = false): Uint8Array {
  const chans = Math.min(2, channels.length);
  const len = channels[0].length;
  const bytes = bits / 8;
  const size = len * chans * bytes;
  const data = new DataView(new ArrayBuffer(44 + size));
  const str = (o: number, x: string) => [...x].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  data.setUint32(4, 36 + size, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, chans, true);
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * chans * bytes, true);
  data.setUint16(32, chans * bytes, true);
  data.setUint16(34, bits, true);
  str(36, 'data');
  data.setUint32(40, size, true);
  const full = bits === 16 ? 0x7fff : 0x7fffff;
  const rnd = seeded(0xd17e);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < chans; c++) {
      let v = Math.max(-1, Math.min(1, channels[c][i])) * full;
      if (dither) v += rnd() - rnd();
      const q = Math.max(-full - 1, Math.min(full, Math.round(v)));
      if (bits === 16) data.setInt16(o, q, true);
      else {
        data.setUint8(o, q & 0xff);
        data.setUint8(o + 1, (q >> 8) & 0xff);
        data.setUint8(o + 2, (q >> 16) & 0xff);
      }
      o += bytes;
    }
  }
  return new Uint8Array(data.buffer);
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
