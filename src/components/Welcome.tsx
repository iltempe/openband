// The welcome screen: start with music, not with a tutorial. Four choices (each click also unlocks
// audio), resume / demo, the template gallery, a light device check. Plus the tour card and the
// shortcuts sheet (?).
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useStore, hasSavedProject } from '../store';
import { engine } from '../audio/engine';
import { LANGS, setLang, t as tr, useLang, useT, type MessageKey } from '../i18n';
import { TEMPLATES } from '../templates';
import { beginTour, endTour, humAnIdea, measureLatency, openTemplate, surpriseMe, useDevices, useTour } from '../firstRun';
import { openProjectFile, pickFiles } from './ImportUI';
import { runCommand } from '../commands';
import { TOUR_STEPS } from '../tour';
import * as I from './Icons';

export const useOverlays = create<{ templates: boolean; shortcuts: boolean }>(() => ({ templates: false, shortcuts: false }));

const notify = (e: unknown) => useStore.getState().notify((e as Error).message);
const hadSave = hasSavedProject();

async function enter() {
  await engine.unlock();
  useStore.getState().set({ audioReady: true });
  // Non-blocking device check: say it plainly when the audio path is slow.
  const ms = measureLatency();
  if (ms > 60) useStore.getState().notify(tr('wel.latency', { ms }));
}

async function openAnyFile() {
  const [f] = await pickFiles('.openband,.json,.mid,.midi,application/json,audio/midi');
  if (!f) return;
  try {
    if (/\.midi?$/i.test(f.name)) await runCommand('import_midi_file', { file: f }, 'ui');
    else await openProjectFile(f);
  } catch (e) {
    notify(e);
  }
}

function Logo({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <defs>
        <linearGradient id="wg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff7a59" />
          <stop offset=".5" stopColor="#b14cff" />
          <stop offset="1" stopColor="#3cc8ff" />
        </linearGradient>
      </defs>
      <path d="M8 40c7 0 7-16 14-16s7 16 14 16 7-16 14-16" fill="none" stroke="url(#wg)" strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
}

export function Welcome() {
  const name = useStore((s) => s.project.name);
  const set = useStore((s) => s.set);
  const lang = useLang((s) => s.lang);
  const midi = useDevices((d) => d.midiInputs);
  const [busy, setBusy] = useState<string | null>(null);
  const t = useT();

  const go = (id: string, action: () => Promise<unknown>) => async () => {
    setBusy(id);
    try {
      await enter();
      await action();
      beginTour();
    } catch (e) {
      notify(e);
    } finally {
      setBusy(null);
    }
  };
  const cards: { id: string; emoji: string; title: MessageKey; sub: MessageKey; run: () => Promise<unknown> }[] = [
    { id: 'surprise', emoji: '🎲', title: 'wel.surprise', sub: 'wel.surpriseSub', run: () => surpriseMe() },
    { id: 'hum', emoji: '🎤', title: 'wel.hum', sub: 'wel.humSub', run: () => humAnIdea() },
    { id: 'ai', emoji: '🤖', title: 'wel.ai', sub: 'wel.aiSub', run: async () => set({ aiOpen: true }) },
    { id: 'file', emoji: '📂', title: 'wel.file', sub: 'wel.fileSub', run: () => openAnyFile() },
  ];
  return (
    <div className="splash welcome">
      <div className="splash-glow" />
      <div className="welcome-card">
        <div className="welcome-head">
          <Logo />
          <div>
            <h1>OpenBand</h1>
            <p>{t('splash.tagline')}</p>
          </div>
        </div>
        <div className="welcome-choices">
          {cards.map((c) => (
            <button key={c.id} className={`welcome-choice ${busy === c.id ? 'busy' : ''}`} disabled={!!busy} onClick={go(c.id, c.run)}>
              <span className="wc-emoji">{c.emoji}</span>
              <b>{t(c.title)}</b>
              <small>{t(c.sub)}</small>
            </button>
          ))}
        </div>
        <div className="welcome-more">
          <button className="btn primary" disabled={!!busy} onClick={go('enter', async () => undefined)}>
            {t('splash.enter')}
          </button>
          <span className="splash-sub">
            {hadSave ? t('wel.resume') : t('wel.demo')} <strong>{name}</strong>
          </span>
          <span className="eb-spacer" />
          <button className="btn" disabled={!!busy} onClick={() => useOverlays.setState({ templates: true })}>
            {t('wel.examples')}
          </button>
        </div>
        <div className="welcome-foot">
          <span className="welcome-device">{midi.length ? t('wel.midiFound', { names: midi.join(', ') }) : t('wel.noMidi')}</span>
          <span className="lang-switch">
            {LANGS.map((l) => (
              <button key={l.id} className={l.id === lang ? 'on' : ''} onClick={() => setLang(l.id)}>
                {l.label}
              </button>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

export function TemplateGallery() {
  const open = useOverlays((o) => o.templates);
  const [busy, setBusy] = useState(false);
  const t = useT();
  if (!open) return null;
  const close = () => useOverlays.setState({ templates: false });
  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal templates-modal">
        <div className="modal-head">
          <div>
            <div className="lib-title">{t('wel.examples')}</div>
            <div className="lib-sub">{t('tpl.sub')}</div>
          </div>
          <button className="icon-btn" onClick={close}>
            <I.Close />
          </button>
        </div>
        <div className="templates-grid">
          {TEMPLATES.map((tp) => (
            <button
              key={tp.id}
              className="template-card"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  if (!useStore.getState().audioReady) await enter();
                  await openTemplate(tp.id);
                  close();
                  beginTour();
                } catch (e) {
                  notify(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <span className="wc-emoji">{tp.emoji}</span>
              <b>{t(`tpl.${tp.id}` as MessageKey)}</b>
              <small>
                {t(`tpl.${tp.id}.sub` as MessageKey)} · {tp.plan.bpm} BPM · {tp.plan.key}
              </small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Where each tour step points (a CSS selector) and what it says. */
const TOUR_TARGET: Record<string, string> = { play: '.t-play', region: '.lane', note: '.pr-grid', mixer: '.dock-tabs', ai: '.ai-pill' };

export function TourCard() {
  const tour = useTour((x) => x.tour);
  const t = useT();
  const step = tour && tour.step !== 'done' ? tour.step : null;
  useEffect(() => {
    if (!step) return;
    const el = document.querySelector(TOUR_TARGET[step]);
    el?.classList.add('tour-target');
    return () => el?.classList.remove('tour-target');
  }, [step]);
  if (!step) return null;
  const n = TOUR_STEPS.indexOf(step) + 1;
  return (
    <div className="tour-card" role="status">
      <div className="tour-progress">
        {TOUR_STEPS.map((s, i) => (
          <span key={s} className={i < n ? 'on' : ''} />
        ))}
      </div>
      <b>{t(`tour.${step}` as MessageKey)}</b>
      <small>{t(`tour.${step}.sub` as MessageKey)}</small>
      <button className="mini" onClick={endTour}>
        {t('tour.skip')}
      </button>
    </div>
  );
}

const SHORTCUTS: [string, MessageKey][] = [
  ['Space', 'sc.k.play'],
  ['Enter', 'sc.k.start'],
  ['R', 'sc.k.record'],
  ['C', 'sc.k.cycle'],
  ['M', 'sc.k.metro'],
  ['K', 'sc.k.typing'],
  ['Y', 'sc.k.library'],
  ['B', 'sc.k.smart'],
  ['E', 'sc.k.editor'],
  ['X', 'sc.k.mixer'],
  ['F', 'sc.k.fx'],
  ['N', 'sc.k.analysis'],
  ['F / G', 'sc.k.flub'],
  ['] [', 'sc.k.flubJump'],
  ['↑ ↓', 'sc.k.tracks'],
  ['⌘Z / ⇧⌘Z', 'sc.k.undo'],
  ['⌘D', 'sc.k.dup'],
  ['⌫', 'sc.k.delete'],
  ['⌘A', 'sc.k.all'],
  ['?', 'sc.k.help'],
];

export function ShortcutsSheet() {
  const open = useOverlays((o) => o.shortcuts);
  const t = useT();
  if (!open) return null;
  const close = () => useOverlays.setState({ shortcuts: false });
  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal shortcuts-modal">
        <div className="modal-head">
          <div className="lib-title">{t('sc.title')}</div>
          <button className="icon-btn" onClick={close}>
            <I.Close />
          </button>
        </div>
        <div className="shortcuts-grid">
          {SHORTCUTS.map(([k, label]) => (
            <div key={k} className="shortcut">
              <kbd>{k}</kbd>
              <span>{t(label)}</span>
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button className="mini" onClick={() => (close(), beginTour(true))}>
            {t('tour.replay')}
          </button>
        </div>
      </div>
    </div>
  );
}
