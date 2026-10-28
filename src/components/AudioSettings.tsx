// Audio & MIDI (issue #6): the latency you hear, how low the studio asks the system to go, the MIDI inputs.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useT } from '../i18n';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { useDevices, measureLatency } from '../firstRun';
import { LATENCY_KEY, LATENCY_MODES, latencyMode, type LatencyMode } from '../audio/context';

export const useAudioSettings = create<{ open: boolean }>(() => ({ open: false }));
export const openAudioSettings = () => useAudioSettings.setState({ open: true });

export function AudioSettings() {
  const t = useT();
  const open = useAudioSettings((s) => s.open);
  const { midiInputs, latencyMs } = useDevices();
  const [mode, setMode] = useState<LatencyMode>(latencyMode);
  useEffect(() => {
    if (open) measureLatency();
  }, [open]);
  if (!open) return null;
  const close = () => useAudioSettings.setState({ open: false });
  const apply = () => {
    try {
      localStorage.setItem(LATENCY_KEY, mode);
    } catch {
      // private mode: only for this session
    }
    // A new latency needs a new audio context: reload (the song is autosaved).
    location.reload();
  };
  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal wav-export" role="dialog" aria-label={t('au.title')}>
        <div className="modal-head">
          <div className="lib-title">{t('au.title')}</div>
        </div>
        <div className="wav-export-body">
          <p className="au-latency">
            {t('au.now')} <b>{latencyMs !== null ? `${latencyMs} ms` : '—'}</b>
          </p>
          <label className="mic-row">
            <span>{t('au.mode')}</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as LatencyMode)}>
              {LATENCY_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`au.m.${m}` as never)}
                </option>
              ))}
            </select>
          </label>
          <p className="ca-note">{t('au.modeHint')}</p>
          <h4 className="au-h">{t('au.midi')}</h4>
          <ul className="au-midi">{midiInputs.length ? midiInputs.map((n) => <li key={n}>🎹 {n}</li>) : <li className="ca-note">{t('au.noMidi')}</li>}</ul>
          <p className="ca-note">{t('au.channelsHint')}</p>
          <div className="row left">
            <button className="btn" onClick={() => void runCommand('map_midi_channels', {}, 'ui').then((r) => useStore.getState().notify(t('au.mapped', { n: (r as { tracks: unknown[] }).tracks.length })))}>
              {t('au.map')}
            </button>
            <button className="mini" onClick={() => void runCommand('map_midi_channels', { clear: true }, 'ui')}>
              {t('au.unmap')}
            </button>
          </div>
          <p className="ca-note">{t('au.linux')}</p>
          <div className="row">
            <button className="btn" onClick={close}>
              {t('pub.cancel')}
            </button>
            <button className="btn primary" onClick={apply} disabled={mode === latencyMode()}>
              {t('au.apply')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
