// About OpenBand (issue #4): the version you have and where it runs, and its update — from inside the
// desktop app (downloaded, checked, installed and restarted), the command for npx, nothing to do online.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useT } from '../i18n';
import { useBridge } from '../bridge';
import { useStore } from '../store';
import { APP_VERSION } from '../diagnostics';
import { desktop, type DesktopUpdateInfo } from '../desktop';

export const useAbout = create<{ open: boolean; available: string | null }>(() => ({ open: false, available: null }));
export const openAbout = () => useAbout.setState({ open: true });

const NPX = 'npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz';
const IS_ONLINE = typeof location !== 'undefined' && /github\.io$|openband\.it$/.test(location.hostname);

/** A new version the desktop app found at start: a toast once, and a dot on the menu. */
export function initUpdateNotice() {
  desktop?.update?.onAvailable(({ latest }) => {
    useAbout.setState({ available: latest });
    useStore.getState().notify(`OpenBand ${latest} is available: ⋯ → About OpenBand to update`);
  });
}

export function About() {
  const t = useT();
  const open = useAbout((s) => s.open);
  const bridge = useBridge();
  const [info, setInfo] = useState<DesktopUpdateInfo | null>(null);
  const [state, setState] = useState<'idle' | 'checking' | 'error' | 'installing'>('idle');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const check = async () => {
    if (!desktop?.update) return;
    setState('checking');
    try {
      setInfo(await desktop.update.check());
      setState('idle');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };
  useEffect(() => {
    if (open) void check();
    desktop?.update?.onProgress(({ fraction }) => setProgress(fraction));
  }, [open]);
  if (!open) return null;
  const close = () => state !== 'installing' && useAbout.setState({ open: false });
  const install = async () => {
    setState('installing');
    setProgress(0);
    try {
      const r = await desktop!.update!.install();
      if (r.installing === 'open') {
        setState('idle');
        useStore.getState().notify(r.note ?? t('about.opened'));
      }
      // Otherwise the app quits and the new one starts.
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };
  const where = desktop ? t('about.desktop', { os: desktop.platform === 'darwin' ? 'macOS' : desktop.platform === 'win32' ? 'Windows' : 'Linux' }) : IS_ONLINE ? t('about.online') : t('about.local');
  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal wav-export about" role="dialog" aria-label={t('about.title')}>
        <div className="modal-head">
          <div className="lib-title">{t('about.title')}</div>
        </div>
        <div className="wav-export-body">
          <p className="ab-version">
            OpenBand <b>{desktop?.version ?? APP_VERSION}</b> · {where}
          </p>
          {bridge.serverVersion && bridge.serverVersion !== (desktop?.version ?? APP_VERSION) && <p className="ca-note">{t('about.server', { v: bridge.serverVersion })}</p>}
          {desktop?.update ? (
            <>
              {state === 'checking' && <p className="ca-note">{t('about.checking')}</p>}
              {state === 'error' && <p className="rel-issue error">{error}</p>}
              {info && !info.update_available && state === 'idle' && <p>✓ {t('about.latest')}</p>}
              {info?.update_available && (
                <div className="ab-update">
                  <p>
                    <b>{t('about.available', { v: info.latest })}</b>{' '}
                    <a href={info.url} target="_blank" rel="noreferrer">
                      {t('about.notes')}
                    </a>
                  </p>
                  {state === 'installing' ? (
                    <>
                      <progress className="rel-progress" value={progress} />
                      <p className="ca-note">{progress < 1 ? t('about.downloading', { pct: Math.round(progress * 100) }) : t('about.restarting')}</p>
                    </>
                  ) : info.installs === 'page' ? (
                    <a className="btn primary" href={info.url} target="_blank" rel="noreferrer">
                      {t('about.download')}
                    </a>
                  ) : (
                    <button className="btn primary" onClick={() => void install()}>
                      {info.installs === 'in-place' ? t('about.updateNow') : t('about.openInstaller')}
                    </button>
                  )}
                  <p className="ca-note">{t('about.safe')}</p>
                </div>
              )}
            </>
          ) : IS_ONLINE ? (
            <p className="ca-note">{t('about.onlineUpdate')}</p>
          ) : (
            <>
              {bridge.update?.update_available ? <p><b>{t('about.available', { v: bridge.update.latest })}</b></p> : bridge.serverVersion && <p>✓ {t('about.latest')}</p>}
              <p className="ca-note">{t('about.npx')}</p>
              <code className="ab-cmd">{NPX}</code>
            </>
          )}
          <div className="row">
            {desktop?.update && state !== 'installing' && (
              <button className="btn" onClick={() => void check()}>
                {t('about.check')}
              </button>
            )}
            <button className="btn" onClick={close} disabled={state === 'installing'}>
              {t('about.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
