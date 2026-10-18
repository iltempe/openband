// Reference track UI: a strip in the mixer (load, A/B, loudness match, compare) and the comparison
// card in the Analysis panel (1/3-octave curves of mix and reference, differences, suggestions).
import { useStore } from '../store';
import { runCommand } from '../commands';
import { setAB, useReference } from '../reference';
import { THIRD_OCTAVES } from '../analysis/spectrum';
import type { MasterProfile } from '../analysis/reference';
import { pickFiles } from './ImportUI';
import { useT, type MessageKey } from '../i18n';

const notify = (e: unknown) => useStore.getState().notify((e as Error).message);
const toBase64 = async (f: File) => {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export async function loadReferenceFile() {
  const [f] = await pickFiles('audio/*');
  if (!f) return;
  try {
    await runCommand('import_reference', { filename: f.name, data_base64: await toBase64(f) }, 'ui');
  } catch (e) {
    notify(e);
  }
}

export const compareNow = () => {
  useStore.getState().set({ bottom: 'analysis' });
  runCommand('compare_to_reference', {}, 'ui').catch(notify);
};

export function ReferenceStrip() {
  const ref = useStore((s) => s.project.reference);
  const commit = useStore((s) => s.commit);
  const { ab, busy } = useReference();
  const t = useT();
  return (
    <div className={`strip ref-strip ${ab ? 'listening' : ''}`}>
      <div className="strip-knobs master-title">{t('ref.title')}</div>
      {ref ? (
        <>
          <div className="ref-name" title={ref.name}>
            {ref.name}
          </div>
          <div className="ref-ab" role="group" title={t('ref.abHint')}>
            <button className={!ab ? 'on' : ''} onClick={() => setAB(false)}>
              A
            </button>
            <button className={ab ? 'on' : ''} onClick={() => setAB(true)}>
              B
            </button>
          </div>
          <label className="ref-match" title={t('ref.matchHint')}>
            <input type="checkbox" checked={ref.loudnessMatched} onChange={(e) => commit((d) => void (d.reference!.loudnessMatched = e.target.checked))} />
            LUFS
          </label>
          <button className="mini" disabled={busy} onClick={compareNow}>
            {busy ? '…' : t('ref.compare')}
          </button>
          <button className="mini ref-x" onClick={() => runCommand('clear_reference', {}, 'ui')} title={t('ref.clear')}>
            ×
          </button>
        </>
      ) : (
        <>
          <div className="ref-empty">{t('ref.empty')}</div>
          <button className="mini" onClick={loadReferenceFile}>
            {t('ref.load')}
          </button>
        </>
      )}
      <div className="strip-name">{ab ? t('ref.hearingB') : t('ref.hearingA')}</div>
    </div>
  );
}

const W = 520;
const H = 150;
const PAD = 26;

function curve(p: MasterProfile) {
  // Relative to loudness, so both curves are compared at the same level.
  return p.third_octaves_db.map((v) => (v <= -119 ? NaN : v - p.lufs_integrated));
}

export function ReferenceCard() {
  const { comparison, mix } = useReference();
  const ref = useStore((s) => s.project.reference);
  const t = useT();
  if (!comparison || !mix || !ref?.analysis) return null;
  const refProfile = ref.analysis as unknown as MasterProfile;
  const a = curve(mix);
  const b = curve(refProfile);
  const vals = [...a, ...b].filter(Number.isFinite);
  const hi = Math.ceil(Math.max(...vals) / 6) * 6;
  const lo = hi - 48;
  const x = (i: number) => PAD + (i / (THIRD_OCTAVES.length - 1)) * (W - PAD - 6);
  const y = (v: number) => 6 + ((hi - Math.max(lo, Math.min(hi, v))) / (hi - lo)) * (H - 22);
  const path = (c: number[]) => c.map((v, i) => (Number.isFinite(v) ? `${i && Number.isFinite(c[i - 1]) ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`: '')).join('');
  const c = comparison;
  const sign = (v: number, u = '') => `${v > 0 ? '+' : ''}${v}${u}`;
  return (
    <div className="an-card an-ref">
      <div className="an-title">
        {t('ref.vs', { name: ref.name })}
        <span className="ref-legend">
          <i className="mix" /> Mix <i className="ref" /> {t('ref.title')}
        </span>
      </div>
      <div className="ref-layout">
      <svg viewBox={`0 0 ${W} ${H}`} className="ref-curves">
        {[0, 1, 2, 3, 4].map((k) => (
          <line key={k} x1={PAD} x2={W - 6} y1={y(hi - k * 12)} y2={y(hi - k * 12)} className="grid" />
        ))}
        {[50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000].map((f) => {
          const i = THIRD_OCTAVES.findIndex((q) => q >= f);
          return (
            <text key={f} x={x(i)} y={H - 4} textAnchor="middle">
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          );
        })}
        <path d={path(b)} className="ref" />
        <path d={path(a)} className="mix" />
      </svg>
      <div className="ref-text">
      <div className="ref-stats">
        <span>
          {t('ref.loudness')} <b>{sign(c.loudness_diff_lu, ' LU')}</b>
        </span>
        <span>
          {t('ref.crest')} <b>{sign(c.crest_diff_db, ' dB')}</b>
        </span>
        <span>
          {t('ref.width')} <b>{sign(c.width_diff)}</b>
        </span>
      </div>
      <div className="ref-bands">
        {Object.entries(c.tonal_diff_db).map(([band, v]) => (
          <span key={band} className={Math.abs(v) >= 1.5 ? (v < 0 ? 'less' : 'more') : ''}>
            {t(`an.band.${band}` as MessageKey)} <b>{sign(v)}</b>
          </span>
        ))}
      </div>
      {c.suggestions.map((s, i) => (
        <div key={i} className="ref-sugg">
          {s.gain_db !== undefined && <b>{sign(s.gain_db, ' dB')}</b>} {s.reason}
        </div>
      ))}
      </div>
      </div>
    </div>
  );
}
