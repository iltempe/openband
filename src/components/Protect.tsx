// Protect, in the Release tab (G7): a proof the song existed at a date (OpenTimestamps, in Bitcoin), what it
// is and isn't, the timestamps of this song, the Proof package, and verifying any file with its .ots.
import { useState } from 'react';
import { useStore } from '../store';
import { useT } from '../i18n';
import { useBridge } from '../bridge';
import { runCommand } from '../commands';
import { PARTS, type Part } from '../protect/protect';

const notify = (m: string) => useStore.getState().notify(m);
const b64 = async (f: File) => {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export function ProtectSection() {
  const t = useT();
  const available = useBridge((s) => s.protect);
  const list = useStore((s) => s.project.protections ?? []);
  const [include, setInclude] = useState<Part[]>([...PARTS]);
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<{ file?: File; ots?: File }>({});
  const run = async (key: string, m: string, a: Record<string, unknown>, done?: (r: Record<string, unknown>) => void) => {
    setBusy(key);
    try {
      const r = (await runCommand(m, a, 'ui')) as Record<string, unknown>;
      done?.(r);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="rel-protect">
      <h4>{t('pr.title')}</h4>
      <details className="pr-what">
        <summary>{t('pr.whatTitle')}</summary>
        <p>{t('pr.what1')}</p>
        <p>{t('pr.what2')}</p>
        <p>{t('pr.what3')}</p>
        <p className="ca-note">{t('pr.notLegal')}</p>
      </details>
      {!available ? (
        <p className="ca-note">{t('pr.needsLocal')}</p>
      ) : (
        <>
          <div className="pr-parts">
            {PARTS.map((p) => (
              <label key={p}>
                <input type="checkbox" checked={include.includes(p)} onChange={(e) => setInclude(e.target.checked ? [...include, p] : include.filter((x) => x !== p))} /> {t(`pr.part.${p}` as never)}
              </label>
            ))}
          </div>
          <button className="btn primary" disabled={!!busy || !include.length} onClick={() => void run('stamp', 'timestamp_work', { include }, () => notify(t('pr.stamped')))}>
            {busy === 'stamp' ? t('pr.stamping') : t('pr.stamp')}
          </button>
        </>
      )}
      {list.length > 0 && (
        <ul className="rel-material">
          {[...list].reverse().map((x) => (
            <li key={x.id}>
              <span className={`en-badge ${x.state === 'confirmed' ? 'lic-yes' : 'lic-conditional'}`}>{x.state === 'confirmed' ? t('pr.confirmed', { block: x.height ?? '?' }) : t('pr.pending')}</span> {new Date(x.at).toLocaleString()} · {x.includes.map((p) => t(`pr.part.${p}` as never)).join(', ')}
              {x.blockTime && <div className="ca-note">{t('pr.existed', { date: new Date(x.blockTime * 1000).toLocaleString() })}</div>}
              <div className="row">
                <button className="mini" disabled={!!busy || !available} onClick={() => void run(`v${x.id}`, 'verify_timestamp', { protection_id: x.id }, (r) => notify(r.verified ? t('pr.verified', { block: String(r.bitcoin_block) }) : String(r.reason ?? t('pr.notYet'))))}>
                  {busy === `v${x.id}` ? '…' : t('pr.verify')}
                </button>
                <button className="mini" disabled={!!busy} onClick={() => void run(`p${x.id}`, 'export_proof_package', { protection_id: x.id })}>
                  {t('pr.package')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {available && (
        <div className="pr-check">
          <span className="ca-note">{t('pr.checkAny')}</span>
          <label className="mini">
            {check.file?.name ?? t('pr.pickFile')}
            <input type="file" hidden onChange={(e) => setCheck({ ...check, file: e.target.files?.[0] })} />
          </label>
          <label className="mini">
            {check.ots?.name ?? t('pr.pickOts')}
            <input type="file" accept=".ots" hidden onChange={(e) => setCheck({ ...check, ots: e.target.files?.[0] })} />
          </label>
          <button
            className="mini"
            disabled={!check.file || !check.ots || !!busy}
            onClick={async () => void run('any', 'verify_timestamp', { file_base64: await b64(check.file!), ots_base64: await b64(check.ots!) }, (r) => notify(r.verified ? t('pr.verifiedAny', { block: String(r.bitcoin_block), date: String(r.existed_by ?? '') }) : String(r.reason ?? t('pr.notYet'))))}
          >
            {t('pr.verify')}
          </button>
        </div>
      )}
    </div>
  );
}
