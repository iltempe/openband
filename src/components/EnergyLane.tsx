// Draw the song (G2): the Energy lane above the structure. Drag to draw how big the song should be over
// time (or pick a shape and a length), see the song's measured energy in grey under it, and Arrange.
import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { useT } from '../i18n';
import { ENERGY_SHAPES, curveAt, measureEnergy, type EnergyCurve } from '../arranger/energy';
import { BEATS_PER_BAR } from '../music';

export const ENERGY_H = 56;
const PREF = 'openband.energyLane';

const readPref = () => {
  try {
    return localStorage.getItem(PREF) === '1';
  } catch {
    return false;
  }
};
export const useEnergyLane = create<{ open: boolean; busy: boolean }>(() => ({ open: readPref(), busy: false }));
export function setEnergyLane(open: boolean) {
  try {
    localStorage.setItem(PREF, open ? '1' : '0');
  } catch {}
  useEnergyLane.setState({ open });
}
/** Shown when asked for, or when the song has a curve. */
export const useEnergyShown = () => {
  const open = useEnergyLane((s) => s.open);
  const has = useStore((s) => !!s.project.energy);
  return open || has;
};

const run = (method: string, params: Record<string, unknown>) => runCommand(method, params, 'ui');

/** "3:30" → seconds, "64" → bars. */
export function parseLength(v: string): { seconds?: number; length_bars?: number } | null {
  const m = v.trim().match(/^(\d+):(\d{1,2})$/);
  if (m) return { seconds: Number(m[1]) * 60 + Number(m[2]) };
  const n = Number(v.trim().replace(/\s*(bars?|battute)$/i, ''));
  return Number.isFinite(n) && n >= 4 ? { length_bars: Math.round(n / 4) * 4 } : null;
}

export function EnergyCorner() {
  const t = useT();
  const curve = useStore((s) => s.project.energy);
  const bpm = useStore((s) => s.project.bpm);
  const busy = useEnergyLane((s) => s.busy);
  const [length, setLength] = useState('');
  const notify = (e: unknown) => useStore.getState().notify((e as Error).message);
  const lengthLabel = curve ? `${Math.floor((curve.length_bars * BEATS_PER_BAR * 60) / bpm / 60)}:${String(Math.round((curve.length_bars * BEATS_PER_BAR * 60) / bpm) % 60).padStart(2, '0')}` : '3:00';
  const applyLength = () => {
    const l = parseLength(length);
    setLength('');
    if (!l) return;
    if (curve?.shape) void run('set_energy_curve', { shape: curve.shape, ...l }).catch(notify);
    else if (curve) void run('set_energy_curve', { points: curve.points, ...(l.length_bars ? { length_bars: l.length_bars } : { seconds: l.seconds }) }).catch(notify);
    else void run('set_energy_curve', { shape: 'pop', ...l }).catch(notify);
  };
  const arrange = async () => {
    useEnergyLane.setState({ busy: true });
    try {
      const r = (await run('arrange_from_energy', {})) as { branch?: string; sections: unknown[] };
      useStore.getState().notify(t('en.arranged', { n: r.sections.length, branch: r.branch ?? '' }));
    } catch (e) {
      notify(e);
    } finally {
      useEnergyLane.setState({ busy: false });
    }
  };
  return (
    <div className="energy-corner">
      <div className="energy-corner-top">
        <span>{t('en.lane')}</span>
        {!curve && (
          <button className="mini" title={t('en.hide')} onClick={() => setEnergyLane(false)}>
            ×
          </button>
        )}
      </div>
      <div className="energy-corner-row">
        <select value={curve?.shape ?? ''} onChange={(e) => e.target.value && void run('set_energy_curve', { shape: e.target.value, ...(curve ? { length_bars: curve.length_bars } : { seconds: 180 }) }).catch(notify)} title={t('en.shapeHint')}>
          <option value="">{curve ? t('en.drawn') : t('en.shape')}</option>
          {ENERGY_SHAPES.map((s) => (
            <option key={s} value={s}>
              {t(`en.shape.${s}`)}
            </option>
          ))}
        </select>
        <input className="energy-length" placeholder={lengthLabel} value={length} onChange={(e) => setLength(e.target.value)} onBlur={applyLength} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} title={t('en.lengthHint')} />
        <button className="btn tiny primary" disabled={!curve || busy} onClick={arrange} title={t('en.arrangeHint')}>
          {busy ? '…' : t('en.arrange')}
        </button>
      </div>
    </div>
  );
}

export function EnergyLane({ totalBeats }: { totalBeats: number }) {
  const t = useT();
  const zoom = useStore((s) => s.zoom);
  const project = useStore((s) => s.project);
  const curve = project.energy as EnergyCurve | undefined;
  const measured = useMemo(() => measureEnergy(project), [project.regions, project.tracks]); // eslint-disable-line react-hooks/exhaustive-deps
  const barW = zoom * BEATS_PER_BAR;
  const w = totalBeats * zoom;
  const H = ENERGY_H - 6;
  const y = (e: number) => 3 + (1 - e) * H;
  const bars = Math.ceil(totalBeats / BEATS_PER_BAR);

  // Drawing: drag across the lane; every bar crossed gets the height under the pointer. One undo step.
  const draw = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => ({ bar: Math.max(1, Math.floor((ev.clientX - rect.left) / barW) + 1), energy: Math.max(0, Math.min(1, 1 - (ev.clientY - rect.top - 3) / H)) });
    const s = useStore.getState();
    s.checkpoint(t('en.draw'));
    const start = at(e);
    const length = curve?.length_bars ?? Math.max(32, Math.ceil(start.bar / 4) * 4);
    const pts = new Map<number, number>((curve?.points ?? []).map((p) => [p.bar, p.energy]));
    let last = start;
    const put = (p: { bar: number; energy: number }) => {
      // Fill the bars between two pointer events too (a fast stroke skips some).
      const from = Math.min(last.bar, p.bar);
      const to = Math.max(last.bar, p.bar);
      for (let b = from; b <= to; b++) {
        const f = to === from ? 1 : (b - last.bar) / (p.bar - last.bar);
        pts.set(b, +(last.energy + (p.energy - last.energy) * Math.max(0, Math.min(1, f))).toFixed(3));
      }
      last = p;
      const points = [...pts].sort((a, b) => a[0] - b[0]).map(([bar, energy]) => ({ bar, energy }));
      useStore.getState().commit((d) => void (d.energy = { points, length_bars: Math.max(length, Math.ceil(points[points.length - 1].bar / 4) * 4) }), { history: false });
    };
    put(start);
    const move = (ev: PointerEvent) => put(at(ev));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const line = curve
    ? Array.from({ length: curve.length_bars }, (_, b) => `${b === 0 ? 'M' : 'L'}${(b + 0.5) * barW},${y(curveAt(curve, b + 1))}`).join(' ')
    : '';
  return (
    <div className="energy-lane" style={{ height: ENERGY_H }} title={t('en.laneHint')}>
      <svg width={w} height={ENERGY_H} onPointerDown={draw}>
        {measured.slice(0, bars).map((e, b) => (
          <rect key={b} className="energy-measured" x={b * barW + 1} width={Math.max(1, barW - 2)} y={y(e)} height={H + 3 - y(e)} />
        ))}
        {curve && <rect className="energy-span" x={0} y={0} width={curve.length_bars * barW} height={ENERGY_H} />}
        {curve && <path className="energy-line" d={line} />}
        {curve?.points
          .filter((_p, i, a) => a.length <= 64 || i % Math.ceil(a.length / 64) === 0)
          .map((p) => (
            <circle
              key={p.bar}
              className="energy-point"
              cx={(p.bar - 0.5) * barW}
              cy={y(p.energy)}
              r={3.5}
              onDoubleClick={(e) => {
                e.stopPropagation();
                useStore.getState().commit((d) => {
                  if (!d.energy) return;
                  d.energy.points = d.energy.points.filter((x) => x.bar !== p.bar);
                  if (!d.energy.points.length) delete d.energy;
                }, { label: t('en.draw') });
              }}
            />
          ))}
        {!curve && (
          <text className="energy-empty" x={8} y={ENERGY_H / 2 + 4}>
            {t('en.empty')}
          </text>
        )}
      </svg>
    </div>
  );
}
