// Export the song as WAV (issue #3): sample rate and bit depth to choose, the last choice remembered.
import { useState } from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { useT } from '../i18n';
import { commands } from '../commands';
import { WAV_RATES } from '../audio/render';

const KEY = 'openband.wavFormat';
interface Choice {
  sample_rate: number;
  bit_depth: number;
  dither: boolean;
}
const remembered = (): Choice => {
  try {
    return { sample_rate: 44100, bit_depth: 16, dither: true, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { sample_rate: 44100, bit_depth: 16, dither: true };
  }
};

export const useWavExport = create<{ open: boolean }>(() => ({ open: false }));
export const openWavExport = () => useWavExport.setState({ open: true });

export function WavExport() {
  const t = useT();
  const open = useWavExport((s) => s.open);
  const [c, setC] = useState(remembered);
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const close = () => useWavExport.setState({ open: false });
  const go = async () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(c));
    } catch {
      // private mode: not remembered
    }
    setBusy(true);
    const s = useStore.getState();
    s.notify(t('menu.rendering'));
    try {
      await commands.export_wav(c);
      s.notify(t('menu.wavDone'));
      close();
    } catch (e) {
      s.notify(t('menu.wavFailed', { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="modal wav-export" role="dialog" aria-label={t('wav.title')}>
        <div className="modal-head">
          <div className="lib-title">{t('wav.title')}</div>
        </div>
        <div className="wav-export-body">
          <label className="mic-row">
            <span>{t('wav.rate')}</span>
            <select value={c.sample_rate} onChange={(e) => setC({ ...c, sample_rate: Number(e.target.value) })}>
              {WAV_RATES.map((r) => (
                <option key={r} value={r}>
                  {(r / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz
                </option>
              ))}
            </select>
          </label>
          <label className="mic-row">
            <span>{t('wav.bits')}</span>
            <select value={c.bit_depth} onChange={(e) => setC({ ...c, bit_depth: Number(e.target.value) })}>
              <option value={16}>16-bit</option>
              <option value={24}>24-bit</option>
              <option value={32}>{t('wav.float')}</option>
            </select>
          </label>
          {c.bit_depth === 16 && (
            <label className="mic-row">
              <span>{t('wav.dither')}</span>
              <input type="checkbox" checked={c.dither} onChange={(e) => setC({ ...c, dither: e.target.checked })} />
            </label>
          )}
          <p className="ca-note">{t('wav.hint')}</p>
          <div className="row">
            <button className="btn" onClick={close} disabled={busy}>
              {t('pub.cancel')}
            </button>
            <button className="btn primary" onClick={() => void go()} disabled={busy}>
              {busy ? '…' : t('wav.go')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
