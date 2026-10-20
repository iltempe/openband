import { useEffect } from 'react';
import { getRegion, useStore } from './store';
import { clamp } from './music';
import { commands } from './commands';
import { liveNoteOff, liveNoteOn, typingPitch } from './input';
import { Toolbar, rewind, togglePlay, toggleRecord } from './components/Toolbar';
import { Arrangement } from './components/Arrangement';
import { Editor } from './components/Editor';
import { SmartControls } from './components/SmartControls';
import { Mixer } from './components/Mixer';
import { Library } from './components/Library';
import { AIPanel } from './components/AIPanel';
import { MusicalTyping } from './components/MusicalTyping';
import { Effects } from './components/Effects';
import { AnalysisPanel } from './components/AnalysisPanel';
import { ProblemsPanel } from './components/ProblemsPanel';
import { LyricsPanel } from './components/Lyrics';
import * as I from './components/Icons';
import { SoundFontDialog, handleDroppedFiles } from './components/ImportUI';
import { MicOverlay } from './components/Mic';
import { ABOverlay, TakesDialog } from './components/Takes';
import { CommentsPanel, ExplainMenu } from './components/Comments';
import { CompareBanner, VersionsPanel } from './components/Versions';
import { JoinDialog } from './components/Collab';
import { DiagnosticsPage } from './components/Diagnostics';
import { ShortcutsSheet, TemplateGallery, TourCard, Welcome, useOverlays } from './components/Welcome';
import { PluginBrowser, PluginWindow } from './components/Plugins';
import { useT } from './i18n';
import { FlubsPanel } from './components/Flubs';
import { isRecordingTake, jumpToFlub, markFlub } from './flubLive';

function useShortcuts() {
  useEffect(() => {
    const held = new Map<string, number>();
    const down = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if ((el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range') || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return;
      const s = useStore.getState();
      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;

      if (mod) {
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) s.redo();
          else s.undo();
        } else if (key === 'y') {
          e.preventDefault();
          s.redo();
        } else if (key === 'd' && s.selectedRegionId) {
          e.preventDefault();
          commands.duplicate_region({ region_id: s.selectedRegionId });
        } else if (key === 'a' && s.bottom === 'editor') {
          const r = getRegion(s.project, s.selectedRegionId);
          if (r) {
            e.preventDefault();
            s.set({ selectedNoteIds: r.notes.map((n) => n.id) });
          }
        }
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        void togglePlay();
        return;
      }
      if (e.key === 'Enter') return rewind();
      if (e.key === 'Escape') return s.set({ keyboardOpen: false, selectedNoteIds: [] });
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const region = getRegion(s.project, s.selectedRegionId);
        if (region && s.selectedNoteIds.length && s.bottom === 'editor') {
          commands.remove_notes({ region_id: region.id, note_ids: s.selectedNoteIds });
          s.set({ selectedNoteIds: [] });
        } else if (region) {
          commands.delete_region({ region_id: region.id });
        }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const tracks = s.project.tracks;
        if (!tracks.length) return;
        e.preventDefault();
        const i = tracks.findIndex((t) => t.id === s.selectedTrackId);
        const next = clamp(i + (e.key === 'ArrowUp' ? -1 : 1), 0, tracks.length - 1);
        s.set({ selectedTrackId: tracks[next].id });
        return;
      }

      // Flub markers while recording: F / G — with Shift when musical typing is open (F and G play notes there).
      if ((key === 'f' || key === 'g') && isRecordingTake() && (e.shiftKey || !s.keyboardOpen)) {
        if (!e.repeat) markFlub(key === 'f' ? 'flub' : 'good');
        return;
      }
      if (e.key === ']' || e.key === '[') {
        jumpToFlub(e.key === ']' ? 1 : -1);
        return;
      }

      if (s.keyboardOpen) {
        if (e.repeat) return;
        if (key === 'z') return s.set({ octave: clamp(s.octave - 1, 0, 8) });
        if (key === 'x') return s.set({ octave: clamp(s.octave + 1, 0, 8) });
        if (key === 'c') return s.set({ velocity: clamp(s.velocity - 0.1, 0.1, 1) });
        if (key === 'v') return s.set({ velocity: clamp(s.velocity + 0.1, 0.1, 1) });
        const p = typingPitch(key);
        if (p !== undefined) {
          held.set(key, p);
          liveNoteOn(p);
          return;
        }
      }

      const toggleBottom = (b: typeof s.bottom) => s.set({ bottom: s.bottom === b ? null : b });
      switch (key) {
        case 'r':
          void toggleRecord();
          break;
        case 'c':
          s.commit((d) => void (d.loop.enabled = !d.loop.enabled));
          break;
        case 'k':
          s.set({ keyboardOpen: !s.keyboardOpen });
          break;
        case '?':
          useOverlays.setState((o) => ({ shortcuts: !o.shortcuts }));
          break;
        case 'm':
          s.commit((d) => void (d.metronome = !d.metronome), { history: false });
          break;
        case 'y':
          s.set({ libraryOpen: !s.libraryOpen });
          break;
        case 'b':
          toggleBottom('smart');
          break;
        case 'e':
          toggleBottom('editor');
          break;
        case 'x':
          toggleBottom('mixer');
          break;
        case 'f':
          toggleBottom('fx');
          break;
        case 'n':
          toggleBottom('analysis');
          break;
      }
    };
    const up = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const p = held.get(key);
      if (p !== undefined) {
        held.delete(key);
        liveNoteOff(p);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
}


function useFileDrop() {
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      void handleDroppedFiles([...e.dataTransfer.files]);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);
}

export function App() {
  useShortcuts();
  useFileDrop();
  const s = useStore();
  const annCount = (s.project.annotations ?? []).filter((a) => !a.resolved).length;
  const flubCount = (s.project.flubs ?? []).filter((f) => !f.resolved && f.kind === 'flub').length;
  const t = useT();

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        {s.libraryOpen && <Library />}
        <div className="center">
          <Arrangement />
          {s.bottom && (
            <div className="dock">
              <div className="dock-tabs">
                <button className={s.bottom === 'smart' ? 'on' : ''} onClick={() => s.set({ bottom: 'smart' })}>
                  <I.Sliders width={14} height={14} /> Smart Controls
                </button>
                <button className={s.bottom === 'editor' ? 'on' : ''} onClick={() => s.set({ bottom: 'editor' })}>
                  <I.PianoRoll width={14} height={14} /> Editor
                </button>
                <button className={s.bottom === 'mixer' ? 'on' : ''} onClick={() => s.set({ bottom: 'mixer' })}>
                  <I.Mixer width={14} height={14} /> Mixer
                </button>
                <button className={s.bottom === 'fx' ? 'on' : ''} onClick={() => s.set({ bottom: 'fx' })}>
                  <I.Fx width={14} height={14} /> {t('fx.tab')}
                </button>
                <button className={s.bottom === 'analysis' ? 'on' : ''} onClick={() => s.set({ bottom: 'analysis' })}>
                  <I.Wave width={14} height={14} /> {t('an.tab')}
                </button>
                <button className={s.bottom === 'problems' ? 'on' : ''} onClick={() => s.set({ bottom: 'problems' })}>
                  <I.Sparkles width={14} height={14} /> {t('lint.tab')}
                </button>
                <button className={s.bottom === 'lyrics' ? 'on' : ''} onClick={() => s.set({ bottom: 'lyrics' })}>
                  <I.PianoRoll width={14} height={14} /> {t('ly.tab')}
                </button>
                <button className={s.bottom === 'comments' ? 'on' : ''} onClick={() => s.set({ bottom: 'comments' })}>
                  <I.Sparkles width={14} height={14} /> {t('cm.tab')}
                  {annCount > 0 && <span className="cm-tab-count">{annCount}</span>}
                </button>
                <button className={s.bottom === 'flubs' ? 'on' : ''} onClick={() => s.set({ bottom: 'flubs' })}>
                  <I.Flag width={14} height={14} /> {t('fl.tab')}
                  {flubCount > 0 && <span className="cm-tab-count">{flubCount}</span>}
                </button>
                <button className={s.bottom === 'versions' ? 'on' : ''} onClick={() => s.set({ bottom: 'versions' })}>
                  <I.Cycle width={14} height={14} /> {t('ver.tab')}
                </button>
                <div className="eb-spacer" />
                <button className="dock-close" onClick={() => s.set({ bottom: null })}>
                  <I.Close width={14} height={14} />
                </button>
              </div>
              <div className={`dock-body ${s.bottom}`}>
                {s.bottom === 'smart' && <SmartControls />}
                {s.bottom === 'editor' && <Editor />}
                {s.bottom === 'mixer' && <Mixer />}
                {s.bottom === 'fx' && <Effects />}
                {s.bottom === 'analysis' && <AnalysisPanel />}
                {s.bottom === 'problems' && <ProblemsPanel />}
                {s.bottom === 'lyrics' && <LyricsPanel />}
                {s.bottom === 'comments' && <CommentsPanel />}
                {s.bottom === 'versions' && <VersionsPanel />}
                {s.bottom === 'flubs' && <FlubsPanel />}
              </div>
            </div>
          )}
        </div>
        {s.aiOpen && <AIPanel />}
      </div>
      {s.keyboardOpen && <MusicalTyping />}
      <SoundFontDialog />
      <MicOverlay />
      <TakesDialog />
      <ABOverlay />
      <ExplainMenu />
      <CompareBanner />
      <JoinDialog />
      <DiagnosticsPage />
      <PluginBrowser />
      <PluginWindow />
      {s.toast && <div className="toast">{s.toast}</div>}
      {s.isRecording && <div className="rec-glow" />}
      {!s.audioReady && <Welcome />}
      <TemplateGallery />
      <ShortcutsSheet />
      {s.audioReady && <TourCard />}
    </div>
  );
}
