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

// A song handed over from the online demo wins; otherwise the autosave, otherwise the demo song.
if (!consumeHandoff() && !hasSavedProject()) loadDemo();

engine.sync(useStore.getState().project);
useStore.subscribe((s, prev) => {
  if (s.project !== prev.project) engine.sync(s.project);
});

initReference();
initVersions();
initJam();
connectBridge();
initMidi();

createRoot(document.getElementById('root')!).render(<App />);
