// Draws and encodes the release video (see video.ts): every frame on an OffscreenCanvas — the cover, the
// spectrum of the music at that moment, a progress line, the lyric line being sung and the next — then
// H.264 (or VP9) and AAC (or Opus) with WebCodecs, muxed into an MP4 with its index at the front.
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { WorkerJob } from './video';

const VIDEO_CODECS = [
  { codec: 'avc1.640028', mux: 'avc' },
  { codec: 'avc1.4d0028', mux: 'avc' },
  { codec: 'avc1.42e028', mux: 'avc' },
  { codec: 'vp09.00.40.08', mux: 'vp9' },
] as const;
const AUDIO_CODECS = [
  { codec: 'mp4a.40.2', mux: 'aac' },
  { codec: 'opus', mux: 'opus' },
] as const;

const BANDS = 48;
// Long enough that the lowest bands (40–100 Hz) each get bins of their own.
const N = 8192;

self.onmessage = async (ev: MessageEvent<WorkerJob>) => {
  try {
    const r = await encode(ev.data);
    (self as unknown as Worker).postMessage({ type: 'done', ...r }, [r.mp4]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ type: 'error', message: (e as Error).message });
  }
};

async function pick<T extends { codec: string }>(list: readonly T[], test: (c: string) => Promise<boolean>): Promise<T> {
  for (const c of list) if (await test(c.codec).catch(() => false)) return c;
  throw new Error(`No encoder for ${list.map((c) => c.codec).join(', ')} in this browser`);
}

async function encode(j: WorkerJob) {
  const { width, height, fps, sampleRate } = j;
  const vBitrate = 6_000_000;
  const v = await pick(VIDEO_CODECS, async (codec) => !!(await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: vBitrate, framerate: fps })).supported);
  const a = await pick(AUDIO_CODECS, async (codec) => !!(await AudioEncoder.isConfigSupported({ codec, sampleRate, numberOfChannels: 2, bitrate: 192_000 })).supported);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: v.mux, width, height, frameRate: fps },
    audio: { codec: a.mux, numberOfChannels: 2, sampleRate },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let failed: Error | null = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (failed = e) });
  venc.configure({ codec: v.codec, width, height, bitrate: vBitrate, framerate: fps, ...(v.mux === 'avc' ? { avc: { format: 'avc' as const } } : {}) });
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (failed = e) });
  aenc.configure({ codec: a.codec, sampleRate, numberOfChannels: 2, bitrate: 192_000 });

  // The audio first: it's quick, and the muxer interleaves.
  const [L, R] = j.channels;
  const total = L.length;
  for (let i = 0; i < total; i += 4800) {
    const n = Math.min(4800, total - i);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(i, i + n), 0);
    data.set(R.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / sampleRate) * 1e6), data });
    aenc.encode(ad);
    ad.close();
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  const frames = Math.max(1, Math.ceil((total / sampleRate) * fps));
  const draw = painter(ctx, j);
  for (let f = 0; f < frames; f++) {
    if (failed) throw failed;
    draw(f / fps, f / frames);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: f % (fps * 2) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 6) await new Promise((ok) => venc.addEventListener('dequeue', ok, { once: true }));
    if (f % 15 === 0) (self as unknown as Worker).postMessage({ type: 'progress', value: f / frames });
  }
  await venc.flush();
  await aenc.flush();
  if (failed) throw failed;
  muxer.finalize();
  return { mp4: muxer.target.buffer, videoCodec: v.codec, audioCodec: a.codec };
}

/** The frame at time t (seconds into the video), progress 0..1. */
function painter(ctx: OffscreenCanvasRenderingContext2D, j: WorkerJob) {
  const { width: W, height: H, cues, cover, title, artist, short } = j;
  const [bg, accent, ink] = j.colors;
  const mono = new Float32Array(j.channels[0].length);
  for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (j.channels[0][i] + j.channels[1][i]);
  const fft = spectrum(j.sampleRate);
  const smooth = new Float32Array(BANDS);
  // Layout: the cover on the left (16:9) or on top (9:16); spectrum and lyrics beside or below it.
  const cs = short ? Math.round(W * 0.78) : Math.round(H * 0.62);
  const cx = short ? (W - cs) / 2 : Math.round(W * 0.07);
  const cy = short ? Math.round(H * 0.1) : (H - cs) / 2 - Math.round(H * 0.04);
  const tx = short ? W * 0.08 : cx + cs + W * 0.06;
  const tw = short ? W * 0.84 : W - tx - W * 0.06;
  const textTop = short ? cy + cs + H * 0.05 : cy;
  const specY = short ? H * 0.9 : cy + cs;
  const specH = short ? H * 0.08 : H * 0.2;
  const font = (px: number, weight = 700) => `${weight} ${Math.round(px)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const fit = (text: string, px: number, weight = 700) => {
    let size = px;
    ctx.font = font(size, weight);
    while (size > 18 && ctx.measureText(text).width > tw) ctx.font = font((size *= 0.92), weight);
    return size;
  };
  return (t: number, progress: number) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    // A soft glow of the accent behind the cover.
    const g = ctx.createRadialGradient(cx + cs / 2, cy + cs / 2, cs * 0.2, cx + cs / 2, cy + cs / 2, cs * 1.1);
    g.addColorStop(0, `${accent}55`);
    g.addColorStop(1, `${accent}00`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(cover, cx, cy, cs, cs);

    ctx.fillStyle = ink;
    ctx.textBaseline = 'top';
    fit(title, short ? W * 0.075 : H * 0.075);
    ctx.fillText(title, tx, textTop);
    if (artist) {
      ctx.globalAlpha = 0.7;
      fit(artist, short ? W * 0.045 : H * 0.04, 500);
      ctx.fillText(artist, tx, textTop + (short ? W * 0.095 : H * 0.095));
      ctx.globalAlpha = 1;
    }

    // The lyric line being sung, and the next one dimmer.
    const i = cues.findIndex((c) => t >= c.t && t < c.end);
    const ly = textTop + (short ? W * 0.2 : H * 0.22);
    if (i >= 0) {
      ctx.fillStyle = ink;
      const s = fit(cues[i].text, short ? W * 0.065 : H * 0.06);
      ctx.fillText(cues[i].text, tx, ly);
      const next = cues[i + 1];
      if (next && next.t - cues[i].end < 1) {
        ctx.globalAlpha = 0.45;
        fit(next.text, short ? W * 0.05 : H * 0.045, 600);
        ctx.fillText(next.text, tx, ly + s * 1.4);
        ctx.globalAlpha = 1;
      }
    }

    // The spectrum at t: log bands, fast attack and slow fall.
    const bands = fft(mono, Math.round(t * j.sampleRate));
    for (let b = 0; b < BANDS; b++) smooth[b] = bands[b] > smooth[b] ? bands[b] : smooth[b] * 0.86 + bands[b] * 0.14;
    const bw = tw / BANDS;
    ctx.fillStyle = accent;
    for (let b = 0; b < BANDS; b++) {
      const h = Math.max(2, smooth[b] * specH);
      ctx.fillRect(tx + b * bw + bw * 0.15, specY - h, bw * 0.7, h);
    }
    // Progress.
    ctx.fillStyle = `${ink}33`;
    ctx.fillRect(tx, specY + 12, tw, 4);
    ctx.fillStyle = ink;
    ctx.fillRect(tx, specY + 12, tw * progress, 4);
  };
}

/** Magnitudes in BANDS log-spaced bands (40 Hz – 12 kHz), 0..1 over 60 dB, of N samples around `at`. */
function spectrum(sr: number) {
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const edges = Array.from({ length: BANDS + 1 }, (_, b) => Math.max(1, Math.round((40 * Math.pow(12000 / 40, b / BANDS) * N) / sr)));
  const out = new Float32Array(BANDS);
  return (x: Float32Array, at: number) => {
    for (let i = 0; i < N; i++) {
      const k = at - N / 2 + i;
      re[i] = (k >= 0 && k < x.length ? x[k] : 0) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let b = 0; b < BANDS; b++) {
      let m = 0;
      const hi = Math.max(edges[b] + 1, edges[b + 1]);
      for (let k = edges[b]; k < hi && k < N / 2; k++) m = Math.max(m, Math.hypot(re[k], im[k]));
      const db = 20 * Math.log10(m / (N / 4) + 1e-9);
      out[b] = Math.min(1, Math.max(0, (db + 60) / 60));
    }
    return out;
  };
}

function fftInPlace(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}
