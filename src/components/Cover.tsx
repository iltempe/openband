// "Make a cover" on an audio region (issue #2): the song played again in another style by a music engine
// that can restyle; the original and the cover become takes of the region.
import { useState } from 'react';
import { useT } from '../i18n';
import { runCommand } from '../commands';
import { useStore } from '../store';

const CLOSENESS = [
  { id: 'close', strength: 0.7 },
  { id: 'balanced', strength: 0.5 },
  { id: 'free', strength: 0.3 },
] as const;

export function CoverButton({ regionId }: { regionId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState('');
  const [closeness, setCloseness] = useState<(typeof CLOSENESS)[number]['id']>('balanced');
  const [variants, setVariants] = useState(1);
  const [busy, setBusy] = useState(false);
  const go = async (confirm_spend = false) => {
    setBusy(true);
    try {
      await runCommand('cover_song', { region_id: regionId, style, strength: CLOSENESS.find((c) => c.id === closeness)!.strength, variants, confirm_spend }, 'ui');
      useStore.getState().notify(t('cv.done'));
      setOpen(false);
    } catch (e) {
      const msg = (e as Error).message;
      // An online engine past the budget: the user decides, with the price in front of them.
      if (!confirm_spend && /confirm_spend/.test(msg) && window.confirm(msg.replace(/ Ask the user.*$/, ''))) return void (await go(true));
      useStore.getState().notify(msg);
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button className="mini" onClick={() => setOpen(true)} title={t('cv.hint')}>
        {t('cv.button')}
      </button>
    );
  return (
    <span className="cover-form">
      <input autoFocus placeholder={t('cv.placeholder')} value={style} onChange={(e) => setStyle(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === 'Enter' && style.trim() && void go())} />
      <select value={closeness} onChange={(e) => setCloseness(e.target.value as typeof closeness)} title={t('cv.closeness')}>
        {CLOSENESS.map((c) => (
          <option key={c.id} value={c.id}>
            {t(`cv.${c.id}` as never)}
          </option>
        ))}
      </select>
      <select value={variants} onChange={(e) => setVariants(Number(e.target.value))} title={t('cv.variants')}>
        {[1, 2, 3].map((n) => (
          <option key={n} value={n}>
            {n === 1 ? t('cv.one') : t('cv.many', { n })}
          </option>
        ))}
      </select>
      <button className="mini primary" disabled={busy || !style.trim()} onClick={() => void go()}>
        {busy ? t('cv.making') : t('cv.make')}
      </button>
      <button className="mini" disabled={busy} onClick={() => setOpen(false)}>
        ✕
      </button>
    </span>
  );
}
