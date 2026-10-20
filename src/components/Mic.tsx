// Microphone: toolbar button + popover, recording overlay and the AI's "may I record?" dialog.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { PRESETS } from '../audio/instruments';
import { armTrack, listInputs, recordFromMic, setMicOffset, setPunch, stopMicRecording, useMic, useRecSetup, type MicMode } from '../recording';
import { BEATS_PER_BAR } from '../music';
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

/** Input device, armed tracks and their inputs, punch-in/out with pre-roll, monitoring (F25). */
function RecordingSetup() {
  const t = useT();
  const setup = useRecSetup();
  const tracks = useStore((s) => s.project.tracks);
  const loop = useStore((s) => s.project.loop);
  useEffect(() => {
    void listInputs();
  }, []);
  const armed = Object.entries(setup.armed).filter(([id]) => tracks.some((x) => x.id === id));
  const bar = (b: number) => b / BEATS_PER_BAR + 1;
  return (
    <div className="rec-setup">
      <label className="mic-row">
        <span>{t('rec.input')}</span>
        <select value={setup.deviceId ?? ''} onChange={(e) => useRecSetup.setState({ deviceId: e.target.value || null })}>
          <option value="">{t('rec.defaultInput')}</option>
          {setup.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      {armed.length > 0 && (
        <div className="rec-armed">
          {armed.map(([id, ch]) => (
            <label key={id} className="mic-row">
              <span>{tracks.find((x) => x.id === id)!.name}</span>
              <select value={ch} onChange={(e) => armTrack(id, Number(e.target.value))}>
                {Array.from({ length: 8 }, (_, i) => (
                  <option key={i} value={i}>
                    {t('rec.inputN', { n: i + 1 })}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      {!armed.length && <div className="rec-hint">{t('rec.armHint')}</div>}
      <label className="mic-row mic-check">
        <input type="checkbox" checked={setup.punch.enabled} onChange={(e) => setPunch({ enabled: e.target.checked, ...(e.target.checked && !setup.punch.enabled && loop.enabled ? { inBeat: loop.start, outBeat: loop.end } : {}) })} />
        <span>{t('rec.punch')}</span>
      </label>
      {setup.punch.enabled && (
        <div className="mic-row rec-punch">
          <span>{t('rec.from')}</span>
          <input type="number" min={1} value={bar(setup.punch.inBeat)} onChange={(e) => void setPunch({ inBeat: (Math.max(1, Number(e.target.value)) - 1) * BEATS_PER_BAR })} />
          <span>{t('rec.to')}</span>
          <input type="number" min={2} value={bar(setup.punch.outBeat)} onChange={(e) => void setPunch({ outBeat: (Math.max(2, Number(e.target.value)) - 1) * BEATS_PER_BAR })} />
          <span>{t('rec.preRoll')}</span>
          <input type="number" min={0} max={8} value={setup.punch.preRollBars} onChange={(e) => void setPunch({ preRollBars: Math.max(0, Math.min(8, Number(e.target.value))) })} />
        </div>
      )}
      <label className="mic-row mic-check" title={t('rec.monitorHint')}>
        <input type="checkbox" checked={setup.monitor} onChange={(e) => useRecSetup.setState({ monitor: e.target.checked })} />
        <span>{t('rec.monitor')}</span>
      </label>
      {loop.enabled && !setup.punch.enabled && <div className="rec-hint">{t('rec.loopTakes')}</div>}
    </div>
  );
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
            <RecordingSetup />
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
