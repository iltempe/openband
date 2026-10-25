// The release (SPEC v0.6 G6): licences chosen in three answers, checked against what's in the song and
// where it goes; the Release Kit's texts.
import { describe, expect, it } from 'vitest';
import { chooseLicense, materialAllows, platformAccepts, explain } from './license';
import { checkRelease, ccTargets } from './check';
import { aiDisclosure, licenseConflicts, materials, releaseOf } from './release';
import { creditsText, flacTags, licenseText, lrcOf } from './kit';
import { emptyProject } from '../store';
import type { Project } from '../types';

const song = (o: Partial<Project> = {}): Project => {
  const p = emptyProject();
  p.name = 'Notte';
  p.bpm = 120;
  p.tracks = [{ id: 't1', name: 'Loop', kind: 'audio', instrument: 'audio-input', volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff', cutoff: 1, reverb: 0, delay: 0 } as never, { id: 't2', name: 'Sample', kind: 'audio', instrument: 'audio-input', volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff', cutoff: 1, reverb: 0, delay: 0 } as never];
  p.regions = [
    { id: 'r1', trackId: 't1', name: 'loop', start: 0, length: 8, notes: [], audio: { sampleId: 's-loop', offset: 0, gain: 1 } },
    { id: 'r2', trackId: 't2', name: 'vox', start: 0, length: 8, notes: [], audio: { sampleId: 's-vox', offset: 0, gain: 1 } },
  ];
  return { ...p, ...o };
};
const names = { 's-loop': 'lofi-keys-90.wav', 's-vox': 'Vocal chop.wav' };
const loopIds = new Set(['lofi-keys-90']);

describe('licences', () => {
  it('three answers choose the licence; each says what it allows', () => {
    expect(chooseLicense({ commercial: true, derivatives: true })).toBe('CC-BY-4.0');
    expect(chooseLicense({ commercial: true, derivatives: true, shareAlike: true })).toBe('CC-BY-SA-4.0');
    expect(chooseLicense({ commercial: false, derivatives: false })).toBe('CC-BY-NC-ND-4.0');
    expect(chooseLicense({ commercial: false, derivatives: true, shareAlike: true })).toBe('CC-BY-NC-SA-4.0');
    expect(chooseLicense({ commercial: true, derivatives: true, publicDomain: true })).toBe('CC0-1.0');
    expect(explain('CC-BY-NC-4.0')).toMatch(/not for money/);
  });

  it('where each can go: Commons only free licences, YouTube only CC BY, the Archive needs CC', () => {
    expect(platformAccepts('wikimedia', 'CC-BY-NC-4.0').ok).toBe(false);
    expect(platformAccepts('wikimedia', 'CC-BY-ND-4.0').ok).toBe(false);
    expect(platformAccepts('wikimedia', 'CC-BY-SA-4.0').ok).toBe(true);
    expect(platformAccepts('youtube', 'CC-BY-SA-4.0').ok).toBe(false);
    expect(platformAccepts('archive', 'all-rights-reserved').ok).toBe(false);
    expect(ccTargets('CC-BY-NC-4.0')).toEqual(['soundcloud', 'mixcloud', 'audius', 'archive', 'funkwhale']);
  });

  it('material against the licence: NC, ND, SA, unknown', () => {
    expect(materialAllows('CC0-1.0', 'CC-BY-4.0')).toBeNull();
    expect(materialAllows('CC-BY-NC-4.0', 'CC-BY-4.0')).toMatch(/commercial/);
    expect(materialAllows('CC-BY-NC-4.0', 'CC-BY-NC-4.0')).toBeNull();
    expect(materialAllows('CC-BY-ND-4.0', 'CC-BY-NC-4.0')).toMatch(/ND/);
    expect(materialAllows('CC-BY-SA-4.0', 'CC-BY-4.0')).toMatch(/SA/);
    expect(materialAllows('CC-BY-SA-4.0', 'CC-BY-SA-4.0')).toBeNull();
    expect(materialAllows('CC-BY-4.0', 'CC0-1.0')).toMatch(/attribution/);
    expect(materialAllows('unknown', 'CC-BY-4.0')).toMatch(/unknown/);
  });
});

describe('the release and its checks', () => {
  it('a sample with an incompatible licence blocks "Publish in CC", naming the sample', () => {
    const p = song({ release: { license: 'CC-BY-4.0', artist: 'Iltempe' }, sampleLicenses: { 's-vox': 'CC-BY-NC-4.0' } });
    const m = materials(p, { loopIds, sampleNames: names });
    expect(m.map((x) => `${x.kind}:${x.license}`)).toEqual(['loop:CC0-1.0', 'sample:CC-BY-NC-4.0']);
    const issues = checkRelease(p, ['archive'], { loopIds, sampleNames: names, hasCover: true });
    const block = issues.find((i) => i.code === 'license-material')!;
    expect(block.severity).toBe('error');
    expect(block.message).toMatch(/Vocal chop.*commercial/);
    expect(block.material).toMatchObject({ regionId: 'r2' });
    // Declared CC0: nothing blocks.
    expect(licenseConflicts(song({ release: { license: 'CC-BY-4.0' }, sampleLicenses: { 's-vox': 'CC0-1.0' } }), 'CC-BY-4.0', { loopIds, sampleNames: names })).toEqual([]);
  });

  it('the Internet Archive without a CC licence is blocked with a reason; Commons refuses NC', () => {
    const p = song({ sampleLicenses: { 's-vox': 'CC0-1.0' } });
    const arch = checkRelease(p, ['archive'], { loopIds, sampleNames: names, hasCover: true });
    expect(arch.find((i) => i.code === 'license-platform')?.message).toMatch(/Creative Commons/);
    const nc = checkRelease({ ...p, release: { license: 'CC-BY-NC-4.0' } }, ['wikimedia', 'mixcloud'], { loopIds, sampleNames: names, hasCover: true });
    expect(nc.filter((i) => i.severity === 'error').map((i) => i.platform)).toEqual(['wikimedia']);
    expect(checkRelease({ ...p, release: { tags: ['a', 'b', 'c', 'd', 'e', 'f'] } }, ['mixcloud'], { hasCover: true }).some((i) => i.code === 'tags')).toBe(true);
  });

  it('engine-made parts carry their licence; the AI statement and the kit texts', () => {
    const p = song({ release: { license: 'CC0-1.0', artist: 'Iltempe', contact: 'hello@example.org' }, sampleLicenses: { 's-vox': 'CC0-1.0' } });
    p.ledger = [{ id: 'c1', at: 0, source: 'engine', engine: 'diffsinger', engineName: 'DiffSinger', capability: 'voice.sing', requestedBy: 'user', conform: [], license: { code: 'Apache-2.0', weights: 'CC-BY-4.0', commercial: 'yes' }, trackId: 't2', regionIds: ['r2'] }];
    p.regions[1].contribution = 'c1';
    const c = licenseConflicts(p, 'CC0-1.0', { loopIds, sampleNames: names });
    expect(c.map((x) => x.name)).toEqual(['DiffSinger']);
    expect(aiDisclosure(p)).toMatch(/AI-assisted: \d+ %.*Sample.*DiffSinger/);
    expect(releaseOf(p).title).toBe('Notte');
    expect(licenseText(p)).toMatch(/CC0 1\.0.*\n.*Public domain/);
    expect(flacTags(p)).toMatchObject({ TITLE: 'Notte', ARTIST: 'Iltempe', LICENSE: 'https://creativecommons.org/publicdomain/zero/1.0/', CONTACT: 'hello@example.org' });
    expect(creditsText(p)).toMatch(/AI use: AI-assisted/);
  });

  it('LRC from the aligned lyrics', () => {
    const p = song({ release: { artist: 'Iltempe' } });
    p.lyrics = { language: 'it', lines: [{ id: 'l1', text: 'notte a Trastevere', syllables: [{ text: 'not', stressed: true, beat: 2 }] }, { id: 'l2', text: 'luna', syllables: [{ text: 'lu', stressed: true, beat: 130 }] }] };
    expect(lrcOf(p)).toBe('[ti:Notte]\n[ar:Iltempe]\n[by:OpenBand]\n[00:01.00]notte a Trastevere\n[01:05.00]luna\n');
  });
});
