// The loop browser (F24): CC0 loops filtered by words, tempo and key, previewed at the song's tempo
// (and key), added at the playhead as clips that follow the tempo.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { addLoop, loadManifest, previewLoop, stopPreview, useLoops } from '../loopsLive';
import { searchLoops } from '../loops';
import { useT } from '../i18n';
import * as I from './Icons';

export function LoopBrowser() {
  const t = useT();
  const { manifest, error, previewing } = useLoops();
  const bpm = useStore((s) => s.project.bpm);
  const key = useStore((s) => s.project.key);
  const notify = useStore((s) => s.notify);
  const [query, setQuery] = useState('');
  const [nearTempo, setNearTempo] = useState(false);
  const [inKey, setInKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void loadManifest().catch(() => {});
    return () => stopPreview();
  }, []);
  if (error) return <div className="lib-empty">{error}</div>;
  if (!manifest) return <div className="lib-empty">…</div>;
  const list = searchLoops(manifest, { query, bpm: nearTempo ? bpm : undefined, key: inKey ? key : undefined, limit: 50 }).filter((l) => !inKey || !l.key || l.key === key || /m$/.test(l.key) === /m$/.test(key));
  const tags = [...new Set(manifest.loops.flatMap((l) => l.tags))].slice(0, 10);
  return (
    <div className="loops">
      <input className="ver-input loops-search" placeholder={t('loops.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="loops-filters">
        <label>
          <input type="checkbox" checked={nearTempo} onChange={(e) => setNearTempo(e.target.checked)} /> {t('loops.nearTempo', { bpm: Math.round(bpm) })}
        </label>
        <label>
          <input type="checkbox" checked={inKey} onChange={(e) => setInKey(e.target.checked)} /> {t('loops.inKey', { key })}
        </label>
      </div>
      <div className="loops-tags">
        {tags.map((tag) => (
          <button key={tag} className={`mini ${query === tag ? 'on' : ''}`} onClick={() => setQuery(query === tag ? '' : tag)}>
            {tag}
          </button>
        ))}
      </div>
      {list.map((l) => (
        <div key={l.id} className="loop-row">
          <button className={`icon-btn loop-play ${previewing === l.id ? 'on' : ''}`} onClick={() => void previewLoop(l.id).catch((e) => notify((e as Error).message))} title={t('loops.preview')}>
            {previewing === l.id ? <I.Pause width={13} height={13} /> : <I.Play width={13} height={13} />}
          </button>
          <div className="loop-info">
            <div className="loop-name">{l.name}</div>
            <div className="loop-meta">
              {l.bpm} BPM{l.key ? ` · ${l.key}` : ''} · {t('loops.bars', { n: l.bars })} · CC0
            </div>
          </div>
          <button
            className="mini"
            disabled={busy === l.id}
            onClick={() => {
              setBusy(l.id);
              addLoop(l.id)
                .then((r) => notify(t('loops.added', { name: r.loop })))
                .catch((e) => notify((e as Error).message))
                .finally(() => setBusy(null));
            }}
            title={t('loops.addHint')}
          >
            {busy === l.id ? '…' : t('loops.add')}
          </button>
        </div>
      ))}
      <div className="lib-sub loops-license">{t('loops.license')}</div>
    </div>
  );
}
