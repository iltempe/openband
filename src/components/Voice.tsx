// Hands-free studio (G4): the voice button in the toolbar, its settings, and push-to-talk on the ` key.
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { pressToTalk, releaseToTalk, setVoiceControl, useVoice } from '../voice/control';
import { removeVoiceModel, useVoiceModels, voiceModelReady, voskModelUrl, voskSource } from '../voice/models';
import { COMMANDS_HELP } from '../voice/grammar';
import * as I from './Icons';

const PTT_KEY = '`';
const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

export function VoiceButton() {
  const t = useT();
  const v = useVoice();
  const models = useVoiceModels();
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const status = models.status[v.lang];
  useEffect(() => void voiceModelReady(v.lang).then(setReady), [v.lang, status]);

  // Push-to-talk: hold ` (anywhere but in a text field).
  useEffect(() => {
    if (!v.enabled) return;
    const down = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY || e.repeat || typing(e)) return;
      e.preventDefault();
      void pressToTalk().catch(() => setOpen(true));
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== PTT_KEY || typing(e)) return;
      e.preventDefault();
      void releaseToTalk();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [v.enabled]);

  const mb = Math.round(voskSource(v.lang).bytes / 1e6);
  const download = () => {
    if (!window.confirm(t('vc.confirm', { mb }))) return;
    void voskModelUrl(v.lang, true)
      .then(() => setReady(true))
      .catch((e) => useVoice.setState({ error: (e as Error).message }));
  };

  return (
    <div className="menu-wrap">
      <button className={`icon-btn voice-btn ${v.enabled ? 'on' : ''} ${v.listening ? 'listening' : ''}`} onClick={() => setOpen(!open)} title={v.enabled ? t('vc.hold') : t('vc.title')}>
        <I.Voice />
        {v.listening && <span className="vc-level" style={{ transform: `scaleX(${Math.min(1, v.level * 6)})` }} />}
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu voice-menu" onKeyDown={(e) => e.stopPropagation()}>
            <div className="menu-label">{t('vc.title')}</div>
            <label className="vc-row">
              <input type="checkbox" checked={v.enabled} onChange={(e) => setVoiceControl({ enabled: e.target.checked })} /> {t('vc.enable')}
            </label>
            <label className="vc-row">
              {t('vc.lang')}
              <select value={v.lang} onChange={(e) => setVoiceControl({ lang: e.target.value as 'it' | 'en' })}>
                <option value="it">Italiano</option>
                <option value="en">English</option>
              </select>
            </label>
            <label className="vc-row">
              {t('vc.engine')}
              <select value={v.engine} onChange={(e) => setVoiceControl({ engine: e.target.value as 'vosk' | 'webspeech' })}>
                <option value="vosk">{t('vc.vosk')}</option>
                <option value="webspeech">{t('vc.webspeech')}</option>
              </select>
            </label>
            {v.engine === 'webspeech' && <p className="ca-note">{t('vc.webspeechNote')}</p>}
            {v.engine === 'vosk' && (
              <div className="vc-row">
                {status === 'downloading' ? (
                  <>
                    {t('vc.downloading', { got: Math.round(models.received / 1e6), total: mb })} <progress max={models.total || 1} value={models.received} />
                  </>
                ) : ready ? (
                  <>
                    {t('vc.ready')}{' '}
                    <button className="mini" onClick={() => void removeVoiceModel(v.lang).then(() => setReady(false))}>
                      {t('vc.remove')}
                    </button>
                  </>
                ) : (
                  <button className="mini" onClick={download}>
                    {t('vc.download', { mb })}
                  </button>
                )}
              </div>
            )}
            <div className="vc-row">
              {t('vc.ptt')}{' '}
              <button className="mini" onClick={() => useVoice.setState({ learning: true })}>
                {v.learning ? t('vc.learning') : v.pushToTalkCc !== null ? t('vc.pedal', { cc: v.pushToTalkCc }) : t('vc.learn')}
              </button>
            </div>
            <label className="vc-row">
              <input type="checkbox" checked={v.feedback} onChange={(e) => setVoiceControl({ feedback: e.target.checked })} /> {t('vc.feedback')}
            </label>
            {(v.heard || v.answer) && (
              <p className="ca-note">
                {v.heard && <>« {v.heard} » → </>}
                {v.answer}
              </p>
            )}
            {v.error && <p className="ca-note vc-error">{v.error}</p>}
            <p className="ca-note vc-help">{COMMANDS_HELP[v.lang]}</p>
          </div>
        </>
      )}
    </div>
  );
}
