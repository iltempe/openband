// Stem separation in the studio: the model's state in Ensemble (download once, remove), and the button
// on an audio region. The download is never started without the user's OK.
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { runCommand } from '../commands';
import { downloadModel, modelSource, refreshModelStatus, removeModel, useSeparationModel } from '../separate/model';
import { useSeparation } from '../ensemble/separate';

const mb = (b: number) => (b / 1e6).toFixed(0);

export function SeparationSection() {
  const t = useT();
  const m = useSeparationModel();
  const run = useSeparation();
  useEffect(() => void refreshModelStatus(), []);
  const size = mb(modelSource().bytes);
  return (
    <section className="en-separate">
      <h4>{t('sep.title')}</h4>
      <p className="ca-note">{t('sep.note', { mb: size })}</p>
      <div className="en-relay">
        <span>{m.status === 'ready' ? t('sep.ready') : m.status === 'downloading' ? t('sep.downloading', { got: mb(m.received), total: mb(m.total) }) : m.status === 'error' ? m.error : t('sep.absent')}</span>
        {m.status === 'downloading' && <progress max={m.total || 1} value={m.received} />}
        {(m.status === 'absent' || m.status === 'error' || m.status === 'unknown') && (
          <button className="btn" onClick={() => void downloadModel().catch(() => {})}>
            {t('sep.download', { mb: size })}
          </button>
        )}
        {m.status === 'ready' && (
          <button className="btn" onClick={() => void removeModel()}>
            {t('sep.remove')}
          </button>
        )}
      </div>
      {run.running && <p className="ca-note">{t('sep.running', { name: run.label, done: run.done, total: run.total || '…' })}</p>}
    </section>
  );
}

/** On an audio region: separate it, asking first if the model would have to be downloaded. */
export function SeparateButton({ regionId }: { regionId: string }) {
  const t = useT();
  const run = useSeparation();
  const [msg, setMsg] = useState<string | null>(null);
  const go = async () => {
    setMsg(null);
    let confirm = false;
    if ((await refreshModelStatus()) !== 'ready') {
      if (!window.confirm(t('sep.confirm', { mb: mb(modelSource().bytes) }))) return;
      confirm = true;
    }
    try {
      const r = (await runCommand('separate', { region_id: regionId, confirm_download: confirm }, 'ui')) as { stems: { stem: string }[] };
      setMsg(t('sep.done', { list: r.stems.map((s) => s.stem).join(', ') }));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <>
      <button className="mini" disabled={run.running} onClick={() => void go()} title={t('sep.hint')}>
        {run.running ? t('sep.running', { name: run.label, done: run.done, total: run.total || '…' }) : t('sep.button')}
      </button>
      {msg && !run.running && <span className="eb-val">{msg}</span>}
    </>
  );
}
