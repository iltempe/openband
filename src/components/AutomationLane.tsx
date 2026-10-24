// Automation lane shown under a track: draw and edit a curve for one target — a mix parameter, a
// built-in effect parameter or a plugin parameter (F22) — and choose the write mode for live recording.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AutoParam, AutoPoint, AutoTarget, Track } from '../types';
import { useStore } from '../store';
import { AUTO_PARAMS, FX_PARAMS, baseValue, mix, parseTargetKey, pointsOf, setPoints, sortPoints, targetKey, targetRange, type WriteMode } from '../automation';
import { getPluginParams } from '../plugins';
import { setWriteMode, useAutoWrite } from '../autoWrite';
import { BEATS_PER_BAR, clamp } from '../music';
import { useT, type MessageKey } from '../i18n';
import * as I from './Icons';

export const AUTO_H = 68;
const PAD = 6;

interface PluginParam {
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  value: number;
}

/** The parameters of the track's plugins (loaded ones), for the lane selector. */
function usePluginParams(track: Track): PluginParam[] {
  const project = useStore((s) => s.project);
  const [list, setList] = useState<PluginParam[]>([]);
  const custom = project.instruments?.find((i) => i.id === track.instrument && (i.source === 'wam' || i.source === 'native'));
  const slots = [...(custom ? [{ slotId: null as string | null, name: custom.name }] : []), ...(track.fx?.plugins ?? []).map((s) => ({ slotId: s.id as string | null, name: s.name }))];
  const sig = slots.map((s) => s.slotId ?? 'i').join(',');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: PluginParam[] = [];
      for (const s of slots) {
        try {
          for (const p of await getPluginParams(track.id, s.slotId ?? undefined)) out.push({ key: targetKey({ kind: 'plugin', slotId: s.slotId, paramId: p.id }), label: p.label, group: s.name, min: p.min, max: p.max, value: p.value });
        } catch {
          // not loaded yet
        }
      }
      if (alive) setList(out);
    })();
    return () => {
      alive = false;
    };
  }, [track.id, sig]);
  return list;
}

export function AutomationLane({ track }: { track: Track }) {
  const key = useStore((s) => s.automationLanes[track.id]);
  const zoom = useStore((s) => s.zoom);
  const set = useStore((s) => s.set);
  const commit = useStore((s) => s.commit);
  const writeMode = useAutoWrite((s) => s.mode);
  const svgRef = useRef<SVGSVGElement>(null);
  const t = useT();
  const pluginParams = usePluginParams(track);
  if (!key) return null;
  // An old ("volume") or unknown key falls back to a mix lane instead of breaking the arrangement.
  const target: AutoTarget = parseTargetKey(key) ?? (AUTO_PARAMS.some((p) => p.id === key) ? mix(key as AutoParam) : mix('volume'));
  const pp = pluginParams.find((p) => p.key === targetKey(target));
  const info = targetRange(target, pp);
  const base = baseValue(track, target) ?? pp?.value ?? info.min;
  const points = pointsOf(track, target) ?? [];
  const h = AUTO_H - 1;
  const yOf = (v: number) => PAD + (1 - (v - info.min) / (info.max - info.min || 1)) * (h - PAD * 2);
  const vOf = (y: number) => clamp(info.min + (1 - (y - PAD) / (h - PAD * 2)) * (info.max - info.min), info.min, info.max);
  const snap = zoom >= 22 ? 0.25 : 1;

  const mutate = (fn: (pts: AutoPoint[]) => void, history = false) =>
    commit((d) => {
      const tr = d.tracks.find((x) => x.id === track.id)!;
      const pts = (pointsOf(tr, target) ?? []).map((p) => ({ ...p }));
      fn(pts);
      setPoints(tr, target, pts);
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
  const mark = (tg: AutoTarget) => (pointsOf(track, tg)?.length ? ' •' : '');
  const fxLabel = (unit: string, param: string) => t(`autofx.${unit}.${param}` as MessageKey);
  const groups = [...new Set(pluginParams.map((p) => p.group))];

  return (
    <div className="auto-row" style={{ height: AUTO_H, '--track': track.color } as CSSProperties}>
      <div className="auto-head">
        <I.Automation width={14} height={14} />
        <select value={targetKey(target)} onChange={(e) => set({ automationLanes: { ...useStore.getState().automationLanes, [track.id]: e.target.value } })}>
          <optgroup label={t('auto.gMix')}>
            {AUTO_PARAMS.map((p) => (
              <option key={p.id} value={targetKey(mix(p.id))}>
                {t(`auto.${p.id}` as MessageKey)}
                {mark(mix(p.id))}
              </option>
            ))}
          </optgroup>
          {(['amp', 'eq', 'comp'] as const).map((unit) => (
            <optgroup key={unit} label={t(`fx.${unit}` as MessageKey)}>
              {FX_PARAMS.filter((p) => p.unit === unit).map((p) => {
                const tg: AutoTarget = { kind: 'fx', unit, param: p.param };
                return (
                  <option key={p.param} value={targetKey(tg)}>
                    {fxLabel(unit, p.param)}
                    {mark(tg)}
                  </option>
                );
              })}
            </optgroup>
          ))}
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {pluginParams
                .filter((p) => p.group === g)
                .map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                    {mark(parseTargetKey(p.key)!)}
                  </option>
                ))}
            </optgroup>
          ))}
          {target.kind === 'plugin' && !pp && <option value={targetKey(target)}>{target.paramId}</option>}
        </select>
        <select className={`auto-write ${writeMode !== 'off' ? 'on' : ''}`} value={writeMode} onChange={(e) => setWriteMode(e.target.value as WriteMode)} title={t('auto.writeHint')}>
          <option value="off">{t('auto.wOff')}</option>
          <option value="touch">{t('auto.wTouch')}</option>
          <option value="latch">{t('auto.wLatch')}</option>
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
          {points.length ? <path d={path} className="auto-curve" /> : <line x1={0} x2={end} y1={yOf(base)} y2={yOf(base)} className="auto-static" />}
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
              <title>{`${t('auto.bar')} ${(p.beat / BEATS_PER_BAR + 1).toFixed(2)} · ${formatTargetValue(target, p.value)}`}</title>
            </circle>
          ))}
        </svg>
        {!points.length && <div className="auto-hint">{t('auto.hint')}</div>}
      </div>
    </div>
  );
}

/** A value as people read it: dB, Hz, %, L/R. */
export function formatTargetValue(target: AutoTarget, v: number) {
  if (target.kind === 'mix') return formatValue(target.param, v);
  if (target.kind === 'fx') {
    const u = FX_PARAMS.find((p) => p.unit === target.unit && p.param === target.param)?.units;
    return u === 'Hz' ? `${Math.round(v)} Hz` : u === 'dB' ? `${v.toFixed(1)} dB` : u === 's' ? `${Math.round(v * 1000)} ms` : target.param === 'ratio' ? `${v.toFixed(1)}:1` : `${Math.round(v * 100)}%`;
  }
  return +v.toFixed(3) + '';
}

export function formatValue(param: AutoParam, v: number) {
  if (param === 'pan') return Math.abs(v) < 0.02 ? 'C' : v < 0 ? `L${Math.round(-v * 50)}` : `R${Math.round(v * 50)}`;
  if (param === 'volume') return v <= 0.001 ? '−∞ dB' : `${(20 * Math.log10(v / 0.8)).toFixed(1)} dB`;
  return `${Math.round(v * 100)}%`;
}
