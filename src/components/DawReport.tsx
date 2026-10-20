// "What wasn't imported" (F17): every part of a DAWproject that OpenBand could not carry over.
import { useDawReport } from '../interop/dawproject';
import type { ReportItem } from '../interop/dawproject/report';
import { useT } from '../i18n';
import * as I from './Icons';

export function DawReportDialog() {
  const r = useDawReport();
  const t = useT();
  if (!r.open) return null;
  const close = () => useDawReport.setState({ open: false });
  const line = (i: ReportItem) => t(`dp.${i.code}`, { track: i.track ?? '', detail: i.detail ?? '' });
  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal dp-report" role="dialog" aria-label={t('dp.title')}>
        <div className="modal-head">
          <div>
            <div className="lib-title">{t('dp.title')}</div>
            <div className="lib-sub">{r.application ? t('dp.from', { app: r.application, file: r.file }) : r.file}</div>
          </div>
          <button className="icon-btn" onClick={close}>
            <I.Close />
          </button>
        </div>
        {r.lossless ? <p>{t('dp.lossless')}</p> : !r.items.length ? <p>{t('dp.nothing')}</p> : null}
        <ul className="dp-list">
          {r.items.map((i, k) => (
            <li key={k}>
              {i.track && <b>{i.track}: </b>}
              {line(i)}
            </li>
          ))}
        </ul>
        <div className="ver-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={close}>
            {t('dp.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
