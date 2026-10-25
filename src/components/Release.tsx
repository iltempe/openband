// The release (G6): what the song says about itself, its licence chosen in three answers, the material it
// contains with their licences, the cover, the checks per platform, and the Release Kit.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useT, useLang } from '../i18n';
import { runCommand } from '../commands';
import { LICENSES, chooseLicense, explain, IRREVOCABLE, COLLECTING_SOCIETY, type LicenseCode } from '../publish/license';
import { COVER_STYLES, PALETTES, drawCover } from '../publish/cover';
import { getRelease, checkReleaseCommand } from '../publish/commands';
import { useVideo, type VideoFormat } from '../publish/video';

const run = (m: string, a: Record<string, unknown>) => runCommand(m, a, 'ui').catch((e) => useStore.getState().notify((e as Error).message));

function Cover({ title, artist }: { title: string; artist?: string }) {
  const cover = useStore((s) => s.project.release?.cover);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current?.getContext('2d');
    if (!c) return;
    if (cover?.kind === 'image') {
      const img = new Image();
      img.onload = () => c.drawImage(img, 0, 0, 220, 220);
      img.src = cover.dataUrl;
    } else drawCover(c, 220, cover?.kind === 'generated' ? cover : { style: 'bold', palette: 'night', seed: 1 }, { title, artist });
  }, [cover, title, artist]);
  return <canvas ref={ref} width={220} height={220} className="rel-cover" />;
}

export function ReleasePanel() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const project = useStore((s) => s.project);
  const info = getRelease();
  const r = info.release;
  const check = checkReleaseCommand();
  const lic = LICENSES[r.license as LicenseCode];
  const [ans, setAns] = useState({ commercial: true, derivatives: true, share_alike: false, public_domain: false });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => void run('set_release', { [k]: v });
  const cover = project.release?.cover;
  const field = (k: 'title' | 'artist' | 'genre' | 'date' | 'contact', label: string) => (
    <label className="rel-field">
      {label}
      <input defaultValue={r[k] ?? ''} key={`${k}${r[k]}`} onBlur={(e) => e.target.value !== (r[k] ?? '') && set(k, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
    </label>
  );
  return (
    <div className="release-panel">
      <section className="rel-col">
        <h4>{t('rel.about')}</h4>
        {field('title', t('rel.title'))}
        {field('artist', t('rel.artist'))}
        {field('genre', t('rel.genre'))}
        <label className="rel-field">
          {t('rel.tags')}
          <input defaultValue={(r.tags ?? []).join(', ')} key={`tags${(r.tags ?? []).join()}`} onBlur={(e) => set('tags', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} onKeyDown={(e) => e.stopPropagation()} />
        </label>
        {field('date', t('rel.date'))}
        {field('contact', t('rel.contact'))}
        <label className="rel-field">
          {t('rel.description')}
          <textarea defaultValue={r.description ?? ''} key={`d${r.description}`} onBlur={(e) => set('description', e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </label>
      </section>
      <section className="rel-col">
        <h4>{t('rel.license')}</h4>
        <div className="rel-current">
          <b>{lic?.name}</b> — {explain(r.license as LicenseCode, lang)}
          {lic?.url && (
            <a href={lic.url} target="_blank" rel="noreferrer">
              {' '}
              {t('rel.deed')}
            </a>
          )}
        </div>
        <div className="rel-questions">
          <label>
            <input type="checkbox" checked={ans.commercial} onChange={(e) => setAns({ ...ans, commercial: e.target.checked })} /> {t('rel.qCommercial')}
          </label>
          <label>
            <input type="checkbox" checked={ans.derivatives} onChange={(e) => setAns({ ...ans, derivatives: e.target.checked })} /> {t('rel.qDerivatives')}
          </label>
          <label>
            <input type="checkbox" checked={ans.share_alike} disabled={!ans.derivatives} onChange={(e) => setAns({ ...ans, share_alike: e.target.checked })} /> {t('rel.qShareAlike')}
          </label>
          <label>
            <input type="checkbox" checked={ans.public_domain} onChange={(e) => setAns({ ...ans, public_domain: e.target.checked })} /> {t('rel.qPublicDomain')}
          </label>
          <div className="row">
            <button className="btn" onClick={() => set('choose', ans)}>
              {t('rel.use', { name: LICENSES[chooseLicense({ commercial: ans.commercial, derivatives: ans.derivatives, shareAlike: ans.share_alike, publicDomain: ans.public_domain })].name })}
            </button>
            <button className="mini" onClick={() => set('license', 'all-rights-reserved')}>
              {t('rel.arr')}
            </button>
          </div>
          {lic?.cc && (
            <p className="ca-note">
              {IRREVOCABLE[lang]} {COLLECTING_SOCIETY[lang]}
            </p>
          )}
        </div>
        <h4>{t('rel.material')}</h4>
        <ul className="rel-material">
          {info.materials.map((m) => (
            <li key={`${m.kind}${m.name}`}>
              <span className="en-badge">{t(`rel.kind.${m.kind}` as never)}</span> {m.name}{' '}
              {m.kind === 'sample' ? (
                <select value={m.license} onChange={(e) => run('set_release', { sample_licenses: { [m.sampleId!]: e.target.value } })}>
                  <option value="unknown">{t('rel.unknown')}</option>
                  {Object.values(LICENSES).map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="ca-note">{m.license === 'own' ? t('rel.own') : m.license}</span>
              )}
            </li>
          ))}
          {!info.materials.length && <li className="ca-note">{t('rel.noMaterial')}</li>}
        </ul>
      </section>
      <section className="rel-col">
        <h4>{t('rel.cover')}</h4>
        <Cover title={r.title} artist={r.artist} />
        <div className="row">
          <select value={cover?.kind === 'generated' ? cover.style : 'bold'} onChange={(e) => void run('generate_cover', { style: e.target.value, palette: cover?.kind === 'generated' ? cover.palette : 'night', seed: cover?.kind === 'generated' ? cover.seed : 1 })}>
            {COVER_STYLES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select value={cover?.kind === 'generated' ? cover.palette : 'night'} onChange={(e) => void run('generate_cover', { style: cover?.kind === 'generated' ? cover.style : 'bold', palette: e.target.value, seed: cover?.kind === 'generated' ? cover.seed : 1 })}>
            {Object.keys(PALETTES).map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <button className="mini" onClick={() => void run('generate_cover', { style: cover?.kind === 'generated' ? cover.style : 'bold', palette: cover?.kind === 'generated' ? cover.palette : 'night' })}>
            {t('rel.another')}
          </button>
        </div>
        <h4>{t('rel.ai')}</h4>
        <textarea className="rel-ai" defaultValue={r.aiDisclosure} key={r.aiDisclosure} onBlur={(e) => set('ai_disclosure', e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </section>
      <section className="rel-col">
        <h4>{t('rel.where')}</h4>
        <ul className="rel-platforms">
          {info.platforms.map((pl) => {
            const issues = check.issues.filter((i) => i.platform === pl.id || (i.platform === null && i.severity === 'error'));
            const ok = check.ready.includes(pl.id);
            return (
              <li key={pl.id} className={ok ? 'ok' : 'blocked'}>
                <b>{pl.name}</b> <span className="en-badge">{ok ? t('rel.ready') : t('rel.blocked')}</span>
                {issues.filter((i) => i.severity !== 'info' || i.platform === pl.id).map((i) => (
                  <div key={i.code + i.message} className={`rel-issue ${i.severity}`}>
                    {i.message}
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
        {check.publish_in_cc && <p className="ca-note">{t('rel.ccTargets', { list: check.publish_in_cc.join(', ') })}</p>}
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void run('export_release_kit', {}).finally(() => setBusy(false));
          }}
        >
          {busy ? '…' : t('rel.kit')}
        </button>
        <VideoMaker />
      </section>
    </div>
  );
}

function VideoMaker() {
  const t = useT();
  const v = useVideo();
  const [format, setFormat] = useState<VideoFormat>('16:9');
  return (
    <div className="rel-video">
      <h4>{t('rel.video')}</h4>
      <div className="row">
        <select value={format} onChange={(e) => setFormat(e.target.value as VideoFormat)} disabled={v.progress !== null}>
          <option value="16:9">{t('rel.video169')}</option>
          <option value="9:16">{t('rel.video916')}</option>
        </select>
        <button className="btn" disabled={v.progress !== null} onClick={() => void run('render_video', { format })}>
          {v.progress !== null ? t('rel.videoMaking', { pct: Math.round(v.progress * 100) }) : t('rel.videoMake')}
        </button>
      </div>
      {v.progress !== null && <progress className="rel-progress" value={v.progress} />}
      {v.url && v.progress === null && <video className={`rel-preview ${v.format === '9:16' ? 'tall' : ''}`} src={v.url} controls />}
    </div>
  );
}
