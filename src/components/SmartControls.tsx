import type { CSSProperties } from 'react';
import type { Track } from '../types';
import { getTrack, useStore } from '../store';
import { PRESETS, customInstruments, findInstrument } from '../audio/instruments';
import { Knob } from './Knob';
import * as I from './Icons';
import { InstrumentEditor } from './ImportUI';
import { SynthEditor } from './SynthEditor';
import { ToneMatch } from './MatchSound';
import { openPluginBrowser } from './Plugins';
import { categoryLabel, presetDescription, useT } from '../i18n';
import { setLowLatency, useLowLatency } from '../lowLatency';
import { desktopNative, useNativeStatus } from '../audio/native';
import { engine } from '../audio/engine';

/** Low-latency monitoring (G8.7): on for the selected track's native instrument, with what it measures. */
function LowLatency({ trackId }: { trackId: string }) {
  const t = useT();
  const { enabled, trackId: on, info, error } = useLowLatency();
  const heard = useNativeStatus((s) => s[`${trackId}:instrument`]?.heard);
  if (!desktopNative()?.monitor) return null;
  const active = on === trackId && info;
  const ms = (frames: number) => ((frames / engine.sampleRateNow()) * 1000).toFixed(1);
  return (
    <div className={`low-latency${active ? ' on' : ''}`}>
      <label className="row">
        <input type="checkbox" checked={enabled} onChange={(e) => setLowLatency(e.target.checked)} />
        <span>{t('ll.toggle')}</span>
      </label>
      <div className="inst-note">
        {active
          ? t('ll.on', { buffer: ms((info.period ?? 128) * (info.periods ?? 2)), device: info.device ?? '' }) + (heard ? ' ' + t('ll.heard', { ms: ms(heard) }) : '')
          : error
            ? t('ll.error', { error })
            : t('ll.off')}
      </div>
    </div>
  );
}

export function useTrackUpdater(trackId: string) {
  const commit = useStore((s) => s.commit);
  return (fn: (t: Track) => void, history = false) => commit((d) => fn(d.tracks.find((t) => t.id === trackId)!), { history });
}

export function SmartControls() {
  const project = useStore((s) => s.project);
  const track = getTrack(project, useStore((s) => s.selectedTrackId));
  const t = useT();
  if (!track) {
    return (
      <div className="panel-empty">
        <I.Sliders width={28} height={28} />
        <p>{t('sc.empty')}</p>
      </div>
    );
  }
  return <TrackControls track={track} />;
}

function TrackControls({ track }: { track: Track }) {
  const update = useTrackUpdater(track.id);
  const checkpoint = useStore((s) => s.checkpoint);
  const preset = findInstrument(track.instrument);
  const t = useT();
  useStore((s) => s.project.instruments);
  const siblings = [...customInstruments().map((c) => findInstrument(c.id)!), ...PRESETS].filter((p) => p.kind === track.kind);
  const audio = track.kind === 'audio';

  return (
    <div className="smart" style={{ '--track': track.color } as CSSProperties}>
      <div className="smart-card">
        <div className="smart-art">{track.kind === 'drums' ? <I.DrumIcon width={44} height={44} /> : audio ? <I.Wave width={44} height={44} /> : <I.KeysIcon width={44} height={44} />}</div>
        <div className="smart-info">
          <div className="smart-kicker">{audio ? t('audio.track') : preset && categoryLabel(preset.category)}</div>
          {audio ? (
            <div className="smart-preset static">{track.name}</div>
          ) : (
          <select
            className="smart-preset"
            value={track.instrument}
            onChange={(e) =>
              update((t) => {
                t.instrument = e.target.value;
                t.cutoff = findInstrument(e.target.value)!.cutoff;
                // Another synth: the parameters were the old one's.
                delete t.synthParams;
              }, true)
            }
          >
            {siblings.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          )}
          <div className="smart-desc">{audio ? t('audio.trackDesc') : preset && (preset.custom ? preset.description : presetDescription(preset))}</div>
        </div>
      </div>
      <div className="smart-knobs">
        <Knob label={t('sc.volume')} value={track.volume} defaultValue={0.8} onStart={checkpoint} onChange={(v) => update((t) => void (t.volume = v))} format={(v) => (v <= 0.001 ? '−∞' : `${(20 * Math.log10(v / 0.8)).toFixed(1)} dB`)} size={64} />
        <Knob label={t('sc.pan')} value={track.pan} min={-1} max={1} defaultValue={0} bipolar onStart={checkpoint} onChange={(v) => update((t) => void (t.pan = v))} format={(v) => (Math.abs(v) < 0.02 ? 'C' : v < 0 ? `L${Math.round(-v * 50)}` : `R${Math.round(v * 50)}`)} size={64} />
        <Knob label={t('sc.brightness')} value={track.cutoff} defaultValue={preset?.cutoff ?? 0.8} color="#fbbf24" onStart={checkpoint} onChange={(v) => update((t) => void (t.cutoff = v))} size={64} />
        <Knob label={t('sc.reverb')} value={track.reverb} defaultValue={0.2} color="#a78bfa" onStart={checkpoint} onChange={(v) => update((t) => void (t.reverb = v))} size={64} />
        <Knob label={t('sc.echo')} value={track.delay} defaultValue={0} color="#22d3ee" onStart={checkpoint} onChange={(v) => update((t) => void (t.delay = v))} size={64} />
      </div>
      {preset?.custom?.source === 'wam' || preset?.custom?.source === 'native' ? (
        <div className="inst-editor">
          <div className="inst-head">
            <span className="smart-kicker">{preset.custom.source === 'native' ? (preset.custom.format ?? 'native').toUpperCase() : 'WAM'}</span>
          </div>
          <div className="inst-note">{preset.custom.source === 'native' ? t('nat.instrumentNote') : t('plug.instrumentNote')}</div>
          {preset.custom.source === 'native' && <LowLatency trackId={track.id} />}
          <div className="row">
            <button className="btn primary" onClick={() => useStore.getState().set({ pluginWindow: { trackId: track.id, slotId: null } })}>
              <I.Fx width={14} height={14} /> {t('plug.open')}
            </button>
            <button className="btn" onClick={() => openPluginBrowser('instrument', track.id)}>
              {t('plug.change')}
            </button>
          </div>
        </div>
      ) : preset?.custom ? (
        <InstrumentEditor inst={preset.custom} track={track} />
      ) : (
        (track.kind === 'instrument' && <SynthEditor track={track} />) || (track.kind === 'audio' && <ToneMatch track={track} />)
      )}
    </div>
  );
}
