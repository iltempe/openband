// Analysis panel: what analyze_mix hears — loudness, bands, tracks, masking, issues, spectrogram.
import { useStore } from '../store';
import { runCommand } from '../commands';
import { useAnalysis } from '../mixAnalysis';
import { useT, type MessageKey } from '../i18n';
import * as I from './Icons';
import { ReferenceCard, compareNow, loadReferenceFile } from './Reference';
import { useReference } from '../reference';

interface Issue {
  severity: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  suggestion: string;
  tracks?: string[];
  params?: Record<string, string | number>;
}
interface Result {
  range: { from_bar: number; to_bar: number };
  master: Record<string, number> & { bands_db: Record<string, number> };
  tracks: { id: string; name: string; lufs: number; peak_db: number; dominant_band: string; share_of_mix: number }[];
  masking: { a: string; b: string; band: string; score: number }[];
  key: { detected: string; project: string; confidence: number } | null;
  issues: Issue[];
}

const BAND_ORDER = ['sub', 'bass', 'lowmid', 'mid', 'highmid', 'presence', 'air'];
const fmt = (x: number, unit = '') => (x <= -900 ? '−∞' : `${x > 0 ? '+' : ''}${x.toFixed(1)}${unit}`);

export async function runAnalysis(loopOnly = false) {
  const p = useStore.getState().project;
  const args = loopOnly && p.loop.enabled ? { from_bar: p.loop.start / 4 + 1, to_bar: p.loop.end / 4 + 1 } : {};
  try {
    await runCommand('analyze_mix', args, 'ui');
  } catch (e) {
    useStore.getState().notify((e as Error).message);
  }
}

export function AnalysisPanel() {
  const { result, running, error, spectrogram, harmony } = useAnalysis();
  const loop = useStore((s) => s.project.loop);
  const set = useStore((s) => s.set);
  const t = useT();
  const comparison = useReference((x) => x.comparison);
  const hasRef = useStore((s) => !!s.project.reference);
  const r = result as unknown as Result | null;
  const issueText = (i: Issue) => {
    const k = `iss.${i.code}` as MessageKey;
    const msg = t(k, i.params);
    return msg === k ? { msg: i.message, fix: i.suggestion } : { msg, fix: t(`iss.${i.code}.fix` as MessageKey, i.params) };
  };

  return (
    <div className="analysis">
      <div className="analysis-bar">
        <button className="btn primary" disabled={running} onClick={() => runAnalysis(false)}>
          <I.Wave width={14} height={14} /> {running ? t('an.running') : t('an.run')}
        </button>
        <button className="btn" disabled={running || !loop.enabled} onClick={() => runAnalysis(true)} title={t('an.loopHint')}>
          {t('an.runLoop')}
        </button>
        <button
          className="btn"
          disabled={running}
          onClick={() => runCommand('render_spectrogram', loop.enabled ? { from_bar: loop.start / 4 + 1, to_bar: loop.end / 4 + 1 } : {}, 'ui').catch((e) => useStore.getState().notify((e as Error).message))}
        >
          {t('an.spectrogram')}
        </button>
        <button className="btn" onClick={() => runCommand('analyze_harmony', {}, 'ui').catch((e) => useStore.getState().notify((e as Error).message))}>
          {t('an.chords')}
        </button>
        <button className="btn" onClick={() => (hasRef ? compareNow() : void loadReferenceFile())} title={t('ref.hint')}>
          {hasRef ? t('ref.compare') : t('ref.load')}
        </button>
        {r && <span className="analysis-range">{t('an.range', { from: r.range.from_bar, to: r.range.to_bar })}</span>}
        {error && <span className="wave-missing">{error}</span>}
      </div>
      {harmony && (
        <div className="an-chords">
          {harmony.chords.map((c, i) => (
            <span key={i} className={`an-chord ${c.function}`} title={`${t('an.bar')} ${c.bar}${c.beat > 1 ? `.${c.beat}` : ''} · ${c.function} · ${Math.round(c.confidence * 100)}%`}>
              <strong>{c.chord}</strong>
              <small>{c.roman}</small>
            </span>
          ))}
          {harmony.cadences.map((c, i) => (
            <span key={`c${i}`} className="an-cadence">
              {t(`an.cad.${c.type}` as MessageKey)} · {t('an.bar')} {c.bar}
              {c.section ? ` (${c.section})` : ''}
            </span>
          ))}
        </div>
      )}
      {!r && !comparison ? (
        <div className="panel-empty">
          <I.Wave width={28} height={28} />
          <p>{t('an.empty')}</p>
        </div>
      ) : (
        <div className="analysis-body">
          <ReferenceCard />
          {r && (
          <>
          <div className="an-card an-master">
            <div className="an-big">
              {fmt(r.master.lufs_integrated)}
              <small>LUFS</small>
            </div>
            <div className="an-target">{t('an.target')}</div>
            <dl>
              <dt>{t('an.short')}</dt>
              <dd>{fmt(r.master.lufs_short_max)} LUFS</dd>
              <dt>{t('an.truePeak')}</dt>
              <dd className={r.master.true_peak_dbtp > -1 ? 'bad' : ''}>{fmt(r.master.true_peak_dbtp)} dBTP</dd>
              <dt>LRA</dt>
              <dd>{r.master.lra.toFixed(1)} LU</dd>
              <dt>{t('an.crest')}</dt>
              <dd>{r.master.crest_db.toFixed(1)} dB</dd>
              <dt>{t('an.correlation')}</dt>
              <dd className={r.master.correlation < 0 ? 'bad' : ''}>{r.master.correlation.toFixed(2)}</dd>
              {r.key && (
                <>
                  <dt>{t('an.key')}</dt>
                  <dd>
                    {r.key.detected} <small>({Math.round(r.key.confidence * 100)}%)</small>
                  </dd>
                </>
              )}
            </dl>
          </div>
          <div className="an-card an-bands">
            <div className="an-title">{t('an.bands')}</div>
            <div className="an-band-bars">
              {BAND_ORDER.map((b) => {
                const v = r.master.bands_db[b];
                const h = Math.max(2, Math.min(100, ((v + 70) / 60) * 100));
                return (
                  <div key={b} className="an-band" title={`${v} dB`}>
                    <div className="an-band-fill" style={{ height: `${h}%` }} />
                    <span>{t(`an.band.${b}` as MessageKey)}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="an-card an-tracks">
            <div className="an-title">{t('an.tracks')}</div>
            {r.tracks.map((tr) => (
              <button key={tr.id} className="an-track" onClick={() => set({ selectedTrackId: tr.id })}>
                <span className="an-track-name">{tr.name}</span>
                <span className="an-share">
                  <span style={{ width: `${tr.share_of_mix * 100}%` }} />
                </span>
                <span className="an-num">{fmt(tr.lufs)}</span>
                <span className="an-dim">{t(`an.band.${tr.dominant_band}` as MessageKey)}</span>
              </button>
            ))}
          </div>
          <div className="an-card an-issues">
            <div className="an-title">{t('an.issues', { n: r.issues.length })}</div>
            {!r.issues.length && <div className="an-dim">{t('an.noIssues')}</div>}
            {r.issues.map((i, k) => {
              const { msg, fix } = issueText(i);
              return (
                <button key={k} className={`an-issue ${i.severity}`} onClick={() => i.tracks?.[0] && set({ selectedTrackId: i.tracks[0] })}>
                  <span className="an-sev" />
                  <span>
                    <strong>{msg}</strong>
                    <small>{fix}</small>
                  </span>
                </button>
              );
            })}
          </div>
          {spectrogram && <img className="an-spectrogram" alt="" src={`data:image/png;base64,${spectrogram}`} />}
          </>
          )}
        </div>
      )}
    </div>
  );
}
