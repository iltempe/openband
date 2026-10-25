// Blind A/B test of takes (F12). The letter → take mapping lives only in this module's closure until
// the test is closed: it is never put in a store, in the DOM or in the project.
import { create } from 'zustand';
import type { AudioClip, LoopRange, Note } from './types';
import { useStore } from './store';
import { engine } from './audio/engine';
import { uid } from './music';
import { shuffled } from './takes';
import { emitStudioEvent } from './events';
import { learnFromRanking } from './ensemble/learn';

export const LETTERS = ['A', 'B', 'C', 'D'];

interface ABView {
  testId: string | null;
  /** Letters on screen, e.g. ['A','B','C']. */
  letters: string[];
  current: string | null;
  /** After confirming: letter → take name, in the user's ranking order. */
  revealed: { letter: string; take_id: string; name: string }[] | null;
}

export const useAB = create<ABView>(() => ({ testId: null, letters: [], current: null, revealed: null }));

let secret: { testId: string; regionId: string; order: string[]; notes: Note[]; audio?: AudioClip; loop: LoopRange; wasPlaying: boolean } | null = null;

const st = () => useStore.getState();

function setRegionNotes(regionId: string, notes: Note[], audio?: AudioClip) {
  // Listening only: not an edit, not an undo step. Audio takes switch the clip.
  st().commit((d) => {
    const r = d.regions.find((x) => x.id === regionId);
    if (!r) return;
    r.notes = notes.map((n) => ({ ...n }));
    if (audio) r.audio = { ...audio };
  }, { history: false });
}

export async function startABTest(regionId: string, takeIds: string[], loop = true) {
  if (secret) throw new Error('A blind test is already open');
  const r = st().project.regions.find((x) => x.id === regionId);
  if (!r) throw new Error(`Region "${regionId}" not found`);
  const ids = [...new Set(takeIds)];
  if (ids.length < 2 || ids.length > 4) throw new Error('Give 2 to 4 different take ids');
  for (const t of ids) if (!r.takes?.some((x) => x.id === t)) throw new Error(`Take "${t}" not found in this region`);
  const p = st().project;
  if (r.audio && !ids.every((t) => r.takes!.find((x) => x.id === t)?.audio)) throw new Error('These takes have no audio to compare');
  secret = { testId: uid('ab'), regionId, order: shuffled(ids), notes: r.notes.map((n) => ({ ...n })), ...(r.audio ? { audio: { ...r.audio } } : {}), loop: { ...p.loop }, wasPlaying: engine.playing };
  if (loop) {
    st().commit((d) => void (d.loop = { enabled: true, start: r.start, end: r.start + r.length }), { history: false });
    engine.position = r.start;
  }
  useAB.setState({ testId: secret.testId, letters: LETTERS.slice(0, ids.length), current: null, revealed: null });
  choose('A');
  if (!engine.playing) {
    await engine.play();
    st().set({ isPlaying: true });
  }
  return { test_id: secret.testId, letters: LETTERS.slice(0, ids.length) };
}

/** Hear the take behind a letter, without stopping playback. */
export function choose(letter: string) {
  if (!secret) return;
  const i = LETTERS.indexOf(letter);
  const takeId = secret.order[i];
  const take = st().project.regions.find((x) => x.id === secret!.regionId)?.takes?.find((t) => t.id === takeId);
  if (!take) return;
  setRegionNotes(secret.regionId, take.notes, take.audio);
  useAB.setState({ current: letter });
}

function close() {
  const s = secret!;
  secret = null;
  setRegionNotes(s.regionId, s.notes, s.audio);
  st().commit((d) => void (d.loop = s.loop), { history: false });
  if (!s.wasPlaying) {
    engine.stop();
    st().set({ isPlaying: false });
  }
  return s;
}

/** The user's ranking (letters, best first): reveal the takes and tell the AI. */
export function finishABTest(rankingLetters: string[]) {
  if (!secret) return;
  const s = close();
  const takes = st().project.regions.find((x) => x.id === s.regionId)?.takes ?? [];
  const ranking = rankingLetters.map((l) => s.order[LETTERS.indexOf(l)]).filter(Boolean);
  useAB.setState({
    current: null,
    revealed: rankingLetters.map((l, i) => ({ letter: l, take_id: ranking[i], name: takes.find((t) => t.id === ranking[i])?.name ?? '?' })),
  });
  emitStudioEvent({ kind: 'ab_result', test_id: s.testId, ranking });
  learnFromRanking(s.regionId, ranking);
}

export function cancelABTest() {
  if (!secret) return;
  const s = close();
  useAB.setState({ testId: null, letters: [], current: null, revealed: null });
  emitStudioEvent({ kind: 'ab_result', test_id: s.testId, ranking: [] });
}

export const dismissAB = () => useAB.setState({ testId: null, letters: [], current: null, revealed: null });
export const abRegionId = () => secret?.regionId ?? null;
