// Jam mode UI: the AI panel section (listening / answering at bar n, keep) and ghost notes of the
// AI's answer in the piano roll.
import type { Region } from '../types';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { BEATS_PER_BAR } from '../music';
import { dismissAnswer, useJam } from '../jamMode';
import { phraseLength } from '../jam';
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useBridge } from '../bridge';
import { streamEngines, useLiveJam } from '../stream/liveJam';
import type { EngineInfo } from '../ensemble/router';

const run = (m: string, a: Record<string, unknown> = {}) => runCommand(m, a, 'ui').catch((e) => useStore.getState().notify((e as Error).message));

export function JamSection() {
  const jam = useJam();
  const tracks = useStore((s) => s.project.tracks);
  const t = useT();
  const playable = tracks.filter((x) => x.kind !== 'audio');
  const bar = jam.last ? jam.last.startBeat / BEATS_PER_BAR + 1 : 0;
  const label =
    jam.status === 'answering' ? t('jam.answering', { bar }) : jam.status === 'thinking' ? t('jam.thinking') : jam.status === 'listening' ? t('jam.listening') : t('jam.off');
  return (
    <div className={`jam ${jam.enabled ? 'on' : ''}`}>
      <label className="ai-share">
        <input type="checkbox" checked={jam.enabled} onChange={(e) => run('set_jam_mode', { enabled: e.target.checked, response_track_id: jam.trackId ?? playable[0]?.id })} />
        <span>
          {t('jam.title')}
          <small>{t('jam.hint')}</small>
        </span>
      </label>
      {jam.enabled && (
        <div className="jam-row">
          <select className="ver-input" value={jam.trackId ?? ''} onChange={(e) => run('set_jam_mode', { enabled: true, response_track_id: e.target.value })} title={t('jam.trackHint')}>
            {playable.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <select className="ver-input" value={jam.window} onChange={(e) => run('set_jam_mode', { enabled: true, window: e.target.value })}>
            <option value="next_bar">{t('jam.nextBar')}</option>
            <option value="next_loop">{t('jam.nextLoop')}</option>
          </select>
        </div>
      )}
      {(jam.enabled || jam.last) && (
        <div className={`jam-status ${jam.status}`}>
          <span className="jam-dot" />
          {label}
          {jam.last?.slipped && jam.status === 'answering' && <small>{t('jam.slipped')}</small>}
        </div>
      )}
      {jam.last && (
        <div className="jam-row">
          <button className="btn primary" onClick={() => run('keep_answer')}>
            {t('jam.keep')}
          </button>
          <button className="btn" onClick={dismissAnswer}>
            {t('jam.dismiss')}
          </button>
        </div>
      )}
      {jam.answers.filter((a) => a.id !== jam.last?.id).length > 0 && (
        <div className="jam-earlier">
          <small>{t('jam.earlier')}</small>
          {jam.answers
            .filter((a) => a.id !== jam.last?.id)
            .slice(-5)
            .reverse()
            .map((a) => (
              <button key={a.id} className="mini" onClick={() => run('keep_phrase', { phrase_id: a.id })} title={t('jam.keepThis')}>
                {t('jam.keepBar', { bar: +(a.startBeat / BEATS_PER_BAR + 1).toFixed(2) })}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** E5: a live jam with an engine that streams audio (stream.jam). */
export function LiveJamSection() {
  const t = useT();
  const lj = useLiveJam();
  const hasEngines = useBridge((b) => b.engines);
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [engine, setEngine] = useState('');
  const [style, setStyle] = useState(lj.style);
  const [intensity, setIntensity] = useState(lj.intensity);
  useEffect(() => {
    if (!hasEngines) return void setEngines([]);
    let alive = true;
    streamEngines().then((e) => alive && setEngines(e), () => alive && setEngines([]));
    return () => void (alive = false);
  }, [hasEngines]);
  const live = lj.status === 'live';
  const s = lj.stats;
  return (
    <div className={`jam live-jam ${live ? 'on' : ''}`}>
      <div className="ai-share">
        <span>
          {t('lj.title')}
          <small>{t('lj.hint')}</small>
        </span>
      </div>
      {engines && !engines.length && <small className="muted">{t('lj.none')}</small>}
      {!!engines?.length && (
        <>
          <div className="jam-row">
            <select className="ver-input" value={engine || engines[0].id} disabled={lj.status !== 'off'} onChange={(e) => setEngine(e.target.value)} title={t('lj.engine')}>
              {engines.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.manifest.engine.name}
                </option>
              ))}
            </select>
            <label className="lj-record">
              <input type="checkbox" checked={lj.recording} disabled={lj.status !== 'off'} onChange={(e) => useLiveJam.setState({ recording: e.target.checked })} />
              {t('lj.record')}
            </label>
          </div>
          <div className="jam-row">
            <input className="ver-input" value={style} placeholder={t('lj.style')} onChange={(e) => setStyle(e.target.value)} />
          </div>
          <div className="jam-row">
            <label className="lj-intensity">
              {t('lj.intensity')}
              <input type="range" min={0} max={1} step={0.05} value={intensity} onChange={(e) => setIntensity(Number(e.target.value))} />
            </label>
          </div>
          <div className="jam-row">
            {lj.status === 'off' && (
              <button className="btn primary" onClick={() => run('start_live_jam', { engine: engine || engines[0].id, style, intensity, record: lj.recording })}>
                {t('lj.start')}
              </button>
            )}
            {lj.status === 'opening' && <span className="muted">{t('lj.opening')}</span>}
            {live && (
              <>
                <button className="btn" onClick={() => run('steer_live_jam', { style, intensity })}>
                  {t('lj.steer')}
                </button>
                <button className="btn primary" onClick={() => run('stop_live_jam', { keep: true })}>
                  {t('lj.stop')}
                </button>
                <button className="btn" onClick={() => run('stop_live_jam', { keep: false })}>
                  {t('lj.discard')}
                </button>
              </>
            )}
          </div>
          {live && (
            <div className="jam-status answering">
              <span className="jam-dot" />
              {t('lj.stats', { lead: s.leadMs, rtt: s.rttMs ?? '–', under: s.underruns, late: s.late, sec: s.seconds })}
            </div>
          )}
          {live && s.genMs !== null && s.genMs > 40 && <small className="warn">{t('lj.slow', { ms: s.genMs })}</small>}
          {lj.error && lj.status === 'off' && <small className="warn">{lj.error}</small>}
        </>
      )}
    </div>
  );
}

/** The last answer as ghost notes over the region it falls in. */
export function JamGhosts({ region, ppb, high, rowH }: { region: Region; ppb: number; high: number; rowH: number }) {
  const last = useJam((j) => j.last);
  if (!last || last.trackId !== region.trackId) return null;
  const off = last.startBeat - region.start;
  if (off >= region.length || off + phraseLength(last.notes) <= 0) return null;
  return (
    <>
      {last.notes.map((n, i) => (
        <div key={i} className="pr-jam" style={{ left: (n.start + off) * ppb, top: (high - n.pitch) * rowH, width: Math.max(4, n.duration * ppb - 1), height: rowH - 1 }} />
      ))}
    </>
  );
}

export function KeepAnswerButton({ region }: { region: Region }) {
  const last = useJam((j) => j.last);
  const t = useT();
  if (!last || last.trackId !== region.trackId) return null;
  return (
    <button className="mini eb-explain jam-keep" onClick={() => run('keep_answer')}>
      {t('jam.keepShort')}
    </button>
  );
}
