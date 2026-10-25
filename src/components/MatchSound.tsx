// Sound-alike in the studio (G5): match a sample with OpenBand's synths (three candidates, each to A/B
// against the original and use), and tone-match an audio track to a reference.
import { useState } from 'react';
import type { Track } from '../types';
import { useT } from '../i18n';
import { runCommand } from '../commands';
import { useSamples } from '../audio/samples';
import { useStore } from '../store';
import { useMatch, auditionCandidate } from '../soundmatch/match';

type Candidate = { candidate_id: string; preset: string; similarity: number };

export function MatchSound({ track }: { track: Track }) {
  const t = useT();
  const samples = useSamples((s) => s.info);
  const m = useMatch();
  const [sampleId, setSampleId] = useState('');
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const ids = Object.keys(samples);
  const id = sampleId || ids[0] || '';
  if (!ids.length) return <div className="inst-note">{t('sm.needSample')}</div>;
  const go = async () => {
    setFound(null);
    setNote(null);
    try {
      const r = (await runCommand('match_sound', { sample_id: id }, 'ui')) as { candidates: Candidate[]; warning?: string; took_s: number };
      setFound(r.candidates);
      setNote(r.warning ?? t('sm.took', { s: r.took_s }));
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  return (
    <div className="sm-match">
      <div className="row">
        <span className="syn-label">{t('sm.title')}</span>
        <select value={id} onChange={(e) => setSampleId(e.target.value)} disabled={m.busy}>
          {ids.map((k) => (
            <option key={k} value={k}>
              {samples[k].name}
            </option>
          ))}
        </select>
        <button className="btn" disabled={m.busy} onClick={() => void go()}>
          {m.busy ? t('sm.busy', { done: m.done, total: m.total }) : t('sm.go')}
        </button>
      </div>
      {found && (
        <ul className="sm-list">
          {found.map((c) => (
            <li key={c.candidate_id}>
              <b>{c.preset}</b> <span className="sm-sim">{Math.round(c.similarity * 100)} %</span>
              <button className="mini" onClick={() => void auditionCandidate(c.candidate_id)} title={t('sm.abHint')}>
                A/B
              </button>
              <button className="mini" onClick={() => void runCommand('apply_patch', { candidate_id: c.candidate_id, track_id: track.id }, 'ui')}>
                {t('sm.use')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <div className="inst-note">{note}</div>}
    </div>
  );
}

/** Tone match for an audio track: towards the song's reference track, or a sample. */
export function ToneMatch({ track }: { track: Track }) {
  const t = useT();
  const reference = useStore((s) => s.project.reference);
  const samples = useSamples((s) => s.info);
  const [src, setSrc] = useState(reference ? 'reference' : '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const options = [...(reference ? [['reference', reference.name] as const] : []), ...Object.entries(samples).map(([k, v]) => [k, v.name] as const)];
  if (!options.length) return null;
  const pick = src || options[0][0];
  const go = async () => {
    setBusy(true);
    try {
      const r = (await runCommand('tone_match', { track_id: track.id, ...(pick === 'reference' ? { reference_from_seconds: reference?.from ?? 0, to_seconds: reference?.to ?? (reference?.from ?? 0) + 30 } : { sample_id: pick }) }, 'ui')) as { gap_db: { before: number; after: number }; drive: number };
      setNote(t('sm.toneDone', { before: r.gap_db.before, after: r.gap_db.after, drive: Math.round(r.drive * 100) }));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sm-match">
      <div className="row">
        <span className="syn-label">{t('sm.tone')}</span>
        <select value={pick} onChange={(e) => setSrc(e.target.value)}>
          {options.map(([k, name]) => (
            <option key={k} value={k}>
              {name}
            </option>
          ))}
        </select>
        <button className="btn" disabled={busy} onClick={() => void go()}>
          {busy ? '…' : t('sm.toneGo')}
        </button>
      </div>
      {note && <div className="inst-note">{note}</div>}
    </div>
  );
}
