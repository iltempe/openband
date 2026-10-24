import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { emptyProject, makeTrack } from '../store';
import { freezeView, frozenStale, nativePluginsOf, trackHash, usesFrozen } from './freeze';

function song(): { p: Project; id: string } {
  const p = emptyProject('Freeze', 100);
  p.instruments = [{ id: 'nat_v', name: 'Vital', kind: 'instrument', source: 'native', zones: [], attack: 0, release: 0, format: 'clap', native: { id: 'audio.vital.synth', state_b64: 'AAA=' } }];
  const t = makeTrack(p, 'instrument', 'felt-piano', 'Synth');
  t.instrument = 'nat_v';
  p.tracks.push(t);
  p.regions.push({ id: 'r1', trackId: t.id, name: 'A', start: 0, length: 4, notes: [{ id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.8 }] } as Project['regions'][number]);
  return { p, id: t.id };
}

describe('the render cache of native plugins (G8.4)', () => {
  it('knows which native plugins a track plays', () => {
    const { p, id } = song();
    const t = p.tracks.find((x) => x.id === id)!;
    t.fx = { amp: { on: false, drive: 0, tone: 0, level: 0 }, eq: { on: false, low: 0, mid: 0, high: 0, midFreq: 1000 }, comp: { on: false, threshold: 0, ratio: 1, attack: 0, release: 0, makeup: 0 }, plugins: [
      { id: 'a', url: '', name: 'Diva', on: true, format: 'clap', native: { id: 'u-he.diva' } },
      { id: 'b', url: 'https://x', name: 'Web delay', on: true },
      { id: 'c', url: '', name: 'Off one', on: false, format: 'vst3', native: { id: 'x' } },
    ] };
    expect(nativePluginsOf(p, t)).toEqual(['Vital', 'Diva']);
  });

  it('the fingerprint follows the notes and the sound, not the mix', () => {
    const { p, id } = song();
    const t = p.tracks.find((x) => x.id === id)!;
    const h = trackHash(p, t);
    t.volume = 0.3;
    t.pan = -1;
    t.reverb = 0.9;
    t.mute = true;
    t.automation = [{ target: { kind: 'mix', param: 'volume' }, points: [{ beat: 0, value: 0.2 }] }];
    expect(trackHash(p, t)).toBe(h);
    p.regions[0].notes[0].pitch = 62;
    expect(trackHash(p, t)).not.toBe(h);
    p.regions[0].notes[0].pitch = 60;
    p.instruments![0].native!.state_b64 = 'BBB=';
    expect(trackHash(p, t)).not.toBe(h);
  });

  it('plays the frozen audio only where the plugins cannot run', () => {
    const { p, id } = song();
    const t = p.tracks.find((x) => x.id === id)!;
    const none = { desktop: false, failed: () => false };
    expect(usesFrozen(p, t, none)).toBe(false); // nothing frozen yet
    t.frozen = { sampleId: 's1', hash: trackHash(p, t), plugins: ['Vital'], seconds: 3 };
    expect(usesFrozen(p, t, none)).toBe(true); // the browser
    expect(usesFrozen(p, t, { desktop: true, failed: () => false })).toBe(false); // the desktop app with the plugin
    expect(usesFrozen(p, t, { desktop: true, failed: (k) => k === `${id}:instrument` })).toBe(true); // the plugin is missing there
    expect(frozenStale(p, t)).toBe(false);
    p.regions[0].notes[0].duration = 2;
    expect(frozenStale(p, t)).toBe(true);
  });

  it('freezes the track before its fader: 0 dB, centred, no sends, no mix automation', () => {
    const { p, id } = song();
    const t = p.tracks.find((x) => x.id === id)!;
    Object.assign(t, { volume: 0.2, pan: 0.7, reverb: 0.5, delay: 0.4, mute: true, solo: true, polarity: true });
    t.automation = [
      { target: { kind: 'mix', param: 'volume' }, points: [{ beat: 0, value: 0.2 }] },
      { target: { kind: 'plugin', slotId: null, paramId: '7' }, points: [{ beat: 0, value: 0.5 }] },
    ];
    const v = freezeView(p, id).tracks.find((x) => x.id === id)!;
    expect(v).toMatchObject({ volume: 0.8, pan: 0, reverb: 0, delay: 0, mute: false, solo: false });
    expect(v.polarity).toBeUndefined();
    expect(v.automation!.map((l) => l.target.kind)).toEqual(['plugin']);
    expect(t.volume).toBe(0.2); // the song itself is untouched
  });
});
