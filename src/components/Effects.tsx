// Per-track insert effects panel: amp sim, 3-band EQ and compressor.
import { useRef, type CSSProperties, type ReactNode } from 'react';
import type { Track, TrackFx } from '../types';
import { getTrack, useStore } from '../store';
import { engine } from '../audio/engine';
import { normalizeFx } from '../audio/fx';
import { useFrame } from '../hooks';
import { useT } from '../i18n';
import { Knob } from './Knob';
import * as I from './Icons';
import { PluginSlots } from './Plugins';

export function Effects() {
  const project = useStore((s) => s.project);
  const track = getTrack(project, useStore((s) => s.selectedTrackId));
  const t = useT();
  if (!track) {
    return (
      <div className="panel-empty">
        <I.Fx width={28} height={28} />
        <p>{t('fx.empty')}</p>
      </div>
    );
  }
  return <TrackEffects track={track} />;
}

function Unit({ title, on, onToggle, children, extra }: { title: string; on: boolean; onToggle: () => void; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className={`fx-unit ${on ? 'on' : ''}`}>
      <div className="fx-unit-head">
        <button className={`fx-power ${on ? 'on' : ''}`} onClick={onToggle} aria-pressed={on}>
          <span className="dot" />
        </button>
        <span className="fx-unit-title">{title}</span>
        {extra}
      </div>
      <div className="fx-knobs">{children}</div>
    </div>
  );
}

function GrMeter({ trackId }: { trackId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFrame(() => ref.current?.style.setProperty('--gr', String(Math.min(1, -engine.reduction(trackId) / 24))));
  return (
    <div className="gr-meter" ref={ref} title="Gain reduction">
      <div className="gr-fill" />
    </div>
  );
}

function TrackEffects({ track }: { track: Track }) {
  const commit = useStore((s) => s.commit);
  const checkpoint = useStore((s) => s.checkpoint);
  const t = useT();
  const fx = normalizeFx(track.fx);
  const update = (fn: (fx: TrackFx) => void, history = false) =>
    commit((d) => {
      const tr = d.tracks.find((x) => x.id === track.id)!;
      tr.fx = normalizeFx(tr.fx);
      fn(tr.fx);
    }, { history });
  const k = { size: 40, onStart: checkpoint };
  const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

  return (
    <div className="fx-panel" style={{ '--track': track.color } as CSSProperties}>
      <div className="fx-track">
        <div className="smart-kicker">{t('fx.title')}</div>
        <div className="fx-track-name">{track.name}</div>
        <div className="smart-desc">{t('fx.chainPlugins')}</div>
      </div>
      <Unit title={t('fx.amp')} on={fx.amp.on} onToggle={() => update((f) => void (f.amp.on = !f.amp.on), true)}>
        <Knob {...k} label={t('fx.drive')} value={fx.amp.drive} defaultValue={0.45} color="#fb923c" onChange={(v) => update((f) => void (f.amp.drive = v))} format={(v) => `${Math.round(v * 100)}%`} />
        <Knob {...k} label={t('fx.tone')} value={fx.amp.tone} defaultValue={0.55} color="#fbbf24" onChange={(v) => update((f) => void (f.amp.tone = v))} format={(v) => `${Math.round(v * 100)}%`} />
        <Knob {...k} label={t('fx.level')} value={fx.amp.level} defaultValue={0.7} onChange={(v) => update((f) => void (f.amp.level = v))} format={(v) => `${Math.round(v * 100)}%`} />
      </Unit>
      <Unit title={t('fx.eq')} on={fx.eq.on} onToggle={() => update((f) => void (f.eq.on = !f.eq.on), true)}>
        <Knob {...k} label={t('fx.low')} value={fx.eq.low} min={-15} max={15} bipolar defaultValue={0} color="#60a5fa" onChange={(v) => update((f) => void (f.eq.low = v))} format={db} />
        <Knob {...k} label={t('fx.mid')} value={fx.eq.mid} min={-15} max={15} bipolar defaultValue={0} color="#34d399" onChange={(v) => update((f) => void (f.eq.mid = v))} format={db} />
        <Knob
          {...k}
          label={t('fx.midFreq')}
          value={Math.log2(fx.eq.midFreq / 200) / Math.log2(30)}
          defaultValue={Math.log2(5) / Math.log2(30)}
          color="#34d399"
          onChange={(v) => update((f) => void (f.eq.midFreq = Math.round(200 * Math.pow(30, v))))}
          format={(v) => {
            const hz = 200 * Math.pow(30, v);
            return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
          }}
        />
        <Knob {...k} label={t('fx.high')} value={fx.eq.high} min={-15} max={15} bipolar defaultValue={0} color="#f472b6" onChange={(v) => update((f) => void (f.eq.high = v))} format={db} />
      </Unit>
      <Unit title={t('fx.comp')} on={fx.comp.on} onToggle={() => update((f) => void (f.comp.on = !f.comp.on), true)} extra={fx.comp.on ? <GrMeter trackId={track.id} /> : undefined}>
        <Knob {...k} label={t('fx.threshold')} value={fx.comp.threshold} min={-60} max={0} defaultValue={-18} color="#a78bfa" onChange={(v) => update((f) => void (f.comp.threshold = v))} format={(v) => `${v.toFixed(0)} dB`} />
        <Knob {...k} label={t('fx.ratio')} value={fx.comp.ratio} min={1} max={20} defaultValue={4} color="#a78bfa" onChange={(v) => update((f) => void (f.comp.ratio = v))} format={(v) => `${v.toFixed(1)}:1`} />
        <Knob {...k} label={t('fx.attack')} value={fx.comp.attack} min={0.001} max={0.2} defaultValue={0.01} onChange={(v) => update((f) => void (f.comp.attack = v))} format={(v) => `${Math.round(v * 1000)} ms`} />
        <Knob {...k} label={t('fx.release')} value={fx.comp.release} min={0.02} max={1} defaultValue={0.18} onChange={(v) => update((f) => void (f.comp.release = v))} format={(v) => `${Math.round(v * 1000)} ms`} />
        <Knob {...k} label={t('fx.makeup')} value={fx.comp.makeup} min={0} max={24} defaultValue={4} color="#22d3ee" onChange={(v) => update((f) => void (f.comp.makeup = v))} format={(v) => `+${v.toFixed(1)} dB`} />
      </Unit>
      <PluginSlots track={track} />
    </div>
  );
}
