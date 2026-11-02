import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { diffProjects } from '../versions/diff';
import { takeOnly } from '../versions/merge';
import { changedBars, nextNumber, packProposal, readableChanges, unpackProposal, type Proposal } from './model';

const song = (o: Partial<Project> = {}): Project => ({ version: 3, name: 'S', bpm: 92, key: 'C', tracks: [{ id: 'b', name: 'Basso' } as never], regions: [{ id: 'r', trackId: 'b', name: 'R', start: 16, length: 16, notes: [{ id: 'n1', pitch: 40, start: 0, duration: 1, velocity: 1 }, { id: 'n2', pitch: 41, start: 8, duration: 1, velocity: 1 }] }], sections: [{ id: 's', name: 'Ritornello', kind: 'chorus', start: 16, length: 16 }], loop: { enabled: false, start: 0, end: 16 }, masterVolume: 0.8, metronome: false, ...o });
const head = () => {
  const h = song();
  h.regions[0].notes[0].pitch = 43;
  return h;
};

describe('what a proposal changes', () => {
  it('says it in words', () => {
    const lines = readableChanges(diffProjects(song(), head()), head());
    expect(lines).toEqual(['Basso: 1 notes changed in Ritornello']);
  });
  it('names new tracks and the tempo', () => {
    const h = song({ bpm: 94, tracks: [{ id: 'b', name: 'Basso' } as never, { id: 'o', name: 'Organo' } as never] });
    expect(readableChanges(diffProjects(song(), h), h)).toEqual(expect.arrayContaining(['New track Organo', 'bpm 92 → 94']));
  });
  it('finds the bars, merged in ranges', () => {
    const h = head();
    h.regions[0].notes[1].pitch = 50;
    h.regions[0].notes.push({ id: 'n3', pitch: 60, start: 4, duration: 1, velocity: 1 });
    expect(changedBars(diffProjects(song(), h), h)).toEqual([{ from: 5, to: 7 }]);
    const one = head();
    expect(changedBars(diffProjects(song(), one), one)).toEqual([{ from: 5, to: 5 }]);
  });
  it('numbers proposals per song', () => {
    expect(nextNumber(song())).toBe(1);
    expect(nextNumber(song({ proposals: [{ number: 4 } as Proposal] }))).toBe(5);
  });
});

describe('take only this', () => {
  it('moves the picked region and nothing else, with its new track', () => {
    const ours = song();
    const theirs = song({ bpm: 140, tracks: [{ id: 'b', name: 'Basso', volume: 0.1 } as never, { id: 'o', name: 'Organo' } as never], regions: [...head().regions, { id: 'r2', trackId: 'o', name: 'O', start: 0, length: 4, notes: [] }] });
    const r = takeOnly(ours, theirs, [{ entity: 'region', id: 'r2', from: 'b' }]);
    expect(r.bpm).toBe(92);
    expect(r.regions.map((x) => x.id)).toEqual(['r', 'r2']);
    expect(r.regions[0].notes[0].pitch).toBe(40);
    expect(r.tracks.map((t) => t.id)).toEqual(['b', 'o']);
    expect(takeOnly(ours, theirs, [{ entity: 'track', id: 'b.volume', from: 'b' }]).tracks[0].volume).toBe(0.1);
  });
});

describe('the .openband-pr file', () => {
  const proposal = { id: 'pr_1', number: 1, title: 'Basso nuovo', projectId: 'x' } as Proposal;
  it('round-trips and carries only the new samples', () => {
    const withSample = (id: string) => song({ regions: [{ id: 'r', trackId: 'b', name: '', start: 0, length: 4, notes: [], audio: { sampleId: id, offset: 0, gain: 1 } }] });
    const base = withSample('smp_old');
    const h = { ...withSample('smp_old'), regions: [...withSample('smp_old').regions, { ...withSample('smp_new').regions[0], id: 'r2' }] };
    const f = unpackProposal(packProposal({ proposal, head: h, base, ledger: [], samples: [{ id: 'smp_old', name: 'o', type: 'audio/wav', data: new Uint8Array(1000) }, { id: 'smp_new', name: 'n', type: 'audio/wav', data: new Uint8Array([1, 2]) }] }));
    expect(f.proposal.title).toBe('Basso nuovo');
    expect(f.head.regions).toHaveLength(2);
    expect(f.base?.regions).toHaveLength(1);
    expect(f.samples.map((s) => s.id)).toEqual(['smp_new']);
    expect([...f.samples[0].data]).toEqual([1, 2]);
  });
  it('refuses anything else', () => {
    expect(() => unpackProposal(new Uint8Array([0x50, 0x4b, 5, 6, ...new Array(18).fill(0)]))).toThrow(/not an OpenBand proposal/);
  });
});
