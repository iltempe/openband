// The rehearsal room panel (R2.7): what the Box is doing now, and its sessions.
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { backend } from '../storage';
import { ServerBackend } from '../storage/server';
import { download } from '../audio/render';
import { startTabRehearsal, stopTabRehearsal, useTabRehearsal } from '../tabRehearsal';

interface BoxStatus {
  state: 'off' | 'armed' | 'recording';
  level: number;
  session: string | null;
  error: string | null;
  disk: { free: number; total: number } | null;
}
interface BoxSession {
  id: string;
  at: number;
  seconds: number;
  songs: number;
  channels: number;
  marks: number;
  imported?: string;
  projectId?: string;
  starred: boolean;
  recovered: boolean;
}

const notify = (e: unknown) => useStore.getState().notify((e as Error).message);
const box = () => (backend() instanceof ServerBackend ? (backend() as ServerBackend) : null);
const get = async <T,>(path: string): Promise<T | null> => {
  const r = await box()?.req(`/box/${path}`).catch(() => null);
  return r?.ok ? ((await r.json()) as T) : null;
};
const post = (path: string, body?: unknown) => box()?.req(`/box/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) });

/** No Box here: the browser records, as long as the tab stays open. */
function TabRehearsal() {
  const t = useT();
  const s = useTabRehearsal();
  return (
    <div className="pj-panel bx-panel">
      <section className="pj-link">
        <h4>{t('bx.tabTitle')}</h4>
        <p className="pj-meta">{t('bx.tabNote')}</p>
        {s.on && <div className={`bx-state ${s.recording ? 'bx-recording' : 'bx-armed'}`}>{s.recording ? `${t('bx.state.recording')} · ${s.seconds} s` : t('bx.state.armed')}</div>}
        {s.on && !s.wake && <p className="pj-alert">{t('bx.noWake')}</p>}
        {s.error && <p className="pj-alert">{s.error}</p>}
        <button className="btn" onClick={() => void (s.on ? Promise.resolve(stopTabRehearsal()) : startTabRehearsal()).catch(notify)}>
          {s.on ? t('bx.stop') : t('bx.tabStart')}
        </button>
        <p className="pj-meta">{t('bx.privacy')}</p>
      </section>
    </div>
  );
}

export function RehearsalPanel() {
  const t = useT();
  const [status, setStatus] = useState<BoxStatus | null>(null);
  const [sessions, setSessions] = useState<BoxSession[]>([]);
  useEffect(() => {
    const tick = () => {
      void get<BoxStatus>('status').then(setStatus);
      void get<BoxSession[]>('sessions').then((s) => s && setSessions(s));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  const open = async (s: BoxSession) => {
    await runCommand('open_project', { id: s.projectId }, 'ui');
    await runCommand('checkout', { version_id: s.imported }, 'ui');
  };
  const wavs = async (s: BoxSession) => {
    for (let c = 1; c <= s.channels; c++) {
      const r = await box()!.req(`/box/sessions/${s.id}/channels/${c}.wav`);
      download(await r.blob(), `${s.id}-${c}.wav`);
    }
  };
  if (!status) return <TabRehearsal />;
  const meter = Math.max(0, Math.min(100, ((status.level + 60) / 60) * 100));
  return (
    <div className="pj-panel bx-panel">
      <section className="pj-link">
        <h4>{t('bx.tab')}</h4>
        <div className={`bx-state bx-${status.state}`}>{t(`bx.state.${status.state}` as never)}</div>
        <div className="bx-meter" role="meter" aria-label={t('bx.level')} aria-valuenow={Math.round(status.level)} aria-valuemin={-60} aria-valuemax={0}>
          <span style={{ width: `${meter}%` }} />
        </div>
        <div className="pj-actions">
          <button className="btn" disabled={status.state === 'off'} onClick={() => void post('rec')}>{status.state === 'recording' ? t('bx.stop') : t('bx.rec')}</button>
          <button className="btn" disabled={status.state !== 'recording'} onClick={() => void post('mark')}>{t('bx.mark')}</button>
          <button className="btn" onClick={() => void post(status.state === 'off' ? 'arm' : 'disarm')}>{status.state === 'off' ? t('bx.turnOn') : t('bx.turnOff')}</button>
        </div>
        {status.disk && <p className="pj-meta">{t('bx.disk', { gb: (status.disk.free / 1e9).toFixed(1) })}</p>}
        {status.error && <p className="pj-alert">{status.error}</p>}
        <p className="pj-meta">{t('bx.privacy')}</p>
      </section>
      <section style={{ gridColumn: 'span 2' }}>
        <h4>{t('bx.sessions')}</h4>
        {!sessions.length && <p className="pj-meta">{t('bx.noSessions')}</p>}
        {sessions.map((s) => (
          <div className="pj-row" key={s.id}>
            <div className="pj-name">
              <b>{new Date(s.at).toLocaleString()}</b>
              {s.recovered && <span className="pj-badge">{t('bx.recovered')}</span>}
            </div>
            <div className="pj-meta">{t('bx.summary', { min: Math.round(s.seconds / 60), songs: s.songs, marks: s.marks })}</div>
            <div className="pj-actions">
              <button className="btn" disabled={!s.imported} onClick={() => void open(s).catch(notify)}>{t('st.openBtn')}</button>
              <button className="btn" disabled={!s.imported} onClick={() => void open(s).then(() => runCommand('analyze_rehearsal', {}, 'ui')).catch(notify)}>{t('bx.analyse')}</button>
              <button className="btn" onClick={() => void wavs(s).catch(notify)}>{t('bx.wavs')}</button>
              <button className="btn" aria-pressed={s.starred} onClick={() => void post(`sessions/${s.id}/star`, { starred: !s.starred })}>{s.starred ? '★' : '☆'}</button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
