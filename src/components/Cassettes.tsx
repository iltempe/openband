// Cassettes panel (D1.4): burn a tape from your songs, and give it away.
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { useBurn } from '../cassette/burn';
import { currentVersion, useDeliverConfirm } from '../cassette';
import { decide, heatmap, intake, listenForReturns, refreshReturns, useReturns } from '../cassette/returns';

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
  useEffect(() => {
    void refreshReturns();
    void listenForReturns();
  }, []);
  const returns = useReturns((x) => x.list);
  const byTrack = [...new Map(returns.map((r) => [r.trackId, r.trackTitle])).entries()];
  const readReturn = (f: File) => void f.text().then(intake).catch(notify);
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
        <h4>{t('ca2.returns')}</h4>
        <label className="btn">
          {t('ca2.openReturn')}
          <input type="file" accept=".risposta" hidden onChange={(e) => e.target.files?.[0] && readReturn(e.target.files[0])} />
        </label>
        {byTrack.map(([id, title]) => {
          const these = returns.filter((r) => r.trackId === id);
          const { hot } = heatmap(these, Math.max(1, ...these.flatMap((r) => r.items.map((i) => ('t' in i ? i.t : 0)))) * 1.05);
          const most = Math.max(1, ...hot);
          return (
            <div className="pj-row" key={id}>
              <b>{title}</b>
              <div className="ret-heat" role="img" aria-label={t('ca2.heat')}>
                {hot.map((v, i) => (
                  <span key={i} style={{ opacity: 0.12 + (0.88 * v) / most }} />
                ))}
              </div>
              {these.map((r) => (
                <div key={r.id} className="pj-meta">
                  <b>{r.from}</b>
                  {r.via ? ` (via ${r.via})` : ''}: {r.items.map((i) => ('label' in i ? i.label : 'text' in i ? i.text : i.kind === 'voice' ? '🎙' : '')).join(' ')}
                  {r.pending && (
                    <span className="pj-alert">
                      {' '}{t('ca2.newDevice', { name: r.from })}{' '}
                      <button className="btn" onClick={() => void decide(r.id, true)}>{t('ca2.accept')}</button>
                      <button className="btn" onClick={() => void decide(r.id, false)}>{t('ca2.refuse')}</button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </section>
    </div>
  );
}
