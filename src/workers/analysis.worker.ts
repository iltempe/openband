// Heavy DSP off the main thread: mix analysis, spectrogram images, audio key detection.
import { analyzeAudio, type AnalysisInput } from '../analysis/analyze';
import { spectrogramPixels, SPEC_FMAX, SPEC_FMIN } from '../analysis/spectrogram';
import { keyFromProfile, profileFromAudio } from '../analysis/key';
import { mono } from '../analysis/spectrum';
import { audioToNotes } from '../analysis/pitchtrack';

export interface SpectrogramRequest {
  channels: Float32Array[];
  sampleRate: number;
  width: number;
  height: number;
  bpm: number;
  fromBeat: number;
  title: string;
  sections?: { name: string; startBeat: number }[];
}

type Req =
  | { id: number; type: 'analyze'; input: AnalysisInput }
  | { id: number; type: 'spectrogram'; req: SpectrogramRequest }
  | { id: number; type: 'audioKey'; channels: Float32Array[]; sampleRate: number }
  | { id: number; type: 'pitchtrack'; channels: Float32Array[]; sampleRate: number };

async function spectrogramPng(r: SpectrogramRequest): Promise<string> {
  const left = 44;
  const top = 18;
  const bottom = 16;
  const w = Math.max(64, r.width - left);
  const h = Math.max(64, r.height - top - bottom);
  const canvas = new OffscreenCanvas(r.width, r.height);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#0c0d11';
  g.fillRect(0, 0, r.width, r.height);
  const x = mono(r.channels);
  g.putImageData(new ImageData(spectrogramPixels(x, r.sampleRate, w, h), w, h), left, top);
  g.font = '10px sans-serif';
  g.fillStyle = '#cbd0dc';
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  // Frequency axis.
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const y = top + h - (Math.log(f / SPEC_FMIN) / Math.log(SPEC_FMAX / SPEC_FMIN)) * h;
    g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), 4, y + 3);
    g.beginPath();
    g.moveTo(left, y);
    g.lineTo(left + 4, y);
    g.stroke();
  }
  // Bars and sections.
  const seconds = x.length / r.sampleRate;
  const barSec = (4 * 60) / r.bpm;
  const pxPerSec = w / seconds;
  const firstBar = Math.floor(r.fromBeat / 4) + 1;
  const offset = ((r.fromBeat % 4) * 60) / r.bpm;
  const step = Math.max(1, Math.ceil(28 / (barSec * pxPerSec)));
  for (let b = 0; (b * barSec - offset) <= seconds; b++) {
    const bx = left + (b * barSec - offset) * pxPerSec;
    if (bx < left) continue;
    g.beginPath();
    g.moveTo(bx, top);
    g.lineTo(bx, top + h);
    g.stroke();
    if (b % step === 0) g.fillText(String(firstBar + b), bx + 2, top + h + 12);
  }
  g.fillStyle = '#fbbf24';
  for (const s of r.sections ?? []) {
    const sx = left + (((s.startBeat - r.fromBeat) * 60) / r.bpm) * pxPerSec;
    if (sx >= left && sx < left + w) g.fillText(s.name, sx + 2, 12);
  }
  g.fillStyle = '#ffffff';
  g.fillText(r.title, left, 12);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const m = ev.data;
  try {
    let result: unknown;
    if (m.type === 'analyze') result = analyzeAudio(m.input);
    else if (m.type === 'spectrogram') result = await spectrogramPng(m.req);
    else if (m.type === 'pitchtrack') result = audioToNotes(mono(m.channels), m.sampleRate);
    else result = keyFromProfile(profileFromAudio(mono(m.channels), m.sampleRate));
    (self as unknown as Worker).postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: m.id, ok: false, error: (e as Error).message });
  }
};
