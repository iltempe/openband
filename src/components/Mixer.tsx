import { useRef, type CSSProperties } from 'react';
import type { Track } from '../types';
import { useStore } from '../store';
import { engine } from '../audio/engine';
import { useFrame } from '../hooks';
import { Knob } from './Knob';
import { useTrackUpdater } from './SmartControls';
import { useT } from '../i18n';

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
      <div className="strip master">
        <div className="strip-knobs master-title">{t('mix.master')}</div>
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
