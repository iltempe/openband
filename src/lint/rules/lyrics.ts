// Lyrics vs melody (F10), as a lint rule so it shows in the Problems panel and in CI.
import type { LintRule } from '../types';
import { prosodyIssues } from '../../lyrics/project';

export const lyricsProsody: LintRule = {
  id: 'lyrics_prosody',
  category: 'lyrics',
  severity: 'warn',
  check(p) {
    return prosodyIssues(p).map((i) => ({
      message: i.message,
      params: { ...i.params, code: i.code },
      target: { ...(p.lyrics?.melodyTrackId ? { track_id: p.lyrics.melodyTrackId } : {}), note_ids: i.note_ids, ...(i.from_beat !== undefined ? { from_beat: i.from_beat } : {}) },
    }));
  },
};
