// Separating stems (SPEC v0.6 §10, audio.separate): an audio region becomes drums, bass, other and vocals
// on their own tracks, under the region's original track (which is muted, never removed), as one undo
// step. The router picks the engine — Demucs in the browser first (free, private), an online one only
// when the user allows online engines — and every stem is in the ledger with its engine and licence.
import { BEATS_PER_BAR, uid } from '../music';
import { isAiCommand, makeTrack, useStore } from '../store';
import { encodeWavChannels, getBuffer, importSample } from '../audio/samples';
import { stretchFactor } from '../audio/stretch';
import { renderBuffer } from '../audio/render';
import type { LedgerEntry, MixRole, Region, Track } from '../types';
import { buildContext, minimizeContext } from './context';
import { checkContribution } from './conform';
import { allEngines, callEngine, useEnsemble } from './engines';
import { route } from './router';
import type { Scp } from './types';
import { OverBudget, checkBudget, estimate, recordSpend } from './budget';
import { ledgerEntry, type Made } from './create';
import { NeedsDownload } from '../separate/model';
import { rmsDb } from '../separate/ola';
import type { PcmInput } from '../separate/engine';
import { create } from 'zustand';

const st = () => useStore.getState();

export interface SeparateArgs {
  region_id?: string;
  /** A track with one audio region. */
  track_id?: string;
  /** Only these stems (drums, bass, other, vocals); all by default. */
  stems?: string[];
  engine?: string;
  /** Demucs in the browser: the user agreed to download the model (166 MB, once). */
  confirm_download?: boolean;
  confirm_spend?: boolean;
}

/** What is separating now (the studio shows it). */
export const useSeparation = create<{ running: boolean; label: string; done: number; total: number }>(() => ({ running: false, label: '', done: 0, total: 0 }));

export interface Stems {
  made: Made;
  sampleRate: number;
  /** OMEP role (drums, bass, other, vocal) → the file and its channels. */
  stems: { role: string; bytes: ArrayBuffer; channels: Float32Array[] }[];
  failures: string[];
}

function base64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function decode(bytes: ArrayBuffer): Promise<{ sampleRate: number; channels: Float32Array[] }> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const b = await ctx.decodeAudioData(bytes.slice(0));
  return { sampleRate: b.sampleRate, channels: Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)) };
}

/**
 * Route audio.separate and run it on some audio. Builtins get the samples directly; other engines a WAV
 * (as a data: URI). Never falls back to an online engine when the browser one only needs the user's OK
 * to download its model: that question goes back to the user.
 */
export async function separatePcm(pcm: PcmInput, scp: Scp, o: Pick<SeparateArgs, 'engine' | 'confirm_download' | 'confirm_spend'> & { onProgress?: (done: number, total: number) => void } = {}): Promise<Stems> {
  const policy = useEnsemble.getState().policy;
  const r = route({ capability: 'audio.separate', engine: o.engine }, await allEngines(), policy);
  if (!r.candidates.length) throw new Error(`No engine can separate stems with your settings${r.excluded.length ? `: ${r.excluded.map((x) => `${x.name} — ${x.reason}`).join('; ')}` : ''}`);
  const failures: string[] = [];
  let wav: string | null = null;
  for (const e of r.candidates) {
    try {
      const quoted = estimate(e, 'audio.separate', scp);
      checkBudget(quoted, { session_usd: policy.budget_session_usd, month_usd: policy.budget_month_usd }, o.confirm_spend);
      const context = minimizeContext(scp, e.manifest, 'audio.separate');
      if (e.transport !== 'builtin') {
        wav ??= `data:audio/wav;base64,${base64(new Uint8Array(encodeWavChannels(pcm.right ? [pcm.left, pcm.right] : [pcm.left], pcm.sampleRate)))}`;
        context.context_audio = { ...context.context_audio, mix_uri: wav };
      }
      const c = await callEngine(e, 'audio.separate', { context, request: e.transport === 'builtin' ? { pcm, confirm_download: o.confirm_download, onProgress: o.onProgress } : {} });
      const bad = checkContribution(c);
      if (bad) throw new Error(`invalid contribution: ${bad}`);
      if (quoted > 0 || c.cost_usd) recordSpend(e.id, 'audio.separate', c.cost_usd ?? quoted);
      const stems: Stems['stems'] = [];
      let sampleRate = pcm.sampleRate;
      for (const f of c.files ?? []) {
        const res = await fetch(f.uri);
        if (!res.ok) throw new Error(`Could not read the ${f.role} stem (HTTP ${res.status})`);
        const bytes = await res.arrayBuffer();
        if (f.uri.startsWith('blob:')) URL.revokeObjectURL(f.uri);
        const d = await decode(bytes);
        sampleRate = d.sampleRate;
        stems.push({ role: f.role, bytes, channels: d.channels });
      }
      return { made: { engine: e, contribution: c }, sampleRate, stems, failures };
    } catch (err) {
      if (err instanceof OverBudget || err instanceof NeedsDownload) throw err;
      failures.push(`${e.manifest.engine.name}: ${(err as Error).message}`);
    }
  }
  throw new Error(`Every engine failed: ${failures.join('; ')}`);
}

const LABEL: Record<string, string> = { drums: 'Drums', bass: 'Bass', other: 'Other', vocal: 'Vocals' };
const ROLE: Record<string, MixRole> = { drums: 'drums', bass: 'bass', other: 'harmony', vocal: 'vocal' };
/** Below this a stem is silence (the song has no such part). */
const SILENT_DB = -60;

export async function separateRegion(a: SeparateArgs) {
  const p0 = st().project;
  let region: Region | undefined;
  if (a.region_id) {
    region = p0.regions.find((r) => r.id === a.region_id);
    if (!region) throw new Error(`Region "${a.region_id}" not found`);
  } else if (a.track_id) {
    const audio = p0.regions.filter((r) => r.trackId === a.track_id && r.audio);
    if (audio.length !== 1) throw new Error(audio.length ? `Track "${a.track_id}" has ${audio.length} audio regions: give region_id` : `Track "${a.track_id}" has no audio region`);
    region = audio[0];
  } else throw new Error('Give region_id (an audio region) or track_id');
  const clip = region.audio;
  if (!clip) throw new Error('Only audio regions can be separated (this one has notes: they are already parts)');
  const buf = getBuffer(clip.sampleId);
  if (!buf) throw new Error('The audio of this region is not loaded');
  const source = p0.tracks.find((t) => t.id === region!.trackId)!;
  // The part of the sample the region plays (before stretching): that is what gets separated.
  const factor = stretchFactor(clip, p0.bpm);
  const from = Math.max(0, Math.floor(clip.offset * buf.sampleRate));
  const to = Math.min(buf.length, from + Math.ceil(((region.length * 60) / p0.bpm / factor) * buf.sampleRate));
  if (to - from < buf.sampleRate * 0.5) throw new Error('This region is too short to separate (under half a second)');
  const pcm: PcmInput = { left: buf.getChannelData(0).slice(from, to), right: buf.numberOfChannels > 1 ? buf.getChannelData(1).slice(from, to) : null, sampleRate: buf.sampleRate };
  const fromBar = Math.floor(region.start / BEATS_PER_BAR) + 1;
  const scp = await buildContext(p0, { scope: { from_bar: fromBar, to_bar: Math.max(fromBar + 1, Math.ceil((region.start + region.length) / BEATS_PER_BAR) + 1) } });
  const wanted = a.stems?.length ? new Set(a.stems.map((s) => (s === 'vocals' ? 'vocal' : s))) : null;

  useSeparation.setState({ running: true, label: region.name, done: 0, total: 0 });
  let out: Stems;
  try {
    out = await separatePcm(pcm, scp, { ...a, onProgress: (done, total) => useSeparation.setState({ done, total }) });
  } finally {
    useSeparation.setState({ running: false });
  }

  const placed: { stem: string; track_id: string; region_id: string; rms_db: number }[] = [];
  const silent: string[] = [];
  const own = st().activeTransaction ? null : st().beginTransaction(`Separate stems: ${region.name}`, isAiCommand() ? 'ai' : 'ui');
  try {
    const ledger: LedgerEntry[] = [];
    const tracks: Track[] = [];
    const regions: Region[] = [];
    for (const s of out.stems) {
      if (wanted && !wanted.has(s.role)) continue;
      const level = rmsDb(s.channels);
      if (level < SILENT_DB) {
        silent.push(s.role);
        continue;
      }
      const info = await importSample(s.bytes, `${source.name} - ${LABEL[s.role] ?? s.role}.wav`);
      const track = makeTrack(st().project, 'audio', undefined, `${source.name} · ${LABEL[s.role] ?? s.role}`);
      if (ROLE[s.role]) track.role = ROLE[s.role];
      const e = ledgerEntry(out.made, 'audio.separate', { text: `separate ${region.name}` }, [], track.id, []);
      const r: Region = { id: uid('rgn'), trackId: track.id, name: `${region.name} · ${LABEL[s.role] ?? s.role}`, start: region.start, length: region.length, notes: [], audio: { sampleId: info.id, offset: 0, gain: clip.gain, ...(clip.stretch ? { stretch: { ...clip.stretch } } : {}), ...(clip.pitch ? { pitch: clip.pitch } : {}) }, contribution: e.id };
      e.regionIds = [r.id];
      tracks.push(track);
      regions.push(r);
      ledger.push(e);
      placed.push({ stem: s.role === 'vocal' ? 'vocals' : s.role, track_id: track.id, region_id: r.id, rms_db: +level.toFixed(1) });
    }
    if (!placed.length) throw new Error(`Nothing to place: ${silent.length ? `the stems are silent (${silent.join(', ')})` : 'no stem asked for was there'}`);
    st().commit((d) => {
      const at = d.tracks.findIndex((t) => t.id === source.id);
      d.tracks.splice(at + 1, 0, ...tracks);
      const src = d.tracks.find((t) => t.id === source.id);
      if (src) src.mute = true;
      d.regions.push(...regions);
      d.ledger = [...(d.ledger ?? []), ...ledger];
    });
  } finally {
    if (own) st().endTransaction(own);
  }
  return {
    stems: placed,
    ...(silent.length ? { silent: silent.map((s) => (s === 'vocal' ? 'vocals' : s)) } : {}),
    muted_track_id: source.id,
    engine: out.made.engine.manifest.engine.name,
    ...(out.made.contribution.cost_usd ? { cost_usd: out.made.contribution.cost_usd } : {}),
    ...(out.failures.length ? { failed: out.failures } : {}),
  };
}

const mono = (ch: Float32Array[]) => (ch.length < 2 ? ch[0] : Float32Array.from(ch[0], (v, i) => (v + ch[1][i]) / 2));

/**
 * Conformance step 5, isolation: an engine asked for a layer answered a full mix (the context plus the new
 * part). Separate it and the context into stems, keep what is new (isolate.ts), and answer the new part
 * alone as a mono WAV — or why it couldn't be done (then the answer is placed as it came, and said so).
 */
export async function isolateNewPart(answer: AudioBuffer, scp: Scp, range: { fromBeat: number; toBeat: number }, o: { role?: string; text?: string; confirm_download?: boolean; confirm_spend?: boolean }): Promise<{ wav: ArrayBuffer; note: string } | { wav: null; note: string }> {
  const { isolate, stemForRole } = await import('../separate/isolate');
  const ctx = await renderBuffer(st().project, { fromBeat: range.fromBeat, toBeat: range.toBeat });
  const ctxCh = Array.from({ length: ctx.numberOfChannels }, (_, c) => ctx.getChannelData(c));
  if (rmsDb(ctxCh) < SILENT_DB) return { wav: null, note: 'full mix answered over a silent context: all of it is new' };
  const pcmOf = (b: AudioBuffer): PcmInput => ({ left: b.getChannelData(0), right: b.numberOfChannels > 1 ? b.getChannelData(1) : null, sampleRate: b.sampleRate });
  let a: Stems;
  let c: Stems;
  try {
    a = await separatePcm(pcmOf(answer), scp, o);
    c = await separatePcm(pcmOf(ctx), scp, o);
  } catch (e) {
    if (e instanceof NeedsDownload) return { wav: null, note: 'full mix not isolated: separating needs the Demucs model (confirm_download: true)' };
    throw e;
  }
  const length = Math.min(...a.stems.map((s) => s.channels[0].length));
  const byRole = (x: Stems, n: number) => Object.fromEntries(x.stems.map((s) => [s.role === 'vocal' ? 'vocals' : s.role, mono(s.channels).subarray(0, n)]));
  const n = Math.min(length, ...c.stems.map((s) => s.channels[0].length));
  const answerStems = byRole(a, length);
  const contextStems = Object.fromEntries(Object.entries(byRole(c, n)).map(([k, v]) => [k, Float32Array.from({ length }, (_, i) => v[i] ?? 0)]));
  // The role asked for keeps its stem; words only when they name one ("bass line", "drums").
  const iso = isolate(answerStems, contextStems, o.role ?? (o.text && stemForRole(o.text) !== 'other' ? o.text : undefined));
  if (!iso.kept.length) throw new Error(`The engine answered the context back, with nothing new in it (${iso.dropped.map((d) => `${d.stem} ${Math.round(d.novelty * 100)} % new`).join(', ')})`);
  return {
    wav: encodeWavChannels([iso.part], a.sampleRate),
    note: `isolated the new part from the full mix (${a.made.engine.manifest.engine.name}): kept ${iso.kept.map((k) => `${k.stem} ${Math.round(k.novelty * 100)} % new`).join(', ')}${iso.dropped.length ? `; dropped ${iso.dropped.map((d) => d.stem).join(', ')}` : ''}`,
  };
}
