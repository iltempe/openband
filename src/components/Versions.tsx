// Versions panel: branch graph, save/branch/checkout, compare view, A/B listening and merge.
import { applyRecovery, dismissRecovery, previewInCompare, restoreAt, useJournal } from '../journal';
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { engine } from '../audio/engine';
import { renderBuffer } from '../audio/render';
import { refreshReferencePlayer } from '../reference';
import { startCompare, stopCompare, useVersions, type VersionMeta } from '../versioning';
import type { Conflict } from '../versions/merge';
import { useT } from '../i18n';

const ROW = 34;
const LANE = 16;
const COLORS = ['#a78bfa', '#34d399', '#f59e0b', '#60a5fa', '#f472b6', '#22d3ee', '#facc15'];
const notify = (e: unknown) => useStore.getState().notify((e as Error).message);
const run = <T,>(m: string, a: Record<string, unknown>) => runCommand(m, a, 'ui') as Promise<T>;

/** Lanes per branch (main first), rows newest first, lines to parents. */
function Graph({ versions, laneOf }: { versions: VersionMeta[]; laneOf: (b: string) => number }) {
  const rowOf = new Map(versions.map((v, i) => [v.id, i]));
  const x = (b: string) => 8 + laneOf(b) * LANE;
  const y = (i: number) => i * ROW + ROW / 2;
  const lanes = Math.max(1, ...versions.map((v) => laneOf(v.branch) + 1));
  return (
    <svg className="ver-svg" width={lanes * LANE + 8} height={versions.length * ROW} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
      {versions.flatMap((v, i) =>
        v.parentIds
          .filter((p) => rowOf.has(p))
          .map((p) => {
            const j = rowOf.get(p)!;
            const parent = versions[j];
            const x1 = x(v.branch);
            const x2 = x(parent.branch);
            const mid = (y(i) + y(j)) / 2;
            return <path key={`${v.id}-${p}`} d={`M${x1},${y(i)} C${x1},${mid} ${x2},${mid} ${x2},${y(j)}`} stroke={COLORS[laneOf(v.branch) % COLORS.length]} strokeWidth={2} fill="none" opacity={0.8} />;
          }),
      )}
      {versions.map((v, i) => (
        <circle key={v.id} cx={x(v.branch)} cy={y(i)} r={5} fill={COLORS[laneOf(v.branch) % COLORS.length]} stroke="#0c0d11" strokeWidth={2} />
      ))}
    </svg>
  );
}

export function VersionsPanel() {
  const { versions, branches, branch, headId, compare } = useVersions();
  const project = useStore((s) => s.project);
  const [label, setLabel] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [summary, setSummary] = useState<string[] | null>(null);
  const [mergeFrom, setMergeFrom] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [listening, setListening] = useState<'off' | 'loading' | 'a' | 'b'>('off');
  const t = useT();

  const order = ['main', ...branches.map((b) => b.name).filter((n) => n !== 'main')];
  const laneOf = (b: string) => Math.max(0, order.indexOf(b));
  const rows = [...versions].reverse();
  const selected = versions.find((v) => v.id === sel) ?? null;
  const others = branches.filter((b) => b.name !== branch);

  useEffect(() => {
    if (!sel) return setSummary(null);
    runCommand('diff_versions', { a: sel }, 'ui')
      .then((d) => setSummary((d as { summary: string[] }).summary))
      .catch(() => setSummary(null));
  }, [sel, project]);

  // Leaving the panel ends listening (the compare view stays, so the piano roll can show it too).
  useEffect(
    () => () => {
      engine.listenReference(false);
      refreshReferencePlayer();
    },
    [],
  );

  const listen = async (which: 'a' | 'b') => {
    if (!compare) return;
    if (listening === 'off') {
      setListening('loading');
      try {
        engine.setReference(await renderBuffer(compare.snapshot, { tailSeconds: 1 }));
        engine.setReferenceGain(1);
      } catch (e) {
        setListening('off');
        return notify(e);
      }
    }
    engine.listenReference(which === 'b');
    setListening(which);
  };
  const stopListening = () => {
    engine.listenReference(false);
    refreshReferencePlayer();
    setListening('off');
  };

  const doMerge = async (picks: { entity: string; id: string; from: 'a' | 'b' }[] = []) => {
    try {
      const r = await run<{ conflicts: Conflict[]; version_id?: string }>('merge', { from_branch: mergeFrom || others[0]?.name, strategy: 'manual', pick: picks });
      setConflicts(r.conflicts);
      useStore.getState().notify(r.conflicts.length ? t('ver.conflicts', { n: r.conflicts.length }) : t('ver.merged'));
    } catch (e) {
      notify(e);
    }
  };

  return (
    <div className="versions">
      <div className="analysis-bar">
        <span className="ver-chip" style={{ background: COLORS[laneOf(branch) % COLORS.length] }}>
          {branch}
        </span>
        <form
          className="ver-actions"
          style={{ flex: 1 }}
          onSubmit={(e) => {
            e.preventDefault();
            run('save_version', { label: label.trim() })
              .then(() => setLabel(''))
              .catch(notify);
          }}
        >
          <input className="ver-input" value={label} placeholder={t('ver.labelPh')} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn primary" type="submit">
            {t('ver.save')}
          </button>
        </form>
        <form
          className="ver-actions"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newBranch.trim();
            if (!name) return;
            run('create_branch', { name, from_version_id: sel ?? undefined })
              .then(() => run('checkout', { branch: name }))
              .then(() => setNewBranch(''))
              .catch(notify);
          }}
        >
          <input className="ver-input" value={newBranch} placeholder={t('ver.branchPh')} onChange={(e) => setNewBranch(e.target.value)} />
          <button className="btn" type="submit" title={t('ver.branchHint')}>
            {t('ver.branch')}
          </button>
        </form>
      </div>
      <div className="ver-body">
        <div className="ver-graph">
          {!rows.length && <div className="panel-empty"><p>{t('ver.empty')}</p></div>}
          <div style={{ position: 'relative' }}>
            <Graph versions={rows} laneOf={laneOf} />
            {rows.map((v) => (
              <div key={v.id} className={`ver-row ${sel === v.id ? 'selected' : ''}`} style={{ paddingLeft: Math.max(1, ...rows.map((r) => laneOf(r.branch) + 1)) * LANE + 16 }} onClick={() => setSel(sel === v.id ? null : v.id)}>
                <span className="ver-label">{v.label}</span>
                {v.id === headId && <span className="ver-head">HEAD</span>}
                {branches.filter((b) => b.headId === v.id).map((b) => (
                  <span key={b.name} className="ver-chip" style={{ background: COLORS[laneOf(b.name) % COLORS.length] }}>
                    {b.name}
                  </span>
                ))}
                <span className="ver-meta">
                  {v.author === 'ai' ? 'AI · ' : ''}
                  {new Date(v.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="ver-side">
          {selected ? (
            <>
              <div className="an-title">{t('ver.vsNow', { label: selected.label })}</div>
              {summary && (summary.length ? <ul className="ver-summary">{summary.map((s, i) => <li key={i}>{s}</li>)}</ul> : <div className="ver-meta">{t('ver.identical')}</div>)}
              <div className="ver-actions">
                <button className={`btn ${compare?.versionId === selected.id ? 'primary' : ''}`} onClick={() => (compare?.versionId === selected.id ? (stopListening(), stopCompare()) : void startCompare(selected.id).catch(notify))}>
                  {compare?.versionId === selected.id ? t('ver.stopCompare') : t('ver.compare')}
                </button>
                <button className="btn" onClick={() => (stopListening(), run('checkout', { version_id: selected.id }).catch(notify))}>
                  {t('ver.checkout')}
                </button>
              </div>
              {compare?.versionId === selected.id && (
                <>
                  <div className="ver-legend">
                    <span><i style={{ background: '#22c55e' }} />{t('ver.added')}</span>
                    <span><i style={{ background: '#facc15' }} />{t('ver.changed')}</span>
                    <span><i style={{ background: '#ef4444' }} />{t('ver.removed')}</span>
                  </div>
                  <div className="ref-ab" title={t('ver.listenHint')}>
                    <button className={listening === 'a' ? 'on' : ''} onClick={() => void listen('a')}>
                      A
                    </button>
                    <button className={listening === 'b' ? 'on' : ''} onClick={() => void listen('b')} disabled={listening === 'loading'}>
                      {listening === 'loading' ? '…' : 'B'}
                    </button>
                  </div>
                  <div className="ver-meta">{t('ver.listenHint')}</div>
                </>
              )}
            </>
          ) : (
            <div className="ver-meta">{t('ver.pick')}</div>
          )}
          <TimeMachine
            listening={listening}
            onListen={listen}
            onStop={() => {
              stopListening();
              stopCompare();
            }}
          />
          {others.length > 0 && (
            <>
              <div className="an-title">{t('ver.merge')}</div>
              <div className="ver-actions">
                <select className="ver-input" value={mergeFrom || others[0].name} onChange={(e) => setMergeFrom(e.target.value)}>
                  {others.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <button className="btn" onClick={() => void doMerge()}>
                  {t('ver.mergeInto', { branch })}
                </button>
              </div>
              {conflicts.map((c) => (
                <div key={`${c.entity}:${c.id}:${c.field ?? ''}`} className="ver-conflict">
                  <b>{c.entity}</b> {c.name ?? c.id}
                  {c.field ? ` · ${c.field}` : ''}
                  <div className="ver-actions" style={{ marginTop: 4 }}>
                    <button className="mini" onClick={() => void doMerge([{ entity: c.entity, id: c.field && c.entity === 'track' ? `${c.id}.${c.field}` : c.id, from: 'a' }])}>
                      {t('ver.keepOurs')}
                    </button>
                    <button className="mini" onClick={() => void doMerge([{ entity: c.entity, id: c.field && c.entity === 'track' ? `${c.id}.${c.field}` : c.id, from: 'b' }])}>
                      {t('ver.takeTheirs', { branch: mergeFrom || others[0].name })}
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ago(ms: number, t: ReturnType<typeof useT>) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 30) return t('jr.now');
  const txt = s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86400)} d`;
  return t('jr.ago', { t: txt });
}

/** F21: a slider over everything journaled for this song; preview a moment, listen A/B, restore it or branch from it. */
function TimeMachine({ listening, onListen, onStop }: { listening: string; onListen: (w: 'a' | 'b') => void; onStop: () => void }) {
  const t = useT();
  const { first, last } = useJournal();
  const compare = useVersions((v) => v.compare);
  const [at, setAt] = useState<number | null>(null);
  const previewing = compare?.versionId.startsWith('time:');
  if (!first || !last) return <div className="ver-meta">{t('jr.empty')}</div>;
  const value = at ?? last;
  return (
    <div className="time-machine">
      <div className="an-title">{t('jr.machine')}</div>
      <div className="ver-meta">{t('jr.machineSub')}</div>
      <input type="range" min={first} max={last} step={1000} value={value} onChange={(e) => setAt(Number(e.target.value))} aria-label={t('jr.machine')} />
      <div className="tm-when">
        {new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })} · {ago(value, t)}
      </div>
      <div className="ver-actions">
        <button className={`btn ${previewing ? 'primary' : ''}`} onClick={() => (previewing ? onStop() : void previewInCompare(value).catch(notify))}>
          {previewing ? t('ver.stopCompare') : t('jr.preview')}
        </button>
        <button className="btn" onClick={() => (onStop(), void restoreAt(value).catch(notify))}>
          {t('jr.restoreHere')}
        </button>
        <button className="btn" onClick={() => (onStop(), void restoreAt(value, true).catch(notify))}>
          {t('jr.branchHere')}
        </button>
      </div>
      {previewing && (
        <div className="ref-ab" title={t('ver.listenHint')}>
          <button className={listening === 'a' ? 'on' : ''} onClick={() => onListen('a')}>
            A
          </button>
          <button className={listening === 'b' ? 'on' : ''} onClick={() => onListen('b')} disabled={listening === 'loading'}>
            {listening === 'loading' ? '…' : 'B'}
          </button>
        </div>
      )}
    </div>
  );
}

/** The journal holds work the autosave missed (a crash, a full disk): offer it back. */
export function RecoveryBanner() {
  const r = useJournal((s) => s.recovery);
  const t = useT();
  if (!r) return null;
  return (
    <div className="mic-overlay ver-banner recovery-banner" role="alert">
      <span className="mic-dot" style={{ background: '#22c55e' }} />
      <span className="mic-status">{r.count === 1 ? t('jr.banner1') : t('jr.banner', { n: r.count })}</span>
      <button className="btn primary" onClick={applyRecovery}>
        {t('jr.restore')}
      </button>
      <button className="btn" onClick={dismissRecovery}>
        {t('jr.ignore')}
      </button>
    </div>
  );
}

/** While comparing, a pill reminds what the colours mean and how to stop. */
export function CompareBanner() {
  const compare = useVersions((v) => v.compare);
  const open = useStore((s) => s.bottom === 'versions');
  const t = useT();
  if (!compare || open) return null;
  return (
    <div className="mic-overlay ver-banner">
      <span className="mic-dot" style={{ background: '#facc15' }} />
      <span className="mic-status">{t('ver.comparing', { label: compare.label })}</span>
      <button className="btn" onClick={() => useStore.getState().set({ bottom: 'versions' })}>
        {t('ver.tab')}
      </button>
      <button className="btn" onClick={stopCompare}>
        {t('ver.stopCompare')}
      </button>
    </div>
  );
}
