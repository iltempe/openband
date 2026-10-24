// Finding installed native plugins in plain language (G8.9): the same words as for the WAM collection.
import { describe, expect, it } from 'vitest';
import { nativeRef, rankNativePlugins } from './plugins';
import type { NativePluginInfo } from './audio/native';

const plug = (p: Partial<NativePluginInfo> & { name: string }): NativePluginInfo => ({ format: 'clap', id: p.name, vendor: '', version: '1', description: '', features: [], kind: 'effect', path: '/x', ...p });
const INSTALLED = [
  plug({ name: 'Supermassive', vendor: 'Valhalla DSP', format: 'vst3', description: 'Fx|Reverb|Delay', features: ['audio-effect', 'reverb', 'delay'] }),
  plug({ name: 'Vital', vendor: 'Vital Audio', features: ['instrument', 'synthesizer', 'wavetable'], kind: 'instrument' }),
  plug({ name: 'AUDistortion', vendor: 'Apple', format: 'au', id: 'aufx:dist:appl', description: 'aufx', features: ['audio-effect'] }),
  plug({ name: 'Tube Screamer', vendor: 'X', description: 'Fx|Distortion', features: ['audio-effect', 'distortion'] }),
];

describe('natural-language search over installed plugins', () => {
  it('finds a reverb by its category, in Italian too', () => {
    expect(rankNativePlugins(INSTALLED, 'a big lush reverb')[0].name).toBe('Supermassive');
    expect(rankNativePlugins(INSTALLED, 'riverbero ampio')[0].name).toBe('Supermassive');
  });

  it('a synth is an instrument; distortion finds the distortions (by name or category)', () => {
    expect(rankNativePlugins(INSTALLED, 'sintetizzatore wavetable').map((p) => p.name)).toEqual(['Vital']);
    expect(rankNativePlugins(INSTALLED, 'distorsione sporca').map((p) => p.name).sort()).toEqual(['AUDistortion', 'Tube Screamer']);
  });

  it('names plugins for the AI as native:<format>:<id>', () => {
    expect(nativeRef(INSTALLED[2])).toBe('native:au:aufx:dist:appl');
  });
});
