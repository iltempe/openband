import { useRef, type CSSProperties } from 'react';
import { MasterChainPanel } from './MasterChain';
import { RoleSelect } from './Pilot';
import type { Track } from '../types';
import { useStore } from '../store';
import { engine } from '../audio/engine';
import { useFrame } from '../hooks';
import { Knob } from './Knob';
import { useTrackUpdater } from './SmartControls';
import { runAnalysis } from './AnalysisPanel';
import { useT } from '../i18n';
import { ReferenceStrip } from './Reference';
import { readMeter, resetMeters } from '../audio/meters';
import { TARGETS, targetStatus } from '../analysis/liveLoudness';
import { currentTarget, setMonitoring, useMonitoring } from '../monitoring';

const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '–');

/** Live LUFS of the master (momentary, short-term, integrated, true peak) against a target, plus Mono and Dim. */
function LoudnessPanel() {
  const t = useT();
  const mon = useMonitoring();
  const refs = { m: useRef<HTMLSpanElement>(null), s: useRef<HTMLSpanElement>(null), i: useRef<HTMLSpanElement>(null), tp: useRef<HTMLSpanElement>(null), dot: useRef<HTMLSpanElement>(null) };
  let last = 0;
  useFrame(() => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    const r = readMeter('master');
    if (refs.m.current) refs.m.current.textContent = fmt(r.momentary);
    if (refs.s.current) refs.s.current.textContent = fmt(r.shortTerm);
    if (refs.i.current) refs.i.current.textContent = fmt(r.integrated);
    if (refs.tp.current) refs.tp.current.textContent = fmt(r.truePeakMax);
    if (refs.dot.current) refs.dot.current.dataset.status = targetStatus(Number.isFinite(r.shortTerm) ? r.shortTerm : r.momentary, r.truePeakMax, currentTarget());
  });
  return (
    <div className="loudness-panel">
      <div className="lp-head">
        <span className="lp-dot" ref={refs.dot} data-status="idle" />
        <select value={mon.target} onChange={(e) => setMonitoring({ target: e.target.value as typeof mon.target })} title={t('mon.target')}>
          {TARGETS.map((x) => (
            <option key={x.id} value={x.id}>
              {t(`mon.t.${x.id}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="lp-grid">
        <span>{t('mon.m')}</span>
        <span ref={refs.m}>–</span>
        <span>{t('mon.s')}</span>
        <span ref={refs.s}>–</span>
        <span>{t('mon.i')}</span>
        <span ref={refs.i}>–</span>
        <span>{t('mon.tp')}</span>
        <span ref={refs.tp}>–</span>
      </div>
      <div className="lp-btns">
        <button className={`mini ${mon.mono ? 'on' : ''}`} onClick={() => setMonitoring({ mono: !mon.mono })} title={t('mon.monoTitle')}>
          {t('mon.mono')}
        </button>
        <button className={`mini ${mon.dim ? 'on' : ''}`} onClick={() => setMonitoring({ dim: !mon.dim })} title={t('mon.dimTitle')}>
          {t('mon.dim')}
        </button>
        <button className="mini" onClick={resetMeters}>
          {t('mon.reset')}
        </button>
      </div>
    </div>
  );
}

function Meter({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFrame(() => {
    const db = engine.level(id);
    const v = db === -Infinity ? 0 : Math.max(0, Math.min(1, (db + 60) / 66));
    ref.current?.style.setProperty('--level', String(v));
  });
  return (
    <div className="meter" ref={ref}>
      <div className="meter-fill" />
    </div>
  );
}

function Strip({ track }: { track: Track }) {
  const update = useTrackUpdater(track.id);
  const checkpoint = useStore((s) => s.checkpoint);
  const selected = useStore((s) => s.selectedTrackId === track.id);
  const set = useStore((s) => s.set);
  const t = useT();
  return (
    <div className={`strip ${selected ? 'selected' : ''}`} style={{ '--track': track.color } as CSSProperties} onPointerDown={() => set({ selectedTrackId: track.id })}>
      <div className="strip-knobs">
        <Knob label={t('sc.pan')} size={34} value={track.pan} min={-1} max={1} bipolar defaultValue={0} onStart={checkpoint} onChange={(v) => update((t) => void (t.pan = v))} format={() => ''} />
        <Knob label={t('mix.rev')} size={34} value={track.reverb} color="#a78bfa" defaultValue={0.2} onStart={checkpoint} onChange={(v) => update((t) => void (t.reverb = v))} format={() => ''} />
        <Knob label={t('sc.echo')} size={34} value={track.delay} color="#22d3ee" defaultValue={0} onStart={checkpoint} onChange={(v) => update((t) => void (t.delay = v))} format={() => ''} />
      </div>
      <div className="strip-fader">
        <Meter id={track.id} />
        <input
          className="vfader"
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={track.volume}
          onPointerDown={checkpoint}
          onChange={(e) => update((t) => void (t.volume = Number(e.target.value)))}
        />
      </div>
      <div className="strip-btns">
        <button className={`ms mute ${track.mute ? 'on' : ''}`} onClick={() => update((t) => void (t.mute = !t.mute), true)}>M</button>
        <button className={`ms solo ${track.solo ? 'on' : ''}`} onClick={() => update((t) => void (t.solo = !t.solo), true)}>S</button>
        <button className={`ms polarity ${track.polarity ? 'on' : ''}`} title={t('mon.polarity')} onClick={() => update((tr) => void (tr.polarity ? delete tr.polarity : (tr.polarity = true)), true)}>
          Ø
        </button>
      </div>
      <button
        className={`strip-fx ${track.fx && (track.fx.amp.on || track.fx.eq.on || track.fx.comp.on) ? 'on' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          set({ selectedTrackId: track.id, bottom: 'fx' });
        }}
        title={t('fx.open')}
      >
        FX
      </button>
      <RoleSelect track={track} className="strip-role" compact />
      <div className="strip-name">{track.name}</div>
    </div>
  );
}

export function Mixer() {
  const tracks = useStore((s) => s.project.tracks);
  const master = useStore((s) => s.project.masterVolume);
  const commit = useStore((s) => s.commit);
  const checkpoint = useStore((s) => s.checkpoint);
  const t = useT();
  return (
    <div className="mixer">
      <div className="mixer-strips">
        {tracks.map((t) => (
          <Strip key={t.id} track={t} />
        ))}
      </div>
      <ReferenceStrip />
      <LoudnessPanel />
      <MasterChainPanel />
      <div className="strip master">
        <div className="strip-knobs master-title">
          {t('mix.master')}
          <button
            className="mini mixer-analyze"
            onClick={() => {
              useStore.getState().set({ bottom: 'analysis' });
              void runAnalysis();
            }}
            title={t('an.mixerHint')}
          >
            {t('an.run')}
          </button>
        </div>
        <div className="strip-fader">
          <Meter id="master" />
          <input
            className="vfader"
            type="range"
            min={0}
            max={1}
            step={0.005}
            value={master}
            onPointerDown={checkpoint}
            onChange={(e) => commit((d) => void (d.masterVolume = Number(e.target.value)), { history: false })}
          />
        </div>
        <div className="strip-name">{t('mix.out')}</div>
      </div>
    </div>
  );
}
