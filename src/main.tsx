import './audio/context';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { hasSavedProject, useStore } from './store';
import { engine } from './audio/engine';
import { loadDemo } from './demo';
import { consumeHandoff } from './handoff';
import { connectBridge } from './bridge';
import { initMidi } from './input';
import './lintLive';
import { initReference } from './reference';
import { initVersions } from './versioning';
import { initJam } from './jamMode';
import { initFirstRun } from './firstRun';
import { loadKeyState } from './ai/keys';
import { initPwa } from './pwa';
import { initDiagnostics } from './diagnostics';
import { ErrorBoundary } from './components/Diagnostics';
import { getConfig, loadConfig } from './config';
import { savedLanguage, useLang } from './i18n';
import { initJournal } from './journal';
import { initAutoWrite } from './autoWrite';
import { renderBuffer } from './audio/render';
import * as Tone from 'tone';

// A song handed over from the online demo wins; otherwise the autosave, otherwise the demo song.
if (!consumeHandoff() && !hasSavedProject()) loadDemo();

engine.sync(useStore.getState().project);
useStore.subscribe((s, prev) => {
  if (s.project !== prev.project) engine.sync(s.project);
});

initReference();
initVersions();
void initJournal();
initAutoWrite();
// ?debug: the engine and the store on window.openband, for diagnostics and end-to-end tests.
if (new URLSearchParams(location.search).has('debug')) (window as unknown as { openband: unknown }).openband = { engine, useStore, renderBuffer, Tone };
initJam();
initFirstRun();
void loadKeyState();
initPwa();
initDiagnostics();
connectBridge();
initMidi();

// The instance's config.json (if any) is read before the first render.
void loadConfig().finally(() => {
  const cfg = getConfig();
  if (cfg.defaultLanguage && !savedLanguage()) useLang.setState({ lang: cfg.defaultLanguage });
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
});
