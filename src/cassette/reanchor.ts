// Returns stay on the music (D2.4): seconds on a cassette become a place in a song, and that place follows the
// song through later edits. Pure.
import type { Project, Section, SectionKind } from '../types';
import { BEATS_PER_BAR } from '../music';

export interface MusicalAnchor {
  versionId: string;
  beat: number;
  sectionId?: string;
  sectionKind?: SectionKind;
  /** Which of its kind: the second chorus is 1. */
  kindIndex?: number;
  barInSection?: number;
  beatInBar?: number;
  /** A hash of the notes around it, ±1 bar. */
  context?: string;
}

export const secondsToBeat = (map: { bpm: number; offsetS: number }, t: number) => ((t - map.offsetS) * map.bpm) / 60;

const sorted = (p: Project) => [...(p.sections ?? [])].sort((a, b) => a.start - b.start);
const sectionAt = (p: Project, beat: number) => sorted(p).find((s) => beat >= s.start && beat < s.start + s.length);

/** The pitches around a beat, relative to it: the same phrase gives the same string wherever it moved to. */
export function contextAt(p: Project, beat: number) {
  const from = beat - BEATS_PER_BAR;
  const to = beat + BEATS_PER_BAR;
  const notes: string[] = [];
  for (const r of p.regions)
    for (const n of r.notes) {
      const at = r.start + n.start;
      if (at >= from && at < to) notes.push(`${Math.round((at - beat) * 4)}:${n.pitch}`);
    }
  return notes.sort().join(',');
}

export function anchorOf(p: Project, versionId: string, beat: number): MusicalAnchor {
  const s = sectionAt(p, beat);
  const base: MusicalAnchor = { versionId, beat, context: contextAt(p, beat) };
  if (!s) return base;
  const rel = beat - s.start;
  return { ...base, sectionId: s.id, sectionKind: s.kind, kindIndex: sorted(p).filter((x) => x.kind === s.kind).indexOf(s), barInSection: Math.floor(rel / BEATS_PER_BAR), beatInBar: rel % BEATS_PER_BAR };
}

export type Reanchored = { beat: number; confidence: number } | { orphan: true };

const findSection = (a: MusicalAnchor, to: Project): Section | undefined => to.sections?.find((s) => s.id === a.sectionId) ?? sorted(to).filter((s) => s.kind === a.sectionKind)[a.kindIndex ?? 0];

/** The bar in `section` with the same notes around it, if there is one. */
function sameContext(a: MusicalAnchor, section: Section, to: Project) {
  if (!a.context) return null;
  for (let b = 0; b < section.length; b += BEATS_PER_BAR) {
    const beat = section.start + b + (a.beatInBar ?? 0);
    if (contextAt(to, beat) === a.context) return beat;
  }
  return null;
}

export function reanchor(a: MusicalAnchor, from: Project, to: Project): Reanchored {
  if (!a.sectionKind && !a.sectionId) {
    // Outside any section: the same notes, or the same place if the song hasn't moved.
    if (a.context && contextAt(to, a.beat) === a.context) return { beat: a.beat, confidence: 0.9 };
    return { beat: a.beat, confidence: 0.3 };
  }
  const section = findSection(a, to);
  if (!section) return { orphan: true };
  const same = sameContext(a, section, to);
  if (same !== null) return { beat: same, confidence: 1 };
  const old = from.sections?.find((s) => s.id === a.sectionId);
  const rel = (a.barInSection ?? 0) * BEATS_PER_BAR + (a.beatInBar ?? 0);
  if (old && old.length === section.length) return { beat: section.start + rel, confidence: 0.8 };
  const scale = old ? section.length / old.length : 1;
  return { beat: section.start + Math.min(section.length - 1e-3, rel * scale), confidence: 0.5 };
}
