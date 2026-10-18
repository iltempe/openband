// Lyrics in a project: melody notes of a span, alignment per section, prosody issues. Pure.
import type { LyricLine, Project } from '../types';
import { alignLines, type MelodyNote } from './align';
import { checkProsody, type ProsodyIssue } from './prosody';

/** Notes of the melody track sounding in [from, to) as song-beat MelodyNotes. */
export function melodyNotes(p: Project, trackId: string, from = 0, to = Infinity): MelodyNote[] {
  return p.regions
    .filter((r) => r.trackId === trackId && !r.audio)
    .flatMap((r) => r.notes.filter((n) => n.start < r.length).map((n) => ({ id: n.id, start: r.start + n.start, duration: Math.min(n.duration, r.length - n.start) })))
    .filter((n) => n.start >= from - 1e-6 && n.start < to - 1e-6)
    .sort((a, b) => a.start - b.start);
}

/** Groups of lines with the span of song they belong to (their section, or the whole song). */
export function lineGroups(p: Project, sectionId?: string): { sectionId?: string; from: number; to: number; lines: LyricLine[] }[] {
  const lines = p.lyrics?.lines ?? [];
  const sections = p.sections ?? [];
  const groups: { sectionId?: string; from: number; to: number; lines: LyricLine[] }[] = [];
  const free = lines.filter((l) => !l.sectionId || !sections.some((s) => s.id === l.sectionId));
  for (const s of sections) {
    if (sectionId && s.id !== sectionId) continue;
    const ls = lines.filter((l) => l.sectionId === s.id);
    if (ls.length) groups.push({ sectionId: s.id, from: s.start, to: s.start + s.length, lines: ls });
  }
  if (!sectionId && free.length) groups.push({ from: 0, to: Infinity, lines: free });
  return groups;
}

/** Align every group of lines to the melody; returns updated lines and what didn't fit. */
export function alignProject(p: Project, sectionId?: string) {
  const track = p.lyrics?.melodyTrackId;
  if (!track) throw new Error('No melody track set: call align_lyrics with melody_track_id');
  const updated = new Map<string, LyricLine>();
  const orphanSyllables: { line_id: string; count: number }[] = [];
  const orphanNotes: string[] = [];
  for (const g of lineGroups(p, sectionId)) {
    const res = alignLines(g.lines, melodyNotes(p, track, g.from, g.to));
    res.lines.forEach((l) => updated.set(l.id, l));
    orphanSyllables.push(...res.orphanSyllables);
    orphanNotes.push(...res.orphanNotes);
  }
  return { updated, orphanSyllables, orphanNotes };
}

export function prosodyIssues(p: Project, sectionId?: string): ProsodyIssue[] {
  const track = p.lyrics?.melodyTrackId;
  if (!track) return [];
  return lineGroups(p, sectionId).flatMap((g) => checkProsody(g.lines, melodyNotes(p, track, g.from, g.to)));
}
