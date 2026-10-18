import './audio/context';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { hasSavedProject, useStore } from './store';
import { engine } from './audio/engine';
import { loadDemo } from './demo';
import { connectBridge } from './bridge';
import { initMidi } from './input';
import './lintLive';
import { initReference } from './reference';

if (!hasSavedProject()) loadDemo();

engine.sync(useStore.getState().project);
useStore.subscribe((s, prev) => {
  if (s.project !== prev.project) engine.sync(s.project);
});

initReference();
connectBridge();
initMidi();

createRoot(document.getElementById('root')!).render(<App />);
