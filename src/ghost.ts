// Ghost notes in the editor (G3): after 600 ms without edits, the region being edited shows OpenBand's
// suggestion in grey. Tab accepts it (one undo step), ⇧Tab shows the next one, Esc dismisses it. What you
// accept or dismiss teaches it, locally (and "Forget what I taught" resets that).
import { create } from 'zustand';
import type { Region } from './types';
import { getRegion, makeTrack, useStore } from './store';
import { BEATS_PER_BAR, uid } from './music';
import { suggest, type SuggestKind, type Suggestion } from './suggest/engine';

const PREF = 'openband.ghosts';
const LEARN = 'openband.ghostLearn';
export const GHOST_DELAY = 600;

interface Learned {
  accepted: number;
  dismissed: number;
  /** Accepted / dismissed ideas that repeat the motif. */
  motifYes: number;
  motifNo: number;
}

interface GhostState {
  enabled: boolean;
  regionId: string | null;
  kind: SuggestKind | null;
  suggestions: Suggestion[];
  index: number;
  /** The "why" popover. */
  explain: boolean;
  learned: Learned;
}

const read = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

const NO_LEARNING: Learned = { accepted: 0, dismissed: 0, motifYes: 0, motifNo: 0 };
export const useGhost = create<GhostState>(() => ({ enabled: read(PREF, true), regionId: null, kind: null, suggestions: [], index: 0, explain: false, learned: read(LEARN, NO_LEARNING) }));

const st = () => useStore.getState();
const gs = () => useGhost.getState();
const isMotif = (s: Suggestion) => s.reasons.some((r) => r.startsWith('repeats the rhythm'));

/** What this user's choices say: ideas that repeat the motif get up to ±1.5 points. */
export const preference = (l: Learned) => ({ motif: Math.max(-1.5, Math.min(1.5, (l.motifYes - l.motifNo) * 0.25)) });

export function setGhostsEnabled(on: boolean) {
  write(PREF, on);
  useGhost.setState({ enabled: on, ...(on ? {} : { suggestions: [], regionId: null }) });
}

export function forgetLearning() {
  write(LEARN, NO_LEARNING);
  useGhost.setState({ learned: NO_LEARNING });
}

function learn(s: Suggestion | undefined, yes: boolean) {
  if (!s) return;
  const l = { ...gs().learned };
  if (yes) l.accepted++;
  else l.dismissed++;
  if (isMotif(s)) {
    if (yes) l.motifYes++;
    else l.motifNo++;
  }
  write(LEARN, l);
  useGhost.setState({ learned: l });
}

let seed = 1;
/** Compute suggestions for a region now (a kind, or the one that fits). */
export function requestGhosts(regionId: string, kind?: SuggestKind) {
  // Asked for now: the pending automatic one would only replace it.
  if (timer) clearTimeout(timer);
  const r = getRegion(st().project, regionId);
  if (!r || r.audio) return clearGhosts();
  const { kind: used, suggestions } = suggest(st().project, regionId, { kind, seed: seed++, prefer: preference(gs().learned) });
  useGhost.setState({ regionId, kind: used, suggestions, index: 0, explain: false });
}

export const clearGhosts = () => useGhost.setState({ regionId: null, kind: null, suggestions: [], index: 0, explain: false });
export const ghostsShown = () => gs().suggestions.length > 0 && !!gs().regionId;

/** ⇧Tab: the next suggestion (and around). */
export function nextGhost() {
  const { suggestions, index } = gs();
  if (suggestions.length) useGhost.setState({ index: (index + 1) % suggestions.length });
}

/** Esc: dismiss — not again until the region changes. */
export function dismissGhosts() {
  learn(gs().suggestions[gs().index], false);
  dismissedFor = currentRegion();
  clearGhosts();
}

/** Tab: put the shown suggestion into the song, as one undo step. Harmonies go on a new track. */
export function acceptGhost() {
  const { regionId, suggestions, index } = gs();
  const s = suggestions[index];
  const region = regionId ? getRegion(st().project, regionId) : null;
  if (!s || !region) return null;
  learn(s, true);
  clearGhosts();
  if (s.newTrack) {
    const track = makeTrack(st().project, 'instrument', 'felt-piano', 'Harmony');
    const end = Math.max(...s.notes.map((n) => n.start + n.duration));
    const r: Region = { id: uid('r'), trackId: track.id, name: s.chords?.join(' ') ?? 'Harmony', start: region.start, length: Math.ceil(end / BEATS_PER_BAR - 1e-6) * BEATS_PER_BAR, notes: s.notes.map((n) => ({ id: uid('n'), ...n })) };
    st().commit((d) => {
      d.tracks.push(track);
      d.regions.push(r);
    }, { label: 'Accept suggestion' });
    return { track_id: track.id, region_id: r.id };
  }
  st().commit((d) => {
    const r = d.regions.find((x) => x.id === region.id)!;
    r.notes.push(...s.notes.map((n) => ({ id: uid('n'), ...n })));
    const end = Math.max(...r.notes.map((n) => n.start + n.duration));
    if (end > r.length) r.length = Math.ceil(end / BEATS_PER_BAR - 1e-6) * BEATS_PER_BAR;
  }, { label: 'Accept suggestion' });
  return { region_id: region.id, notes: s.notes.length };
}

// ---------------------------------------------------------------- after 600 ms without edits

/** The region open in the editor, as an object (it changes identity on every edit). */
function currentRegion(): Region | null {
  const s = st();
  return (s.bottom === 'editor' ? getRegion(s.project, s.selectedRegionId) : null) ?? null;
}
let dismissedFor: Region | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

let started = false;
export function initGhosts() {
  if (started) return;
  started = true;
  let last: Region | null = null;
  useStore.subscribe(() => {
    const r = currentRegion();
    if (r === last) return;
    last = r;
    if (timer) clearTimeout(timer);
    if (gs().suggestions.length) clearGhosts();
    if (!r || !gs().enabled || r === dismissedFor || r.audio) return;
    timer = setTimeout(() => {
      if (currentRegion() === r && gs().enabled) requestGhosts(r.id);
    }, GHOST_DELAY);
  });
}

/** The engine's reasons are English; in Italian, these are their translations (the music stays the same). */
const IT_REASONS: [RegExp, string][] = [
  [/^chord tones of (.+) on the strong beats$/, 'note dell’accordo $1 sui tempi forti'],
  [/^repeats the rhythm of bar (\d+)$/, 'ripete il ritmo di battuta $1'],
  [/^stays in a singable range$/, 'resta in un’estensione cantabile'],
  [/^follows the chords \((.+)\)$/, 'segue gli accordi ($1)'],
  [/^roots of the chords, held$/, 'le fondamentali degli accordi, tenute'],
  [/^root on the downbeat, fifth on beat 3$/, 'fondamentale sul battere, quinta sul terzo tempo'],
  [/^quarter notes through the chord, with a passing note into the next one$/, 'semiminime dentro l’accordo, con una nota di passaggio verso il successivo'],
  [/^eighth notes jumping octaves on the root$/, 'crome che saltano d’ottava sulla fondamentale'],
  [/^the melody's strong-beat notes are in the chord in (\d+) of (\d+) bars$/, 'le note della melodia sui tempi forti sono nell’accordo in $1 battute su $2'],
  [/^a common progression: (.+)$/, 'una progressione comune: $1'],
  [/^below the melody$/, 'sotto la melodia'],
  [/^above the melody$/, 'sopra la melodia'],
  [/^moves against it \(contrary motion\)$/, 'si muove al contrario (moto contrario)'],
  [/^the motif of "(.+)" a third higher, in the scale$/, 'il motivo di "$1" una terza sopra, nella scala'],
  [/^the motif of "(.+)" a step lower \(a sequence\)$/, 'il motivo di "$1" un grado sotto (una progressione)'],
  [/^the motif of "(.+)" upside down \(inversion\)$/, 'il motivo di "$1" capovolto (inversione)'],
  [/^the motif of "(.+)" a fourth higher$/, 'il motivo di "$1" una quarta sopra'],
  [/^same rhythm$/, 'stesso ritmo'],
  [/^adjusted to (.+) on the strong beats$/, 'adattato a $1 sui tempi forti'],
  [/^repeats the groove of bar (\d+)$/, 'ripete il groove di battuta $1'],
  [/^a fill at the end of bar (\d+)$/, 'un fill alla fine di battuta $1'],
  [/^a snare roll in sixteenths, getting louder$/, 'un rullo di rullante in semicrome, in crescendo'],
  [/^down the toms, high to floor$/, 'giù per i tom, dall’acuto al timpano'],
  [/^a sparse fill: snare and toms in eighths$/, 'un fill leggero: rullante e tom in crome'],
];
export function reasonText(r: string, lang: string) {
  if (lang !== 'it') return r;
  for (const [re, it] of IT_REASONS) if (re.test(r)) return r.replace(re, it);
  return r;
}
