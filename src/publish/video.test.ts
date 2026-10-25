// The release video's timing (SPEC v0.6 G6): which stretch a Short shows, and the lyric lines in time.
import { describe, expect, it } from 'vitest';
import { cueFrames, lyricCues, shortsExcerpt } from './video';
import { emptyProject } from '../store';
import type { Project } from '../types';

// 120 BPM: a beat is 0.5 s, a bar 2 s.
const song = (o: Partial<Project> = {}): Project => ({ ...emptyProject(), bpm: 120, ...o });
const sec = (id: string, kind: 'verse' | 'chorus', start: number, length: number) => ({ id, name: id, kind, start, length });
const line = (text: string, beats: number[]) => ({ id: text, text, syllables: beats.map((beat) => ({ text: 'x', stressed: false, beat })) });

describe('the Short', () => {
  it('takes the first chorus', () => {
    const p = song({ sections: [sec('verse', 'verse', 0, 32), sec('chorus', 'chorus', 32, 48), sec('chorus 2', 'chorus', 96, 32)] });
    expect(shortsExcerpt(p, 120)).toEqual({ from: 16, to: 40, section: 'chorus' });
  });
  it('a short chorus takes what follows, to 15 s', () => {
    const p = song({ sections: [sec('chorus', 'chorus', 16, 16)] });
    expect(shortsExcerpt(p, 120)).toEqual({ from: 8, to: 23, section: 'chorus' });
  });
  it('at most max_seconds, and never past the song', () => {
    const p = song({ sections: [sec('chorus', 'chorus', 0, 200)] });
    expect(shortsExcerpt(p, 120, { max_seconds: 30 })).toMatchObject({ from: 0, to: 30 });
    const end = song({ sections: [sec('chorus', 'chorus', 220, 16)] });
    expect(shortsExcerpt(end, 116)).toMatchObject({ from: 101, to: 116 });
  });
  it('without sections, the middle; an unknown section is refused', () => {
    expect(shortsExcerpt(song(), 200)).toEqual({ from: 70, to: 130 });
    expect(() => shortsExcerpt(song(), 200, { section_id: 'nope' })).toThrow(/not found/);
  });
});

describe('lyrics in time', () => {
  const p = song({ lyrics: { language: 'it', lines: [line('cia-o mon-do', [4, 5, 6, 7]), line('fine', [16])] } as never });
  it('each line from its first syllable to the next line (or 2 s after its last)', () => {
    expect(lyricCues(p, 0, 60)).toEqual([
      { text: 'ciao mondo', t: 2, end: 6 },
      { text: 'fine', t: 8, end: 10.5 },
    ]);
  });
  it('relative to the excerpt, clipped to it', () => {
    expect(lyricCues(p, 3, 9)).toEqual([
      { text: 'ciao mondo', t: 0, end: 3 },
      { text: 'fine', t: 5, end: 6 },
    ]);
  });
  it('a line shows on the first frame at or after it: within one frame (33 ms at 30 fps)', () => {
    const cues = [{ t: 1.01, end: 2, text: 'a' }, { t: 2, end: 3, text: 'b' }];
    const at = cueFrames(cues);
    expect(at[0] - 1.01).toBeGreaterThanOrEqual(0);
    expect(at[0] - 1.01).toBeLessThan(1 / 30);
    expect(at[1]).toBeCloseTo(2, 9);
  });
});
