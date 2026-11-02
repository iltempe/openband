// Cassettes panel (D1.4): burn a tape from your songs, and give it away.
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { useBurn } from '../cassette/burn';
import { currentVersion, useDeliverConfirm } from '../cassette';

const notify = (e: unknown) => useStore.getState().notify((e as Error).message);
const run = (m: string, a: Record<string, unknown> = {}) => Promise.resolve(runCommand(m, a, 'ui'));
interface Row {
  id: string;
  series: string;
  edition: number;
  title: string;
  bytes: number;
  sides: { name: string; tracks: string[] }[];
}
type Pending = { versionId: string; title: string };

export function CassettesPanel() {
  const t = useT();
  const [list, setList] = useState<Row[]>([]);
  const [sideA, setA] = useState<Pending[]>([]);
  const [sideB, setB] = useState<Pending[]>([]);
  const [title, setTitle] = useState('');
  const [dedication, setDedication] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState('');
  const step = useBurn((s) => s.step);
  const opus = useBurn((s) => s.warning === 'opus');
  const ask = useDeliverConfirm((s) => s.ask);
  const song = useStore((s) => s.project.name);
  const refresh = () => void run('list_cassettes').then((r) => setList(r as Row[])).catch(notify);
  useEffect(refresh, []);
  const add = async (to: typeof setA) => {
    const versionId = await currentVersion();
    to((x) => [...x, { versionId, title: song }]);
  };
  const burnIt = async () => {
    const sides = [
      { name: 'A', tracks: sideA },
      { name: 'B', tracks: sideB },
    ].filter((s) => s.tracks.length);
    await run('create_cassette', { title, dedication: dedication || undefined, sides });
    setA([]);
    setB([]);
    refresh();
  };
  const deliver = (series: string, mode: 'file' | 'static') => {
    setResult('');
    void run('deliver_cassette', { series, mode, password: password || undefined })
      .then((r) => setResult(JSON.stringify(r)))
      .catch(notify);
  };
  return (
    <div className="pj-panel">
      <section className="pj-link">
        <h4>{t('ca2.burn')}</h4>
        <input className="pj-input" aria-label={t('ca2.title')} placeholder={t('ca2.title')} value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="pj-input" aria-label={t('ca2.dedication')} placeholder={t('ca2.dedication')} value={dedication} onChange={(e) => setDedication(e.target.value)} />
        <div className="pj-actions">
          <button className="btn" onClick={() => void add(setA).catch(notify)}>{t('ca2.addA', { song })}</button>
          <button className="btn" onClick={() => void add(setB).catch(notify)}>{t('ca2.addB')}</button>
        </div>
        <p className="pj-meta">
          A: {sideA.map((x) => x.title).join(', ') || '–'} · B: {sideB.map((x) => x.title).join(', ') || '–'}
        </p>
        {opus && <p className="pj-alert">{t('ca2.opus')}</p>}
        <button className="btn" disabled={!title.trim() || !(sideA.length + sideB.length) || !!step} onClick={() => void burnIt().catch(notify)}>
          {step ? t('ca2.burning', { step }) : t('ca2.go')}
        </button>
      </section>
      <section style={{ gridColumn: 'span 2' }}>
        <h4>{t('ca2.yours')}</h4>
        {ask && (
          <div className="pj-alert" role="alertdialog">
            <p>{t('ca2.confirm', { title: ask.title })}</p>
            <button className="btn" onClick={() => ask.resolve(true)}>{t('ca2.give')}</button>
            <button className="btn" onClick={() => ask.resolve(false)}>{t('pr.cancel')}</button>
          </div>
        )}
        <input className="pj-input" type="password" aria-label={t('ca2.password')} placeholder={t('ca2.password')} value={password} onChange={(e) => setPassword(e.target.value)} />
        {list.map((c) => (
          <div className="pj-row" key={c.id}>
            <div className="pj-name">
              <b>{c.title}</b>
              <span className="pj-badge">{t('ca2.print', { n: c.edition })}</span>
            </div>
            <div className="pj-meta">{c.sides.map((s) => `${s.name}: ${s.tracks.join(', ')}`).join(' · ')} · {Math.round(c.bytes / 1e6)} MB</div>
            <div className="pj-actions">
              <button className="btn" onClick={() => deliver(c.series, 'file')}>{t('ca2.file')}</button>
              <button className="btn" onClick={() => deliver(c.series, 'static')}>{t('ca2.folder')}</button>
              <button className="btn" onClick={() => void run('new_edition', { series: c.series }).then(refresh).catch(notify)}>{t('ca2.reprint')}</button>
            </div>
          </div>
        ))}
        {!list.length && <p className="pj-meta">{t('ca2.none')}</p>}
        {result && <p className="pj-meta">{result}</p>}
        <p className="pj-meta">{t('ca2.iphone')}</p>
      </section>
    </div>
  );
}
