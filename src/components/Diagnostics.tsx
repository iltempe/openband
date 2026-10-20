// Diagnostics page (⋯ menu), "Report a problem" with a preview of what is sent, and the error screen.
import { Component, useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { bugReportUrl, collectDiagnostics, diagnosticsText, logError, type Diagnostics } from '../diagnostics';
import { t as tr, useT } from '../i18n';
import * as I from './Icons';

export const useDiagnostics = create<{ open: boolean }>(() => ({ open: false }));

export function DiagnosticsPage() {
  const open = useDiagnostics((d) => d.open);
  const [d, setD] = useState<Diagnostics | null>(null);
  const [preview, setPreview] = useState(false);
  const [title, setTitle] = useState('');
  const t = useT();
  useEffect(() => {
    if (open) void collectDiagnostics().then(setD);
    else setPreview(false);
  }, [open]);
  if (!open) return null;
  const close = () => useDiagnostics.setState({ open: false });
  const report = d ? bugReportUrl(d, title ? `[bug] ${title}` : '') : null;
  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal diag-modal">
        <div className="modal-head">
          <div>
            <div className="lib-title">{t('diag.title')}</div>
            <div className="lib-sub">{t('diag.sub')}</div>
          </div>
          <button className="icon-btn" onClick={close}>
            <I.Close />
          </button>
        </div>
        <pre className="diag-text">{d ? diagnosticsText(d) : '…'}</pre>
        {preview && report && (
          <div className="diag-report">
            <label className="mic-row">
              <span>{t('diag.issueTitle')}</span>
              <input value={title} placeholder={t('diag.issuePh')} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <div className="ver-meta">{t('diag.willSend')}</div>
          </div>
        )}
        <div className="takes-foot">
          <button className="btn" disabled={!d} onClick={() => d && navigator.clipboard?.writeText(diagnosticsText(d))}>
            <I.Copy width={13} height={13} /> {t('diag.copy')}
          </button>
          <span className="takes-spacer" />
          {!preview ? (
            <button className="btn primary" disabled={!d} onClick={() => setPreview(true)}>
              {t('diag.report')}
            </button>
          ) : (
            <a className="btn primary" href={report?.url} target="_blank" rel="noreferrer">
              {t('diag.openIssue')}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** When the UI crashes: say the work is safe (autosaved), offer reload and report. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    logError(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="splash">
        <div className="welcome-card crash-card">
          <h1>{tr('crash.title')}</h1>
          <p>{tr('crash.safe')}</p>
          <pre className="diag-text">{String(this.state.error.message).slice(0, 300)}</pre>
          <div className="welcome-more">
            <button className="btn primary" onClick={() => location.reload()}>
              {tr('crash.reload')}
            </button>
            <button className="btn" onClick={async () => window.open(bugReportUrl(await collectDiagnostics(), '[crash] ' + this.state.error!.message.slice(0, 80)).url, '_blank')}>
              {tr('crash.report')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
