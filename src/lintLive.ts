// Keeps the symbolic lint of the open project up to date (1 s after the last change), for the
// Problems panel and its toolbar badge.
import { create } from 'zustand';
import { useStore } from './store';
import { lint } from './lint/engine';
import type { LintIssue } from './lint/types';

export const useLint = create<{ issues: LintIssue[]; counts: { error: number; warn: number; info: number } }>(() => ({ issues: [], counts: { error: 0, warn: 0, info: 0 } }));

const run = () => useLint.setState(lint(useStore.getState().project));
let timer: ReturnType<typeof setTimeout> | undefined;
run();
useStore.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  clearTimeout(timer);
  timer = setTimeout(run, 1000);
});
