// Clips panel (C3.7): a 9:16 video from any part of the song. It exports the file: posting it is yours.
import { useMemo, useState } from 'react';
import { useT } from '../i18n';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { useVideo } from '../publish/video';
import { LOOKS, suggestClips, type ClipSource, type ClipSuggestion, type Look } from '../publish/clips';
import { CLIP_PRESETS } from '../publish/platforms';
import { startCameraTake, stopCameraTake } from '../publish/camera';

const notify = (e: unknown) => useStore.getState().notify((e as Error).message);

export function ClipsPanel() {
  const t = useT();
  const project = useStore((s) => s.project);
  const [source, setSource] = useState<string>('song');
  const [look, setLook] = useState<Look>('pianoroll');
  const [loop, setLoop] = useState(true);
  const [title, setTitle] = useState('');
  const [seconds, setSeconds] = useState(20);
  const [preset, setPreset] = useState('tiktok');
  const [filming, setFilming] = useState(false);
  const [suggested, setSuggested] = useState<ClipSuggestion[]>([]);
  const progress = useVideo((s) => s.progress);
  const url = useVideo((s) => s.url);
  const sourceOf = useMemo(
    () =>
      (v: string): ClipSource => {
        const [kind, id] = v.split(':');
        if (kind === 'section') return { kind: 'section', section_id: id };
        if (kind === 'track') return { kind: 'track', track_id: id, context: 'focus' };
        return { kind: 'song' };
      },
    [],
  );
  const make = (src: ClipSource, lk: Look, hook: string) => runCommand('render_video', { format: '9:16', source: src, look: lk, loop, title: hook || undefined, platform_preset: preset, max_seconds: seconds }, 'ui');
  const queue = async () => {
    for (const s of suggested) await make(s.source, s.look, s.title);
  };
  const share = async () => {
    const blob = await (await fetch(url!)).blob();
    const file = new File([blob], `${project.name}.mp4`, { type: 'video/mp4' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
    else useStore.getState().notify(t('cl.noShare'));
  };
  return (
    <div className="pj-panel">
      <section className="pj-link">
        <h4>{t('cl.tab')}</h4>
        <select className="pj-input" aria-label={t('cl.source')} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="song">{t('cl.song')}</option>
          {project.sections?.map((s) => (
            <option key={s.id} value={`section:${s.id}`}>{s.name}</option>
          ))}
          {project.tracks.map((x) => (
            <option key={x.id} value={`track:${x.id}`}>{t('cl.track', { name: x.name })}</option>
          ))}
        </select>
        <select className="pj-input" aria-label={t('cl.look')} value={look} onChange={(e) => setLook(e.target.value as Look)}>
          {LOOKS.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <select className="pj-input" aria-label={t('cl.preset')} value={preset} onChange={(e) => setPreset(e.target.value)}>
          {CLIP_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input className="pj-input" aria-label={t('cl.hook')} placeholder={t('cl.hook')} value={title} onChange={(e) => setTitle(e.target.value)} />
        <label className="pj-meta">
          {t('cl.seconds', { n: seconds })}
          <input type="range" min={5} max={60} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
        </label>
        <label className="pj-meta">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> {t('cl.loop')}
        </label>
        <button className="btn" onClick={() => void (filming ? stopCameraTake().then(() => setFilming(false)) : startCameraTake().then(() => setFilming(true))).catch(notify)}>
          {filming ? t('cl.stopCamera') : t('cl.camera')}
        </button>
        <button className="btn" disabled={progress !== null} onClick={() => void Promise.resolve(make(sourceOf(source), look, title)).catch(notify)}>
          {progress !== null ? `${Math.round(progress * 100)}%` : t('cl.export')}
        </button>
      </section>
      <section style={{ gridColumn: 'span 2' }}>
        <button className="btn" onClick={() => setSuggested(suggestClips(project, seconds))}>{t('cl.suggest')}</button>
        {!!suggested.length && <button className="btn" onClick={() => void queue().catch(notify)}>{t('cl.makeAll')}</button>}
        {suggested.map((s) => (
          <div className="pj-row" key={`${s.from}`}>
            <b>{s.why}</b>
            <p className="pj-meta">
              {Math.round(s.from)}–{Math.round(s.to)} s · {s.look} · {s.hashtags.join(' ')}
            </p>
            <button className="btn" onClick={() => void Promise.resolve(make(s.source, s.look, s.title)).catch(notify)}>{t('cl.export')}</button>
          </div>
        ))}
        {url && (
          <div>
            <video src={url} controls playsInline style={{ height: 260 }} aria-label={t('cl.preview')} />
            <div className="pj-actions">
              <button className="btn" onClick={() => void share().catch(notify)}>{t('cl.share')}</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
