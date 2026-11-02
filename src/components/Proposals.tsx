// Proposals panel (C1.4): what changes, listening, comments on bars, checks, the verdict and the merge.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { engine } from '../audio/engine';
import { BEATS_PER_BAR } from '../music';
import { startCompare, stopCompare } from '../versioning';
import { proposalChanges, useMergeConfirm } from '../proposals';
import { startBlind, startChanges, startToggle, stopListening, switchSide, useListening, voteMeaning } from '../proposals/listen';
import type { Proposal } from '../proposals/model';

const notify = (e: unknown) => useStore.getState().notify((e as Error).message);
const run = (m: string, a: Record<string, unknown> = {}) => Promise.resolve(runCommand(m, a, 'ui'));
type Changes = Awaited<ReturnType<typeof proposalChanges>>;

function Detail({ x }: { x: Proposal }) {
  const t = useT();
  const [c, setC] = useState<Changes | null>(null);
  const [at, setAt] = useState(0);
  const [comment, setComment] = useState('');
  const listening = useListening();
  const notes = useStore((s) => s.project.annotations)?.filter((a) => a.proposalId === x.id) ?? [];
  useEffect(() => {
    let live = true;
    void proposalChanges(x).then((r) => live && setC(r)).catch(notify);
    void startCompare(x.headVersionId).catch(notify);
    return () => {
      live = false;
      stopCompare();
      stopListening();
    };
  }, [x.headVersionId]);
  if (!c) return <p className="pj-meta">{t('pr.loading')}</p>;
  const bars = c.bars;
  const here = bars[Math.min(at, bars.length - 1)] ?? null;
  const go = (i: number) => {
    const next = (i + bars.length) % bars.length;
    setAt(next);
    engine.position = (bars[next].from - 1) * BEATS_PER_BAR;
  };
  const changed = new Set([...c.diff.regions.changed.map((r) => r.track_id), ...c.diff.regions.added.map((r) => r.trackId), ...c.diff.tracks.added.map((r) => r.id)]);
  const open = x.status === 'open';
  const vote = async (pick: 'a' | 'b') => {
    const which = voteMeaning(pick, listening.aIs);
    useListening.setState({ voted: which });
    stopListening();
    await run('review_proposal', { number: x.number, verdict: 'comment', text: t(which === 'head' ? 'pr.preferHead' : 'pr.preferBase') }).catch(notify);
  };
  const fails = x.checks?.tests?.results.filter((r) => !r.pass).length ?? 0;
  const passes = x.checks?.tests?.results.filter((r) => r.pass && !r.skipped).length ?? 0;
  return (
    <div className="pr-detail">
      <h4>
        #{x.number} {x.title}
      </h4>
      {x.description && <p className="pj-meta">{x.description}</p>}
      <ul className="pr-summary">
        {c.summary.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {x.checks && (
        <p className={fails ? 'pj-alert' : 'pj-meta'}>
          {t('pr.checks', { pass: passes, fail: fails })}
          {x.checks.lint && ` · ${t('pr.lint', { n: x.checks.lint.added })}`}
        </p>
      )}
      {!!bars.length && (
        <div className="pj-actions">
          <button className="btn" onClick={() => go(at - 1)}>
            ‹
          </button>
          <span className="pj-meta">{t('pr.bars', { from: here!.from, to: here!.to, i: at + 1, n: bars.length })}</span>
          <button className="btn" onClick={() => go(at + 1)}>
            ›
          </button>
        </div>
      )}
      <div className="pj-actions">
        {listening.mode ? (
          <>
            {listening.mode === 'ab' && (
              <>
                <button className="btn" aria-pressed={listening.side === 'a'} onClick={() => switchSide('a')}>A</button>
                <button className="btn" aria-pressed={listening.side === 'b'} onClick={() => switchSide('b')}>B</button>
                <button className="btn" onClick={() => void vote('a')}>{t('pr.preferA')}</button>
                <button className="btn" onClick={() => void vote('b')}>{t('pr.preferB')}</button>
              </>
            )}
            {listening.mode !== 'ab' && (
              <button className="btn" onClick={() => switchSide(listening.side === 'a' ? 'b' : 'a')}>
                {t(listening.side === 'a' ? 'pr.onBase' : 'pr.onHead')}
              </button>
            )}
            <button className="btn" onClick={stopListening}>{t('pr.stop')}</button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => void startBlind(c.base, c.head, here).catch(notify)}>{t('pr.blind')}</button>
            <button className="btn" disabled={!here} onClick={() => void startChanges(c.base, c.head, here!, changed).catch(notify)}>{t('pr.onlyChanges')}</button>
            <button className="btn" onClick={() => void startToggle(c.base, c.head, here).catch(notify)}>{t('pr.toggle')}</button>
          </>
        )}
      </div>
      <div className="pr-thread">
        {notes.map((n) => (
          <p key={n.id} className="pj-meta">
            <b>{n.author.name}</b> ({t('pr.bar')} {n.target.from_beat !== undefined ? Math.floor(n.target.from_beat / BEATS_PER_BAR) + 1 : '–'}): {n.text}
          </p>
        ))}
        {x.reviews?.map((r) => (
          <p key={r.at} className="pj-meta">
            <b>{r.by.name}</b>: {t(`pr.verdict.${r.verdict}` as never)}
            {r.text ? ` · ${r.text}` : ''}
          </p>
        ))}
        <form
          className="st-add"
          onSubmit={(e) => {
            e.preventDefault();
            void run('comment_proposal', { number: x.number, text: comment, bar_from: here?.from, bar_to: here?.to }).then(() => setComment('')).catch(notify);
          }}
        >
          <input className="pj-input" aria-label={t('pr.comment')} placeholder={here ? t('pr.commentOn', { bar: here.from }) : t('pr.comment')} value={comment} onChange={(e) => setComment(e.target.value)} />
          <button className="btn" disabled={!comment.trim()}>{t('pr.send')}</button>
        </form>
      </div>
      {open && (
        <div className="pj-actions">
          <button className="btn" onClick={() => void run('review_proposal', { number: x.number, verdict: 'approve' }).catch(notify)}>{t('pr.approve')}</button>
          <button className="btn" onClick={() => void run('review_proposal', { number: x.number, verdict: 'changes' }).catch(notify)}>{t('pr.changes')}</button>
          <button className="btn pr-merge" onClick={() => void run('merge_proposal', { number: x.number }).catch(notify)}>{t('pr.merge')}</button>
          <button className="btn" onClick={() => void run('close_proposal', { number: x.number }).catch(notify)}>{t('pr.close')}</button>
          <button className="btn" onClick={() => void run('export_proposal', { number: x.number }).catch(notify)}>{t('pr.export')}</button>
        </div>
      )}
    </div>
  );
}

export function ProposalsPanel() {
  const t = useT();
  const proposals = useStore((s) => s.project.proposals) ?? [];
  const forkOf = useStore((s) => s.project.meta?.forkOf);
  const [selected, setSelected] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const ask = useMergeConfirm((s) => s.ask);
  const file = useRef<HTMLInputElement>(null);
  const x = proposals.find((y) => y.number === selected);
  const pick = async (f: File) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await run('import_proposal', { base64: btoa(s) });
  };
  return (
    <div className="pj-panel">
      <section className="pj-link">
        <h4>{t('pr.tab')}</h4>
        {forkOf && <p className="pj-meta">{t('pr.forkOf', { name: forkOf.name })}</p>}
        <form
          className="st-add"
          onSubmit={(e) => {
            e.preventDefault();
            void run('create_proposal', { title }).then(() => setTitle('')).catch(notify);
          }}
        >
          <input className="pj-input" aria-label={t('pr.what')} placeholder={t('pr.what')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <button className="btn" disabled={!title.trim()}>{t('pr.propose')}</button>
        </form>
        <div className="pj-actions">
          <button className="btn" onClick={() => void run('fork_project').catch(notify)}>{t('pr.fork')}</button>
          <button className="btn" onClick={() => file.current?.click()}>{t('pr.import')}</button>
          <input ref={file} type="file" accept=".openband-pr" hidden onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0]).catch(notify)} />
        </div>
        {proposals.map((p) => (
          <button key={p.id} className={`pr-row ${p.number === selected ? 'on' : ''}`} onClick={() => setSelected(p.number)}>
            #{p.number} {p.title} <span className="pj-badge">{t(`pr.status.${p.status}` as never)}</span>
          </button>
        ))}
        {!proposals.length && <p className="pj-meta">{t('pr.none')}</p>}
      </section>
      <section style={{ gridColumn: 'span 2' }}>
        {ask && (
          <div className="pj-alert" role="alertdialog">
            <p>{t('pr.confirm', { n: ask.number, title: ask.title })}</p>
            <button className="btn" onClick={() => ask.resolve(true)}>{t('pr.merge')}</button>
            <button className="btn" onClick={() => ask.resolve(false)}>{t('pr.cancel')}</button>
          </div>
        )}
        {x ? <Detail key={x.id} x={x} /> : <p className="pj-meta">{t('pr.pick')}</p>}
      </section>
    </div>
  );
}
