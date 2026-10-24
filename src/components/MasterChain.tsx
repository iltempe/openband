// The master chain in the mixer (G1): EQ → glue → width → true-peak limiter, and "Set loudness", which
// renders the song to find the limiter gain for a platform's target.
import { useRef, useState } from 'react';
import { useStore } from '../store';
import { useT } from '../i18n';
import { engine } from '../audio/engine';
import { PLATFORM_TARGETS, defaultMaster, mergeMaster, type Platform } from '../audio/master';
import { runCommand } from '../commands';
import { useFrame } from '../hooks';
import type { MasterChain } from '../types';
import { Knob } from './Knob';

type Patch = Parameters<typeof mergeMaster>[1];

function LimiterMeter() {
  const ref = useRef<HTMLDivElement>(null);
  useFrame(() => ref.current?.style.setProperty('--gr', String(Math.min(1, -engine.limiterReduction / 12))));
  return (
    <div className="gr-meter" ref={ref} title="Limiter gain reduction">
      <div className="gr-fill" />
    </div>
  );
}

export function MasterChainPanel() {
  const m = useStore((s) => s.project.master) ?? defaultMaster();
  const commit = useStore((s) => s.commit);
  const checkpoint = useStore((s) => s.checkpoint);
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>('spotify');
  const set = (patch: Patch, history = false) => commit((d) => void (d.master = mergeMaster(d.master, patch)), { history, label: 'Master chain' });
  const k = { size: 28, onStart: checkpoint };
  const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  const section = (key: 'eq' | 'glue' | 'width' | 'limiter', title: string, children: React.ReactNode, extra?: React.ReactNode) => {
    const on = m.on && (m[key] as { on: boolean }).on;
    return (
      <div className={`mc-unit ${on ? 'on' : ''}`}>
        <div className="fx-unit-head">
          <button className={`fx-power ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => set({ on: true, [key]: { on: !(m[key] as { on: boolean }).on } } as Patch, true)}>
            <span className="dot" />
          </button>
          <span className="fx-unit-title">{title}</span>
          {extra}
        </div>
        <div className="fx-knobs">{children}</div>
      </div>
    );
  };
  const setLoudness = async () => {
    setBusy(true);
    setNote(null);
    try {
      const target = PLATFORM_TARGETS[platform];
      const r = (await runCommand('set_master_chain', { platform, limiter: { on: true, target_lufs: target.lufs, ceiling_dbtp: target.ceiling } }, 'ui')) as { loudness?: { after_lufs: number; true_peak_dbtp: number }; warning?: string; master: MasterChain };
      setNote(r.warning ?? (r.loudness ? t('mc.done', { lufs: r.loudness.after_lufs.toFixed(1), tp: r.loudness.true_peak_dbtp.toFixed(1) }) : null));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`master-chain ${m.on ? 'on' : ''}`}>
      <div className="mc-head">
        <span className="smart-kicker">{t('mc.title')}</span>
        <button className="btn mini mc-pilot" title={t('pi.noRun')} onClick={() => useStore.getState().set({ bottom: 'pilot' })}>
          ◎ {t('pi.title')}
        </button>
        <button className={`fx-power ${m.on ? 'on' : ''}`} aria-pressed={m.on} title={t('mc.bypass')} onClick={() => set({ on: !m.on }, true)}>
          <span className="dot" />
        </button>
      </div>
      {section(
        'eq',
        'EQ',
        <>
          <Knob {...k} label={t('mc.tilt')} value={m.eq.tilt} min={-3} max={3} bipolar defaultValue={0} color="#fbbf24" onChange={(v) => set({ eq: { tilt: v } })} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB/oct`} />
          <Knob {...k} label={t('fx.low')} value={m.eq.low} min={-12} max={12} bipolar defaultValue={0} color="#60a5fa" onChange={(v) => set({ eq: { low: v } })} format={db} />
          <Knob {...k} label={t('fx.high')} value={m.eq.high} min={-12} max={12} bipolar defaultValue={0} color="#f472b6" onChange={(v) => set({ eq: { high: v } })} format={db} />
        </>,
      )}
      {section(
        'glue',
        t('mc.glue'),
        <>
          <Knob {...k} label={t('fx.threshold')} value={m.glue.threshold} min={-40} max={0} defaultValue={-18} color="#a78bfa" onChange={(v) => set({ glue: { threshold: v } })} format={(v) => `${v.toFixed(0)} dB`} />
          <Knob {...k} label={t('fx.ratio')} value={m.glue.ratio} min={1} max={10} defaultValue={2} color="#a78bfa" onChange={(v) => set({ glue: { ratio: v } })} format={(v) => `${v.toFixed(1)}:1`} />
          <Knob {...k} label={t('fx.makeup')} value={m.glue.makeup} min={0} max={12} defaultValue={1.5} color="#22d3ee" onChange={(v) => set({ glue: { makeup: v } })} format={(v) => `+${v.toFixed(1)} dB`} />
        </>,
      )}
      {section(
        'width',
        t('mc.width'),
        <>
          <Knob {...k} label={t('mc.amount')} value={m.width.amount} min={0} max={2} defaultValue={1} color="#34d399" onChange={(v) => set({ width: { amount: v } })} format={(v) => `${Math.round(v * 100)}%`} />
          <Knob {...k} label={t('mc.monoBelow')} value={m.width.monoBelowHz} min={20} max={400} defaultValue={120} onChange={(v) => set({ width: { monoBelowHz: Math.round(v) } })} format={(v) => `${Math.round(v)} Hz`} />
        </>,
      )}
      {section(
        'limiter',
        t('mc.limiter'),
        <>
          <Knob {...k} label={t('mc.ceiling')} value={m.limiter.ceilingDbtp} min={-6} max={0} defaultValue={-1} color="#fb7185" onChange={(v) => set({ limiter: { ceilingDbtp: +v.toFixed(1) } })} format={(v) => `${v.toFixed(1)} dBTP`} />
          <div className="mc-target">
            <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)} aria-label={t('mc.platform')}>
              {(Object.keys(PLATFORM_TARGETS) as Platform[]).map((p) => (
                <option key={p} value={p}>
                  {t(`mc.p.${p}` as 'mc.p.spotify')} · {PLATFORM_TARGETS[p].lufs} LUFS
                </option>
              ))}
            </select>
            <button className="btn primary mini" disabled={busy} onClick={() => void setLoudness()}>
              {busy ? t('mc.rendering') : t('mc.setLoudness')}
            </button>
            <span className="mc-now">
              {m.limiter.on ? t('mc.target', { lufs: m.limiter.targetLufs, gain: (m.limiter.inputGainDb ?? 0).toFixed(1) }) : t('mc.off')}
            </span>
          </div>
        </>,
        m.on && m.limiter.on ? <LimiterMeter /> : undefined,
      )}
      {note && <div className="mc-note">{note}</div>}
    </div>
  );
}
