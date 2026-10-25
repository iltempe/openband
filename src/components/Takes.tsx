// Takes: badge on regions, the takes/comping dialog and the blind A/B overlay.
import { useState } from 'react';
import { create } from 'zustand';
import type { Region, Take } from '../types';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { cancelABTest, choose, dismissAB, finishABTest, useAB } from '../abtest';
import { useT } from '../i18n';
import * as I from './Icons';
import { takeOf } from '../flubs';

export const useTakesUI = create<{ regionId: string | null }>(() => ({ regionId: null }));

const run = (m: string, a: Record<string, unknown>) => runCommand(m, a, 'ui').catch((e) => useStore.getState().notify((e as Error).message));

export function TakesBadge({ region }: { region: Region }) {
  const t = useT();
  const n = region.takes?.length ?? 0;
  if (n < 2) return null;
  return (
    <button
      className="take-badge"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        useTakesUI.setState({ regionId: region.id });
      }}
      title={t('take.open')}
    >
      {t('take.badge', { n })}
    </button>
  );
}

/** Notes of a take as a mini piano roll. */
function Mini({ take, length }: { take: Take; length: number }) {
  const ps = take.notes.map((n) => n.pitch);
  const lo = Math.min(...ps, 60) - 1;
  const hi = Math.max(...ps, 60) + 1;
  return (
    <svg className="take-mini" viewBox={`0 0 ${length} 100`} preserveAspectRatio="none">
      {take.notes.map((n) => (
        <rect key={n.id} x={n.start} width={Math.max(0.06, n.duration)} y={100 - ((n.pitch - lo + 1) / (hi - lo + 1)) * 100} height={Math.max(4, 100 / (hi - lo + 1))} rx={0.05} />
      ))}
    </svg>
  );
}

interface Seg {
  from: number;
  to: number;
  takeId: string;
}

export function TakesDialog() {
  const regionId = useTakesUI((s) => s.regionId);
  const region = useStore((s) => s.project.regions.find((r) => r.id === regionId));
  const allFlubs = useStore((s) => s.project.flubs);
  const [segs, setSegs] = useState<Seg[]>([]);
  const [pick, setPick] = useState<string[]>([]);
  const t = useT();
  if (!region?.takes?.length) return null;
  const takes = region.takes;
  const close = () => (useTakesUI.setState({ regionId: null }), setSegs([]), setPick([]));

  // Drag on a take row to give that stretch of the region to that take (whole beats).
  const startComp = (e: React.PointerEvent<HTMLDivElement>, takeId: string) => {
    if (region.audio) return;
    const box = e.currentTarget.getBoundingClientRect();
    const beatAt = (x: number) => Math.max(0, Math.min(region.length, Math.round(((x - box.left) / box.width) * region.length)));
    const a = beatAt(e.clientX);
    const apply = (x: number) => {
      const b = beatAt(x);
      const from = Math.min(a, b);
      const to = Math.max(a, b) === from ? from + 1 : Math.max(a, b);
      setSegs((prev) => {
        // The new segment replaces whatever it covers.
        const rest = prev.flatMap((s) => (s.to <= from || s.from >= to ? [s] : [...(s.from < from ? [{ ...s, to: from }] : []), ...(s.to > to ? [{ ...s, from: to }] : [])]));
        return [...rest, { from, to: Math.min(region.length, to), takeId }].sort((x, y) => x.from - y.from);
      });
    };
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up));
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const flubs = (allFlubs ?? []).filter((f) => f.regionId === region.id);
  const colorOf = (id: string) => `hsl(${(takes.findIndex((x) => x.id === id) * 67 + 200) % 360} 70% 60%)`;

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal takes-modal">
        <div className="modal-head">
          <div>
            <div className="lib-title">{t('take.title', { name: region.name })}</div>
            <div className="lib-sub">{region.audio ? t('take.subAudio') : t('take.sub')}</div>
          </div>
          <button className="icon-btn" onClick={close}>
            <I.Close />
          </button>
        </div>
        <div className="takes-list">
          {takes.map((tk) => (
            <div key={tk.id} className={`take-row ${tk.id === region.activeTakeId ? 'active' : ''}`}>
              <label className="take-pick" title={t('take.pickHint')}>
                <input
                  type="checkbox"
                  checked={pick.includes(tk.id)}
                  disabled={!pick.includes(tk.id) && pick.length >= 4}
                  onChange={(e) => setPick((p) => (e.target.checked ? [...p, tk.id] : p.filter((x) => x !== tk.id)))}
                />
              </label>
              <button className="take-name" onClick={() => run('set_active_take', { region_id: region.id, take_id: tk.id })} title={t('take.use')}>
                <span className="take-dot" style={{ background: colorOf(tk.id) }} />
                {tk.name}
                <small>{tk.author === 'ai' ? 'AI' : ''}</small>
                {tk.score !== undefined && (
                  <span className={`take-score ${tk.score >= 80 ? 'good' : tk.score >= 60 ? 'ok' : 'low'}`} title={t('take.scoreHint')}>
                    {tk.score}
                  </span>
                )}
              </button>
              <div className="take-lane" onPointerDown={(e) => startComp(e, tk.id)}>
                {!tk.audio && <Mini take={tk} length={region.length} />}
                {flubs
                  .filter((f) => takeOf(f, region) === tk.id)
                  .map((f) => (
                    <span key={f.id} className={`take-flag ${f.kind} ${f.resolved ? 'resolved' : ''}`} style={{ left: `${((f.beat - region.start) / region.length) * 100}%` }} />
                  ))}
                {segs
                  .filter((s) => s.takeId === tk.id)
                  .map((s, i) => (
                    <div key={i} className="take-seg" style={{ left: `${(s.from / region.length) * 100}%`, width: `${((s.to - s.from) / region.length) * 100}%`, borderColor: colorOf(tk.id) }} />
                  ))}
              </div>
              <button className="mini" disabled={takes.length < 2} onClick={() => run('delete_take', { region_id: region.id, take_id: tk.id })} title={t('take.delete')}>
                <I.Trash width={13} height={13} />
              </button>
            </div>
          ))}
        </div>
        {!region.audio && (
          <div className="comp-strip">
            {segs.map((s, i) => (
              <div key={i} style={{ left: `${(s.from / region.length) * 100}%`, width: `${((s.to - s.from) / region.length) * 100}%`, background: colorOf(s.takeId) }} />
            ))}
          </div>
        )}
        <div className="takes-foot">
          <button
            className="btn"
            disabled={!segs.length}
            onClick={() => {
              void run('comp_takes', { region_id: region.id, segments: segs.map((s) => ({ from_beat: s.from, to_beat: s.to, take_id: s.takeId })) });
              setSegs([]);
            }}
          >
            {t('take.comp')}
          </button>
          {!!segs.length && (
            <button className="btn" onClick={() => setSegs([])}>
              {t('take.clearComp')}
            </button>
          )}
          <span className="takes-spacer" />
          <button
            className="btn primary"
            disabled={region.audio !== undefined || (pick.length ? pick.length < 2 : takes.length < 2)}
            onClick={() => {
              const ids = pick.length ? pick : takes.slice(-4).map((x) => x.id);
              close();
              void run('start_ab_test', { region_id: region.id, take_ids: ids });
            }}
          >
            {t('take.blind')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ABOverlay() {
  const { testId, letters, current, revealed } = useAB();
  const [rank, setRank] = useState<string[]>([]);
  const t = useT();
  if (!testId) return null;
  if (revealed) {
    const best = revealed[0];
    const regionId = useStore.getState().project.regions.find((r) => r.takes?.some((x) => x.id === best?.take_id))?.id;
    return (
      <div className="ab-overlay">
        <div className="ab-title">{t('ab.revealed')}</div>
        <ol className="ab-reveal">
          {revealed.map((r) => (
            <li key={r.letter}>
              <b>{r.letter}</b> = {r.name}
            </li>
          ))}
        </ol>
        <div className="ab-actions">
          <button className="btn" onClick={() => (setRank([]), dismissAB())}>
            {t('ab.close')}
          </button>
          {best && regionId && (
            <button className="btn primary" onClick={() => (setRank([]), dismissAB(), void run('set_active_take', { region_id: regionId, take_id: best.take_id }))}>
              {t('ab.useBest', { name: best.name })}
            </button>
          )}
        </div>
      </div>
    );
  }
  const toggleRank = (l: string) => setRank((r) => (r.includes(l) ? r.filter((x) => x !== l) : [...r, l]));
  return (
    <div className="ab-overlay">
      <div className="ab-title">{t('ab.title')}</div>
      <div className="ab-sub">{t('ab.sub')}</div>
      <div className="ab-letters">
        {letters.map((l) => (
          <button key={l} className={`ab-letter ${current === l ? 'on' : ''}`} onClick={() => choose(l)}>
            {l}
            {rank.includes(l) && <span className="ab-rank">{rank.indexOf(l) + 1}</span>}
          </button>
        ))}
      </div>
      <div className="ab-sub">{t('ab.rankHint')}</div>
      <div className="ab-letters small">
        {letters.map((l) => (
          <button key={l} className={`ab-rank-btn ${rank.includes(l) ? 'on' : ''}`} onClick={() => toggleRank(l)}>
            {rank.includes(l) ? `${rank.indexOf(l) + 1}. ${l}` : `+ ${l}`}
          </button>
        ))}
      </div>
      <div className="ab-actions">
        <button className="btn" onClick={() => (setRank([]), cancelABTest())}>
          {t('ab.cancel')}
        </button>
        <button className="btn primary" disabled={!rank.length} onClick={() => finishABTest(rank.length === letters.length - 1 ? [...rank, letters.find((l) => !rank.includes(l))!] : rank)}>
          {t('ab.confirm')}
        </button>
      </div>
    </div>
  );
}
