// "A/B level-matched" (F20) for a track's whole FX chain or one plugin.
import { useState } from 'react';
import type { Track } from '../types';
import { useStore } from '../store';
import { applyCompensation, levelMatch, toggleMatchedBypass, useLevelMatch } from '../levelMatch';
import { useT } from '../i18n';

export function LevelMatchControl({ track, slotId = null, compact = false }: { track: Track; slotId?: string | null; compact?: boolean }) {
  const t = useT();
  const key = `${track.id}:${slotId ?? ''}`;
  const res = useLevelMatch((s) => s.results[key]);
  const hearing = useLevelMatch((s) => s.hearing === key);
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const measure = async () => {
    setBusy(true);
    try {
      await levelMatch(track.id, slotId);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`lm-row ${compact ? 'compact' : ''}`}>
      <button className="mini" onClick={measure} disabled={busy} title={t('lm.measureTitle')}>
        {busy ? '…' : t('lm.measure')}
      </button>
      {res && (
        <>
          <button className={`mini ${hearing ? 'on' : ''}`} onClick={() => toggleMatchedBypass(track.id, slotId)}>
            {hearing ? t('lm.hearA') : t('lm.hearB')}
          </button>
          {Math.abs(res.gain_change_db) >= 0.3 && (
            <button
              className="mini"
              title={t('lm.applyTitle')}
              onClick={() => {
                if (hearing) toggleMatchedBypass(track.id, slotId);
                applyCompensation(track.id, res.gain_change_db);
                useLevelMatch.setState((s) => {
                  const { [key]: _, ...rest } = s.results;
                  return { results: rest };
                });
              }}
            >
              {t('lm.apply')}
            </button>
          )}
          {!compact && <span className="lm-msg">{res.message}</span>}
        </>
      )}
      {!compact && !!track.fx?.trim && <span className="lm-msg">{t('lm.trim', { db: (track.fx.trim > 0 ? '+' : '') + track.fx.trim.toFixed(1) })}</span>}
      {compact && res && <span className="lm-msg" title={res.message}>{(res.gain_change_db > 0 ? '+' : '') + res.gain_change_db.toFixed(1)} dB</span>}
    </div>
  );
}
