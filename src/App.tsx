import { useEffect } from 'react';
import { getRegion, useStore } from './store';
import { engine } from './audio/engine';
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
import * as I from './components/Icons';

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

function Splash() {
  const set = useStore((s) => s.set);
  const name = useStore((s) => s.project.name);
  return (
    <div className="splash">
      <div className="splash-glow" />
      <div className="splash-card">
        <svg width="72" height="72" viewBox="0 0 64 64">
          <defs>
            <linearGradient id="sg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#ff7a59" />
              <stop offset=".5" stopColor="#b14cff" />
              <stop offset="1" stopColor="#3cc8ff" />
            </linearGradient>
          </defs>
          <path d="M8 40c7 0 7-16 14-16s7 16 14 16 7-16 14-16" fill="none" stroke="url(#sg)" strokeWidth="6" strokeLinecap="round" />
        </svg>
        <h1>OpenBand</h1>
        <p>Lo studio musicale open source che puoi suonare tu o la tua AI.</p>
        <button
          className="btn primary big"
          onClick={async () => {
            await engine.unlock();
            set({ audioReady: true });
          }}
        >
          Entra nello studio
        </button>
        <div className="splash-sub">
          Progetto: <strong>{name}</strong>
        </div>
      </div>
    </div>
  );
}

export function App() {
  useShortcuts();
  const s = useStore();

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
                <div className="eb-spacer" />
                <button className="dock-close" onClick={() => s.set({ bottom: null })}>
                  <I.Close width={14} height={14} />
                </button>
              </div>
              <div className={`dock-body ${s.bottom}`}>
                {s.bottom === 'smart' && <SmartControls />}
                {s.bottom === 'editor' && <Editor />}
                {s.bottom === 'mixer' && <Mixer />}
              </div>
            </div>
          )}
        </div>
        {s.aiOpen && <AIPanel />}
      </div>
      {s.keyboardOpen && <MusicalTyping />}
      {s.toast && <div className="toast">{s.toast}</div>}
      {s.isRecording && <div className="rec-glow" />}
      {!s.audioReady && <Splash />}
    </div>
  );
}
