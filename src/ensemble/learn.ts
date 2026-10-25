// A blind test's ranking, back to the engines that made the takes (through the ledger): what the user's
// ears chose becomes comparisons for the router's preferences (taste.ts).
import { useStore } from '../store';
import { recordRanking, styleOf } from './taste';

/** Rank takes → engines (best first) per capability; takes the user wrote count for nothing. */
export function learnFromRanking(regionId: string, rankedTakeIds: string[]) {
  const p = useStore.getState().project;
  const ledger = p.ledger ?? [];
  const byTake = (takeId: string) => ledger.find((e) => e.takeIds?.includes(takeId) && e.regionIds?.includes(regionId));
  const entries = rankedTakeIds.map(byTake);
  const capability = entries.find(Boolean)?.capability;
  if (!capability) return null;
  const engines = entries.filter((e): e is NonNullable<typeof e> => !!e && e.capability === capability).map((e) => e.engine);
  if (new Set(engines).size < 2) return null;
  const style = styleOf(entries.find(Boolean)?.request ?? '');
  recordRanking(capability, style, engines);
  return { capability, style, engines };
}
