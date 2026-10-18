// Microphone: toolbar button + popover, recording overlay and the AI's "may I record?" dialog.
import { useState } from 'react';
import { useStore } from '../store';
import { PRESETS } from '../audio/instruments';
import { recordFromMic, setMicOffset, stopMicRecording, useMic, type MicMode } from '../recording';
import { useT } from '../i18n';
import * as I from './Icons';

async function start(mode: MicMode) {
  const s = useStore.getState();
  const track = s.project.tracks.find((t) => t.id === s.selectedTrackId);
  try {
    const r = await recordFromMic({ mode, trackId: track?.kind === 'audio' ? track.id : undefined });
    if (r.midi) s.notify(`♪ ${r.midi.notes}`);
  } catch (e) {
    s.notify((e as Error).message);
  }
}

export function MicButton() {
  const [open, setOpen] = useState(false);
  const mic = useMic();
  const t = useT();
  const busy = mic.state !== 'idle';
  return (
    <div className="menu-wrap">
      <button className={`t-btn t-mic ${busy ? 'on' : ''}`} onClick={() => (busy ? stopMicRecording() : setOpen(!open))} title={t('mic.title')}>
        <I.Mic />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu mic-menu">
            <button onClick={() => (setOpen(false), void start('audio'))}>
              <b>{t('mic.recordAudio')}</b>
              <span>{t('mic.recordAudioSub')}</span>
            </button>
            <button onClick={() => (setOpen(false), void start('hum'))}>
              <b>{t('mic.hum')}</b>
              <span>{t('mic.humSub')}</span>
            </button>
            <hr />
            <label className="mic-row">
              <span>{t('mic.humAs')}</span>
              <select value={mic.humInstrument} onChange={(e) => useMic.setState({ humInstrument: e.target.value })}>
                {PRESETS.filter((p) => p.kind === 'instrument').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mic-row" title={t('mic.latencyHint')}>
              <span>{t('mic.latency')}</span>
              <input type="number" step={1} value={mic.offsetMs} onChange={(e) => setMicOffset(Number(e.target.value) || 0)} />
              <span>ms</span>
            </label>
          </div>
        </>
      )}
    </div>
  );
}

export function MicOverlay() {
  const mic = useMic();
  const t = useT();
  if (mic.state === 'idle') return null;

  if (mic.state === 'confirm' && mic.request) {
    const r = mic.request;
    const answer = (ok: boolean) => {
      useMic.setState({ state: 'idle', request: null });
      r.resolve(ok);
    };
    return (
      <div className="modal-scrim">
        <div className="modal mic-confirm">
          <div className="modal-head">
            <div>
              <div className="lib-title">{t('mic.aiAsks')}</div>
              <div className="lib-sub">{t(r.mode === 'hum' ? 'mic.aiAsksHum' : 'mic.aiAsksAudio', { bar: r.startBar, bars: r.bars ?? '∞' })}</div>
            </div>
          </div>
          <div className="mic-confirm-buttons">
            <button className="btn" onClick={() => answer(false)}>
              {t('mic.decline')}
            </button>
            <button className="btn primary" autoFocus onClick={() => answer(true)}>
              {t('mic.allow')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mic-overlay">
      <span className={`mic-dot ${mic.state}`} />
      <span className="mic-status">
        {mic.state === 'countin' ? `${t('mic.countin')} ${mic.countdown || ''}` : mic.state === 'recording' ? t(mic.mode === 'hum' ? 'mic.humming' : 'mic.recording') : t('mic.processing')}
      </span>
      <div className="mic-meter">
        <div style={{ width: `${Math.round(mic.level * 100)}%` }} />
      </div>
      {mic.state !== 'processing' && (
        <button className="btn" onClick={stopMicRecording}>
          {t('mic.stop')}
        </button>
      )}
    </div>
  );
}
