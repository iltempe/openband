// Lyrics: editor panel (per section), syllable lane under the melody track, prosody marks.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Track } from '../types';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { prosodyIssues, lineGroups, melodyNotes } from '../lyrics/project';
import { useT } from '../i18n';
import * as I from './Icons';

const run = (method: string, params: Record<string, unknown>) => runCommand(method, params, 'ui').catch((e) => useStore.getState().notify((e as Error).message));

export function LyricsPanel() {
  const project = useStore((s) => s.project);
  const t = useT();
  const doc = project.lyrics;
  const sections = [...(project.sections ?? [])].sort((a, b) => a.start - b.start);
  const [sectionId, setSectionId] = useState<string>(sections[0]?.id ?? '');
  const lines = (doc?.lines ?? []).filter((l) => (sectionId ? l.sectionId === sectionId : !l.sectionId));
  const [text, setText] = useState(lines.map((l) => l.text).join('\n'));
  useEffect(() => {
    setText(lines.map((l) => l.text).join('\n'));
  }, [sectionId, doc?.lines.length]);
  const melodic = project.tracks.filter((tr) => tr.kind === 'instrument');
  const melody = doc?.melodyTrackId ?? '';
  const issues = useMemo(() => prosodyIssues(project, sectionId || undefined), [project, sectionId]);
  const group = lineGroups(project, sectionId || undefined)[0];
  const notesInSpan = melody && group ? melodyNotes(project, melody, group.from, group.to).length : 0;

  return (
    <div className="lyrics-panel">
      <div className="analysis-bar">
        <label className="ly-field">
          {t('ly.section')}
          <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="">{t('ly.wholeSong')}</option>
          </select>
        </label>
        <label className="ly-field">
          {t('ly.language')}
          <select value={doc?.language ?? 'it'} onChange={(e) => run('set_lyrics', { section_id: sectionId || undefined, text, language: e.target.value })}>
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="ly-field">
          {t('ly.melody')}
          <select value={melody} onChange={(e) => e.target.value && run('align_lyrics', { melody_track_id: e.target.value })}>
            <option value="">—</option>
            {melodic.map((tr) => (
              <option key={tr.id} value={tr.id}>
                {tr.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" onClick={() => run('set_lyrics', { section_id: sectionId || undefined, text, language: doc?.language })}>
          {t('ly.apply')}
        </button>
        <button className="btn" disabled={!melody} onClick={() => run('align_lyrics', { melody_track_id: melody, section_id: sectionId || undefined })}>
          {t('ly.align')}
        </button>
        <button className="btn" onClick={() => run('export_chord_sheet', { format: 'chordpro' })}>
          ChordPro
        </button>
      </div>
      <div className="ly-body">
        <textarea className="ly-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('ly.placeholder')} spellCheck={false} />
        <div className="ly-lines">
          {lines.map((l) => (
            <div key={l.id} className="ly-line">
              <div className="ly-syls">
                {l.syllables.map((s, i) => (
                  <span key={i} className={`ly-syl ${s.stressed ? 'stressed' : ''} ${s.noteId ? '' : 'orphan'} ${issues.some((x) => x.line_id === l.id && x.note_ids.includes(s.noteId ?? '-')) ? 'bad' : ''}`}>
                    {s.text}
                  </span>
                ))}
              </div>
              <span className="ly-count">{t('ly.count', { n: l.syllables.length })}</span>
            </div>
          ))}
          {melody && <div className="ly-dim">{t('ly.notes', { n: notesInSpan })}</div>}
          {issues.map((i, k) => (
            <div key={k} className="ly-issue">
              <span className="an-sev" /> {i.message}
            </div>
          ))}
          {!lines.length && <div className="ly-dim">{t('ly.empty')}</div>}
        </div>
      </div>
    </div>
  );
}

/** Syllables at their beats, under the melody track. */
export function LyricsLane({ track }: { track: Track }) {
  const doc = useStore((s) => s.project.lyrics);
  const zoom = useStore((s) => s.zoom);
  const set = useStore((s) => s.set);
  if (!doc || doc.melodyTrackId !== track.id) return null;
  const syls = doc.lines.flatMap((l) => l.syllables.filter((s) => s.beat !== undefined)).sort((a, b) => a.beat! - b.beat!);
  if (!syls.length) return null;
  return (
    <div className="ly-row" style={{ '--track': track.color } as CSSProperties}>
      <div className="auto-head ly-head">
        <I.PianoRoll width={13} height={13} /> <span>{track.name}</span>
        <button className="mini" onClick={() => set({ bottom: 'lyrics' })}>
          ✎
        </button>
      </div>
      <div className="ly-lane">
        {syls.map((s, i) => (
          <span
            key={i}
            className={`ly-lane-syl ${s.stressed ? 'stressed' : ''}`}
            // Each syllable gets the room until the next one, so they never overlap.
            style={{ left: s.beat! * zoom, maxWidth: syls[i + 1] ? Math.max(6, (syls[i + 1].beat! - s.beat!) * zoom - 2) : undefined }}
            title={s.text}
          >
            {s.text}
          </span>
        ))}
      </div>
    </div>
  );
}

/** note id → syllable (for the piano roll). */
export function useSyllablesByNote(trackId: string) {
  const doc = useStore((s) => s.project.lyrics);
  const project = useStore((s) => s.project);
  return useMemo(() => {
    const map = new Map<string, { text: string; stressed: boolean; bad: boolean }>();
    if (!doc || doc.melodyTrackId !== trackId) return map;
    const bad = new Set(prosodyIssues(project).flatMap((i) => i.note_ids));
    for (const l of doc.lines) for (const s of l.syllables) if (s.noteId) map.set(s.noteId, { text: s.text, stressed: s.stressed, bad: bad.has(s.noteId) });
    return map;
  }, [doc, trackId, project]);
}
