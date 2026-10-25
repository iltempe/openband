// omep-demucs in the browser as a builtin OMEP engine (audio.separate): the router picks it before any
// online separator because it is free and private; the model is loaded only when it runs.
import type { BuiltinEngine } from '../ensemble/builtin';
import type { Contribution, OmepLicense } from '../ensemble/types';
import { encodeWavChannels } from '../audio/samples';
import { DEMUCS } from './ola';
import { modelSource } from './model';

export const DEMUCS_LICENSE: OmepLicense = {
  code: 'MIT',
  weights: 'MIT',
  commercial: 'yes',
  attribution: 'HT-Demucs by Simon Rouard, Francisco Massa and Alexandre Défossez (Meta, ICASSP 2023); ONNX export by StemSplit',
  conditions: null,
  url: 'https://github.com/facebookresearch/demucs/blob/main/LICENSE',
};

/** What the separate command hands a builtin directly (no WAV round trip). */
export interface PcmInput {
  left: Float32Array;
  right: Float32Array | null;
  sampleRate: number;
}

/** OMEP stem roles for Demucs' sources. */
export const STEM_ROLE: Record<string, string> = { drums: 'drums', bass: 'bass', other: 'other', vocals: 'vocal' };

async function decode(uri: string): Promise<PcmInput> {
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`Could not read the audio to separate (HTTP ${res.status})`);
  const ctx = new OfflineAudioContext(2, 1, DEMUCS.sampleRate);
  const b = await ctx.decodeAudioData(await res.arrayBuffer());
  return { left: b.getChannelData(0), right: b.numberOfChannels > 1 ? b.getChannelData(1) : null, sampleRate: b.sampleRate };
}

export const demucsEngine: BuiltinEngine = {
  manifest: {
    omep: '1.0',
    engine: { id: 'openband-demucs', name: 'Demucs in the browser', version: '4.0.0', homepage: 'https://github.com/facebookresearch/demucs' },
    license: DEMUCS_LICENSE,
    runtime: { where: 'browser', device: ['cpu'], realtime: false },
    capabilities: { 'audio.separate': { conditioning: ['context_audio'], roles: ['drums', 'bass', 'other', 'vocal'] } },
    outputs: ['audio/wav'],
    determinism: 'deterministic',
  },
  async run(_cap, input): Promise<Contribution> {
    const r = input.request ?? {};
    const pcm = (r.pcm as PcmInput | undefined) ?? (input.context.context_audio?.mix_uri ? await decode(input.context.context_audio.mix_uri) : null);
    if (!pcm) throw new Error('Nothing to separate: give a region with audio');
    const { separateInBrowser } = await import('./demucs');
    const out = await separateInBrowser(pcm.left, pcm.right, pcm.sampleRate, {
      confirmDownload: r.confirm_download === true,
      onProgress: r.onProgress as ((done: number, total: number) => void) | undefined,
      signal: r.signal as AbortSignal | undefined,
    });
    const files = DEMUCS.sources.map((s) => ({
      uri: URL.createObjectURL(new Blob([encodeWavChannels(out.stems[s], out.sampleRate)], { type: 'audio/wav' })),
      role: STEM_ROLE[s],
      format: 'wav' as const,
      sample_rate: out.sampleRate,
      channels: 2,
    }));
    return { kind: 'stems', files, claims: {}, provenance: { engine: 'openband-demucs', engine_version: '4.0.0', model_hash: `sha256:${modelSource().sha256}`, capability: 'audio.separate', prompt: 'htdemucs' }, license: DEMUCS_LICENSE };
  },
};
