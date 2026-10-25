import './audio/context';
import { learnFromRanking } from './ensemble/learn';
import { resetTaste, tasteByCapability } from './ensemble/taste';
import { releaseKit } from './publish/commands';
import { renderVideo } from './publish/video';
import { saveCredentials, authorizeUrl, refreshTargets, usePublish } from './publish/publish';
import { distance, noteFeatures } from './soundmatch/features';
import { yinTrack } from './analysis/pitchtrack';
import { analyseTarget, matchSound, renderCandidates } from './soundmatch/search';
import { synthSchema, toUnit } from './audio/synthParams';
import { scoreAndComp, summary as sessionSummary, useSession } from './session/session';
import { handleHeard, setVoiceControl, useVoice } from './voice/control';
import { setVoskSources } from './voice/models';
import { setModelSource, useSeparationModel } from './separate/model';
import { freezeNativeTracks } from './freezeTracks';
import { trackHash } from './audio/freeze';
import { importSample } from './audio/samples';
import { encodePcm } from './audio/render';
import { liveNative, nativeParam, restartNative, testSlot, useNativeStatus } from './audio/native';
import { loudness, truePeak } from './analysis/loudness';
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
import { acceptGhost, initGhosts, requestGhosts, useGhost } from './ghost';
import { setLowLatency, startMonitoring as startLowLatency, syncMonitoring, useLowLatency } from './lowLatency';
import { renderBuffer } from './audio/render';
import { commands } from './commands';
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
startLowLatency();
initGhosts();
// ?debug: the engine and the store on window.openband, for diagnostics and end-to-end tests.
if (new URLSearchParams(location.search).has('debug')) (window as unknown as { openband: unknown }).openband = { engine, useStore, renderBuffer, Tone, commands, analysis: { loudness, truePeak }, native: { testSlot }, nativeStatus: useNativeStatus, restartNative, nativeParam, liveNative, freeze: { freezeNativeTracks, trackHash }, samples: { importSample }, encodePcm, lowLatency: { setLowLatency, syncMonitoring, useLowLatency }, ghost: { useGhost, requestGhosts, acceptGhost }, separation: { setModelSource, useSeparationModel }, voice: { handleHeard, setVoiceControl, useVoice, setVoskSources }, session: { scoreAndComp, summary: sessionSummary, useSession }, taste: { learnFromRanking, resetTaste, tasteByCapability }, release: { releaseKit, renderVideo }, publishing: { saveCredentials, authorizeUrl, refreshTargets, usePublish }, soundmatch: { analyseTarget, matchSound, renderCandidates, synthSchema, toUnit, yinTrack, distance, noteFeatures } };
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
