// "Record the rehearsal" in the browser (R2.8): where there is no Box. Best effort: the tab must stay open.
// The same gate as the Box, the screen kept awake, and the takes become tracks when the session ends.
import { create } from 'zustand';
import * as Tone from 'tone';
import { importSample, encodeWavChannels } from './audio/samples';
import { commands } from './commands';
import { uid, BEATS_PER_BAR } from './music';
import { useStore } from './store';
import { t } from './i18n';

export const PRE_ROLL_S = 5;
const SECONDS_PER_CHUNK = 0.1;

/** PCM kept as it arrives, and cut out later. Pure, tested. */
export class TabBuffer {
  chunks: Int16Array[] = [];
  frames = 0;
  /** Frames dropped from the front, before a session opened. */
  dropped = 0;
  constructor(readonly keepFrames: number) {}

  push(interleavedMono: Float32Array) {
    const c = new Int16Array(interleavedMono.length);
    for (let i = 0; i < c.length; i++) c[i] = Math.max(-1, Math.min(1, interleavedMono[i])) * 32767;
    this.chunks.push(c);
    this.frames += c.length;
  }

  /** Before a session: only what the pre-roll can still need. */
  trim() {
    let held = this.frames - this.dropped;
    while (this.chunks.length > 1 && held - this.chunks[0].length >= this.keepFrames) {
      held -= this.chunks[0].length;
      this.dropped += this.chunks.shift()!.length;
    }
  }

  slice(from: number, to: number) {
    const out = new Float32Array(Math.max(0, to - from));
    let at = this.dropped;
    for (const c of this.chunks) {
      for (let i = Math.max(0, from - at); i < c.length && at + i < to; i++) out[at + i - from] = c[i] / 32767;
      at += c.length;
    }
    return out;
  }
}

export const useTabRehearsal = create<{ on: boolean; recording: boolean; seconds: number; wake: boolean; error: string | null }>(() => ({ on: false, recording: false, seconds: 0, wake: false, error: null }));

const WORKLET = `class P extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('openband-tap',P)`;

let run: { stop: () => void } | null = null;

/** The session as a track with a region and a section per song. */
async function keep(buffer: TabBuffer, start: number, end: number, cuts: number[], sampleRate: number) {
  const pcm = buffer.slice(start, end);
  const name = `${t('bx.tabTake')} ${new Date().toLocaleString()}`;
  const info = await importSample(encodeWavChannels([pcm], sampleRate), `${name}.wav`);
  const { project } = useStore.getState();
  const track = (commands.add_track({ kind: 'audio', name }) as { track_id: string }).track_id;
  const startBar = Math.ceil(Math.max(0, ...project.regions.map((r) => r.start + r.length)) / BEATS_PER_BAR) + 1;
  const edges = [0, ...cuts.map((c) => (c - start) / sampleRate), (end - start) / sampleRate];
  const barsOf = (s: number) => (s * project.bpm) / 60 / BEATS_PER_BAR;
  for (let i = 0; i + 1 < edges.length; i++) {
    const bar = startBar + barsOf(edges[i]);
    commands.add_audio_region({ sample_id: info.id, track_id: track, start_bar: bar, name: `Brano ${i + 1}`, offset_seconds: edges[i], length_bars: barsOf(edges[i + 1] - edges[i]) });
    useStore.getState().commit((d) => void (d.sections = [...(d.sections ?? []), { id: uid('sec'), name: `Brano ${i + 1}`, kind: 'custom', start: (bar - 1) * BEATS_PER_BAR, length: barsOf(edges[i + 1] - edges[i]) * BEATS_PER_BAR }]));
  }
}

export async function startTabRehearsal() {
  if (run) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = Tone.getContext().rawContext as unknown as AudioContext;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
  const tap = new AudioWorkletNode(ctx, 'openband-tap');
  const source = ctx.createMediaStreamSource(stream);
  source.connect(tap);
  const sampleRate = ctx.sampleRate;
  // The ring must reach past the gate's own 2 s, as on the Box.
  const buffer = new TabBuffer((PRE_ROLL_S + 3) * sampleRate);
  const worker = new Worker(new URL('./storage/tabGate.worker.ts', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'init', sampleRate, channels: 1, preRollS: PRE_ROLL_S });
  let session: { start: number; cuts: number[] } | null = null;
  let chunkTimer = 0;
  tap.port.onmessage = (e) => {
    const pcm = e.data as Float32Array;
    buffer.push(pcm);
    worker.postMessage({ type: 'pcm', data: pcm }, [pcm.buffer]);
    if (!session && ++chunkTimer * (pcm.length / sampleRate) > SECONDS_PER_CHUNK * 10) {
      chunkTimer = 0;
      buffer.trim();
    }
    if (session) useTabRehearsal.setState({ seconds: Math.round((buffer.frames - session.start) / sampleRate) });
  };
  const finish = async (end: number) => {
    const s = session;
    session = null;
    useTabRehearsal.setState({ recording: false, seconds: 0 });
    if (s) await keep(buffer, s.start, end, s.cuts, sampleRate).catch((e) => useTabRehearsal.setState({ error: (e as Error).message }));
  };
  worker.onmessage = (e) => {
    const ev = e.data as { type: string; at: number };
    if (ev.type === 'start') {
      session = { start: ev.at, cuts: [] };
      useTabRehearsal.setState({ recording: true });
    } else if (ev.type === 'split') session?.cuts.push(ev.at);
    else if (ev.type === 'end') void finish(ev.at);
  };
  let lock: WakeLockSentinel | null = await navigator.wakeLock?.request('screen').catch(() => null);
  const relock = async () => {
    if (document.visibilityState === 'visible' && run) lock = await navigator.wakeLock?.request('screen').catch(() => null);
  };
  document.addEventListener('visibilitychange', relock);
  useTabRehearsal.setState({ on: true, wake: !!lock, error: null });
  run = {
    stop: () => {
      void finish(buffer.frames);
      stream.getTracks().forEach((x) => x.stop());
      source.disconnect();
      tap.disconnect();
      worker.terminate();
      document.removeEventListener('visibilitychange', relock);
      void lock?.release();
      run = null;
      useTabRehearsal.setState({ on: false, wake: false });
    },
  };
}

export const stopTabRehearsal = () => run?.stop();
