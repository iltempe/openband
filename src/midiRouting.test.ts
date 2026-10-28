import { describe, expect, it } from 'vitest';
import { channelMap, routeMidi } from './midiRouting';

const t = (id: string, kind: 'instrument' | 'drums' | 'audio', midiIn?: { channel: number; device?: string }) => ({ id, kind, midiIn });

describe('live MIDI routing', () => {
  const tracks = [t('strings', 'instrument', { channel: 1 }), t('brass', 'instrument', { channel: 2 }), t('piano', 'instrument'), t('vox', 'audio'), t('celli', 'instrument', { channel: 1 })];
  it('a channel goes to the tracks listening to it, selected or not (layers too)', () => {
    expect(routeMidi(tracks, 'piano', { channel: 2 })).toEqual(['brass']);
    expect(routeMidi(tracks, 'piano', { channel: 1 })).toEqual(['strings', 'celli']);
  });
  it('the rest goes to the selected track, as before', () => {
    expect(routeMidi(tracks, 'piano', { channel: 5 })).toEqual(['piano']);
    expect(routeMidi([t('a', 'instrument'), t('b', 'instrument')], null, { channel: 1 })).toEqual(['a']);
  });
  it("a selected track that listens to its own channel doesn't take the rest", () => {
    expect(routeMidi(tracks, 'brass', { channel: 9 })).toEqual([]);
  });
  it('a device, when named, must match', () => {
    const d = [t('a', 'instrument', { channel: 1, device: 'Texturium' }), t('b', 'instrument')];
    expect(routeMidi(d, 'b', { channel: 1, device: 'Texturium' })).toEqual(['a']);
    expect(routeMidi(d, 'b', { channel: 1, device: 'Keystation' })).toEqual(['b']);
  });
  it('maps channels 1..16 to the instrument and drum tracks in order', () => {
    const m = channelMap([t('a', 'instrument'), t('v', 'audio'), t('d', 'drums')], 'Texturium');
    expect(m).toEqual({ a: { channel: 1, device: 'Texturium' }, d: { channel: 2, device: 'Texturium' } });
    expect(Object.keys(channelMap(Array.from({ length: 20 }, (_, i) => t(`x${i}`, 'instrument')))).length).toBe(16);
  });
});
