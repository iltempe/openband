// Projects panel (R1.6): the songs in this browser and on a server, and the link to that server.
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { startCompare } from '../versioning';
import { connectServer, disconnectServer, listProjects, useStoreLink, type ListedProject } from '../storage/sync';

const run = (m: string, a: Record<string, unknown>) => runCommand(m, a, 'ui');
const notify = (e: unknown) => useStore.getState().notify((e as Error).message);
const size = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

function Row({ p, onDone }: { p: ListedProject; onDone: () => void }) {
  const t = useT();
  const url = useStoreLink((s) => s.url);
  const own = useStoreLink((s) => s.own);
  const act = (m: string, a: Record<string, unknown>) => run(m, a).then(onDone).catch(notify);
  return (
    <div className="pj-row" data-project={p.id}>
      <div className="pj-name">
        <b>{p.name}</b>
        {p.open && <span className="pj-badge">{t('st.open')}</span>}
        {p.state && <span className={`pj-badge pj-${p.state}`}>{t(`st.state.${p.state}` as never)}</span>}
      </div>
      <div className="pj-meta">
        {p.bpm} BPM · {p.key} · {t('st.versions', { n: p.versions })}
      </div>
      <div className="pj-actions">
        {!p.open && (
          <button className="btn" onClick={() => void act('open_project', { id: p.id })}>
            {t('st.openBtn')}
          </button>
        )}
        {url && !own && p.source === 'local' && (
          <button className="btn" onClick={() => void act('move_project', { id: p.id, to: 'server' })}>
            {t('st.toServer')}
          </button>
        )}
        {!own && p.source === 'server' && (
          <button className="btn" onClick={() => void act('move_project', { id: p.id, to: 'local' })}>
            {t('st.toLocal')}
          </button>
        )}
      </div>
    </div>
  );
}

export function ProjectsPanel() {
  const t = useT();
  const link = useStoreLink();
  const [list, setList] = useState<ListedProject[]>([]);
  const [url, setUrl] = useState(/^https?:/.test(location.protocol) ? location.origin : '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const songId = useStore((s) => s.project.meta?.projectId);
  const refresh = () => void listProjects().then(setList).catch(notify);
  useEffect(refresh, [link.url, link.status.state, songId]);
  const connect = async () => {
    setBusy(true);
    await connectServer(url, code || undefined).then(() => setCode('')).catch(notify);
    setBusy(false);
  };
  const local = list.filter((p) => p.source === 'local');
  const remote = list.filter((p) => p.source === 'server');
  return (
    <div className="pj-panel">
      <section className="pj-link">
        <h4>{t('st.archive')}</h4>
        {link.url && !link.own ? (
          <>
            <div className="pj-meta">
              <b>{link.name ?? link.url}</b> · <span className={`pj-badge pj-${link.status.state}`}>{t(`st.state.${link.status.state}` as never)}</span>
            </div>
            {link.space && <div className="pj-meta">{t('st.space', { used: size(link.space.used), quota: size(link.space.quota) })}</div>}
            <button className="btn" onClick={disconnectServer}>
              {t('st.disconnect')}
            </button>
          </>
        ) : (
          <>
            {link.own && <p className="pj-meta">{t('st.ownNote')}{link.space ? ` ${t('st.space', { used: size(link.space.used), quota: size(link.space.quota) })}` : ''}</p>}
            <p className="pj-meta">{t('st.intro')}</p>
            <input className="pj-input" aria-label={t('st.url')} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
            <input className="pj-input" aria-label={t('st.code')} placeholder={t('st.code')} value={code} onChange={(e) => setCode(e.target.value)} />
            <button className="btn" disabled={busy || !url} onClick={() => void connect()}>
              {t('st.connect')}
            </button>
          </>
        )}
        {link.conflict && (
          <div className="pj-alert" role="alert">
            <p>{t('st.conflictNote', { branch: link.conflict.branch })}</p>
            <button className="btn" onClick={() => void startCompare(link.conflict!.versionId).catch(notify)}>
              {t('st.compare')}
            </button>
            <button className="btn" onClick={() => void run('merge', { from_branch: link.conflict!.branch }).then(() => useStoreLink.setState({ conflict: null })).catch(notify)}>
              {t('st.merge')}
            </button>
          </div>
        )}
      </section>
      <section>
        <h4>{t('st.here')}</h4>
        {local.length ? local.map((p) => <Row key={p.id} p={p} onDone={refresh} />) : <p className="pj-meta">{t('st.noneHere')}</p>}
      </section>
      {link.url && (
        <section>
          <h4>{t('st.onServer', { name: link.name ?? link.url })}</h4>
          {remote.length ? remote.map((p) => <Row key={p.id} p={p} onDone={refresh} />) : <p className="pj-meta">{t('st.noneThere')}</p>}
        </section>
      )}
    </div>
  );
}
