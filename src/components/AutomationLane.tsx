// Automation lane shown under a track: draw and edit a curve for one mix parameter.
import { useRef, type CSSProperties } from 'react';
import type { AutoParam, AutoPoint, Track } from '../types';
import { useStore } from '../store';
import { AUTO_PARAMS, autoParam, sortPoints } from '../automation';
import { BEATS_PER_BAR, clamp } from '../music';
import { useT, type MessageKey } from '../i18n';
import * as I from './Icons';

export const AUTO_H = 68;
const PAD = 6;

export function AutomationLane({ track }: { track: Track }) {
  const param = useStore((s) => s.automationLanes[track.id]);
  const zoom = useStore((s) => s.zoom);
  const set = useStore((s) => s.set);
  const commit = useStore((s) => s.commit);
  const svgRef = useRef<SVGSVGElement>(null);
  const t = useT();
  if (!param) return null;
  const info = autoParam(param);
  const points = track.automation?.[param] ?? [];
  const h = AUTO_H - 1;
  const yOf = (v: number) => PAD + (1 - (v - info.min) / (info.max - info.min)) * (h - PAD * 2);
  const vOf = (y: number) => clamp(info.min + (1 - (y - PAD) / (h - PAD * 2)) * (info.max - info.min), info.min, info.max);
  const snap = zoom >= 22 ? 0.25 : 1;

  const mutate = (fn: (pts: AutoPoint[]) => void, history = false) =>
    commit((d) => {
      const tr = d.tracks.find((x) => x.id === track.id)!;
      tr.automation ??= {};
      const pts = (tr.automation[param] ??= []);
      fn(pts);
      if (!pts.length) delete tr.automation[param];
    }, { history });

  const locate = (e: { clientX: number; clientY: number; altKey?: boolean }) => {
    const r = svgRef.current!.getBoundingClientRect();
    const raw = Math.max(0, (e.clientX - r.left) / zoom);
    return { beat: e.altKey ? raw : Math.round(raw / snap) * snap, value: vOf(e.clientY - r.top) };
  };

  /** Drag point i; it can't cross its neighbours, so the order (and index) stays stable. */
  const drag = (i: number) => {
    const move = (ev: PointerEvent) => {
      const at = locate(ev);
      mutate((pts) => {
        const lo = i > 0 ? pts[i - 1].beat : 0;
        const hi = i < pts.length - 1 ? pts[i + 1].beat : Infinity;
        pts[i] = { beat: clamp(at.beat, lo, hi), value: at.value };
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const at = locate(e);
    const next = sortPoints([...points, at]);
    const i = next.indexOf(at);
    mutate((pts) => {
      pts.splice(0, pts.length, ...next.map((p) => ({ ...p })));
    }, true);
    drag(i);
  };

  const end = 100000;
  const path = points.length
    ? [`M 0 ${yOf(points[0].value)}`, ...points.map((p) => `L ${p.beat * zoom} ${yOf(p.value)}`), `L ${end} ${yOf(points[points.length - 1].value)}`].join(' ')
    : '';
  const label = (p: AutoParam) => t(`auto.${p}` as MessageKey);

  return (
    <div className="auto-row" style={{ height: AUTO_H, '--track': track.color } as CSSProperties}>
      <div className="auto-head">
        <I.Automation width={14} height={14} />
        <select value={param} onChange={(e) => set({ automationLanes: { ...useStore.getState().automationLanes, [track.id]: e.target.value as AutoParam } })}>
          {AUTO_PARAMS.map((p) => (
            <option key={p.id} value={p.id}>
              {label(p.id)}
              {track.automation?.[p.id]?.length ? ' •' : ''}
            </option>
          ))}
        </select>
        <button className="mini" disabled={!points.length} onClick={() => mutate((pts) => void pts.splice(0), true)} title={t('auto.clearHint')}>
          {t('auto.clear')}
        </button>
        <button
          className="icon-btn"
          onClick={() => {
            const lanes = { ...useStore.getState().automationLanes };
            delete lanes[track.id];
            set({ automationLanes: lanes });
          }}
        >
          <I.Close width={13} height={13} />
        </button>
      </div>
      <div className="auto-lane">
        <svg ref={svgRef} className="auto-svg" height={h} onPointerDown={onBackgroundDown}>
          {points.length ? (
            <path d={path} className="auto-curve" />
          ) : (
            <line x1={0} x2={end} y1={yOf(info.base(track))} y2={yOf(info.base(track))} className="auto-static" />
          )}
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.beat * zoom}
              cy={yOf(p.value)}
              r={5}
              className="auto-point"
              onPointerDown={(e) => {
                e.stopPropagation();
                useStore.getState().checkpoint();
                drag(i);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                mutate((pts) => void pts.splice(i, 1), true);
              }}
            >
              <title>{`${t('auto.bar')} ${(p.beat / BEATS_PER_BAR + 1).toFixed(2)} · ${formatValue(param, p.value)}`}</title>
            </circle>
          ))}
        </svg>
        {!points.length && <div className="auto-hint">{t('auto.hint')}</div>}
      </div>
    </div>
  );
}

export function formatValue(param: AutoParam, v: number) {
  if (param === 'pan') return Math.abs(v) < 0.02 ? 'C' : v < 0 ? `L${Math.round(-v * 50)}` : `R${Math.round(v * 50)}`;
  if (param === 'volume') return v <= 0.001 ? '−∞ dB' : `${(20 * Math.log10(v / 0.8)).toFixed(1)} dB`;
  return `${Math.round(v * 100)}%`;
}
