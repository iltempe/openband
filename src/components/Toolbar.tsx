import { useRef, useState } from 'react';
import { useStore } from '../store';
import { engine } from '../audio/engine';
import { BEATS_PER_BAR, KEYS, clamp } from '../music';
import { usePosition } from '../hooks';
import { startRecording, stopRecording } from '../input';
import { commands } from '../commands';
import { loadDemo } from '../demo';
import { download } from '../audio/render';
import * as I from './Icons';

export async function togglePlay() {
  const s = useStore.getState();
  if (s.isRecording) stopRecording();
  if (engine.playing) {
    engine.stop();
    s.set({ isPlaying: false });
  } else {
    await engine.play();
    s.set({ isPlaying: true });
  }
}

export async function toggleRecord() {
  if (useStore.getState().isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

export function rewind() {
  engine.position = useStore.getState().project.loop.enabled ? useStore.getState().project.loop.start : 0;
}

function Lcd() {
  const pos = usePosition();
  const project = useStore((s) => s.project);
  const commit = useStore((s) => s.commit);
  const [editingTempo, setEditingTempo] = useState(false);
  const drag = useRef<{ y: number; bpm: number } | null>(null);

  const bar = Math.floor(pos / BEATS_PER_BAR) + 1;
  const beat = Math.floor(pos % BEATS_PER_BAR) + 1;
  const tick = Math.floor((pos % 1) * 4) + 1;

  return (
    <div className="lcd">
      <div className="lcd-cell lcd-pos">
        <div className="lcd-value">
          {String(bar).padStart(3, '0')}
          <span className="lcd-dim">.</span>
          {beat}
          <span className="lcd-dim">.</span>
          {tick}
        </div>
        <div className="lcd-label">BATTUTA · MOVIMENTO</div>
      </div>
      <div
        className="lcd-cell lcd-tempo"
        title="Trascina in verticale o doppio clic per modificare"
        onPointerDown={(e) => {
          if (editingTempo) return;
          (e.target as Element).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, bpm: project.bpm };
          useStore.getState().checkpoint();
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const bpm = clamp(Math.round(drag.current.bpm + (drag.current.y - e.clientY) / 3), 40, 240);
          if (bpm !== project.bpm) commit((d) => void (d.bpm = bpm), { history: false });
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => setEditingTempo(true)}
      >
        {editingTempo ? (
          <input
            autoFocus
            className="lcd-input"
            defaultValue={project.bpm}
            onBlur={(e) => {
              const v = clamp(Number(e.target.value) || project.bpm, 40, 240);
              commit((d) => void (d.bpm = v));
              setEditingTempo(false);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <div className="lcd-value">{Math.round(project.bpm)}</div>
        )}
        <div className="lcd-label">TEMPO</div>
      </div>
      <div className="lcd-cell lcd-key">
        <select className="lcd-select" value={project.key} onChange={(e) => commit((d) => void (d.key = e.target.value))}>
          {KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <div className="lcd-label">TONALITÀ · 4/4</div>
      </div>
    </div>
  );
}

function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const s = useStore();
  const close = () => setOpen(false);

  const exportWav = async () => {
    close();
    s.notify('Rendering del brano in corso…');
    try {
      await commands.export_wav({});
      s.notify('WAV esportato');
    } catch (e) {
      s.notify(`Esportazione non riuscita: ${(e as Error).message}`);
    }
  };

  return (
    <div className="menu-wrap">
      <button className="icon-btn" onClick={() => setOpen(!open)} title="Progetto">
        <I.Menu />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={close} />
          <div className="menu">
            <button onClick={() => (close(), commands.new_project({}))}>Nuovo progetto vuoto</button>
            <button onClick={() => (close(), loadDemo())}>Carica brano demo</button>
            <hr />
            <button
              onClick={() => {
                close();
                const p = s.project;
                download(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }), `${p.name}.openband.json`);
              }}
            >
              Salva progetto (.json)
            </button>
            <button onClick={() => (close(), fileRef.current?.click())}>Apri progetto…</button>
            <hr />
            <button onClick={exportWav}>Esporta brano in WAV</button>
          </div>
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            commands.import_project_json({ project: await f.text() });
            s.notify(`Aperto “${f.name}”`);
          } catch (err) {
            s.notify((err as Error).message);
          }
          e.target.value = '';
        }}
      />
    </div>
  );
}

export function Toolbar() {
  const s = useStore();
  const p = s.project;
  const toggleBottom = (b: typeof s.bottom) => s.set({ bottom: s.bottom === b ? null : b });

  return (
    <header className="toolbar">
      <div className="tb-group tb-left">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 64 64">
            <defs>
              <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#ff7a59" />
                <stop offset=".5" stopColor="#b14cff" />
                <stop offset="1" stopColor="#3cc8ff" />
              </linearGradient>
            </defs>
            <path d="M8 40c7 0 7-16 14-16s7 16 14 16 7-16 14-16" fill="none" stroke="url(#bg)" strokeWidth="7" strokeLinecap="round" />
          </svg>
          <input className="project-name" value={p.name} onChange={(e) => s.commit((d) => void (d.name = e.target.value), { history: false })} />
        </div>
        <button className={`icon-btn ${s.libraryOpen ? 'on' : ''}`} onClick={() => s.set({ libraryOpen: !s.libraryOpen })} title="Libreria (Y)">
          <I.Library />
        </button>
        <button className={`icon-btn ${s.bottom === 'smart' ? 'on' : ''}`} onClick={() => toggleBottom('smart')} title="Smart Controls (B)">
          <I.Sliders />
        </button>
        <button className={`icon-btn ${s.bottom === 'editor' ? 'on' : ''}`} onClick={() => toggleBottom('editor')} title="Editor (E)">
          <I.PianoRoll />
        </button>
        <button className={`icon-btn ${s.bottom === 'mixer' ? 'on' : ''}`} onClick={() => toggleBottom('mixer')} title="Mixer (X)">
          <I.Mixer />
        </button>
      </div>

      <div className="tb-group tb-center">
        <div className="transport">
          <button className="t-btn" onClick={rewind} title="Vai all'inizio (Invio)">
            <I.ToStart />
          </button>
          <button className={`t-btn t-play ${s.isPlaying ? 'on' : ''}`} onClick={togglePlay} title="Play / Stop (Spazio)">
            {s.isPlaying ? <I.Pause /> : <I.Play />}
          </button>
          <button className={`t-btn t-rec ${s.isRecording ? 'on' : ''}`} onClick={toggleRecord} title="Registra (R)">
            <I.Record />
          </button>
          <button
            className={`t-btn t-cycle ${p.loop.enabled ? 'on' : ''}`}
            onClick={() => s.commit((d) => void (d.loop.enabled = !d.loop.enabled))}
            title="Ciclo (C)"
          >
            <I.Cycle />
          </button>
        </div>
        <Lcd />
        <button
          className={`t-btn t-metro ${p.metronome ? 'on' : ''}`}
          onClick={() => s.commit((d) => void (d.metronome = !d.metronome), { history: false })}
          title="Metronomo (M)"
        >
          <I.Metronome />
        </button>
      </div>

      <div className="tb-group tb-right">
        <button className="icon-btn" onClick={s.undo} disabled={!s.past.length} title="Annulla (⌘Z)">
          <I.Undo />
        </button>
        <button className="icon-btn" onClick={s.redo} disabled={!s.future.length} title="Ripristina (⇧⌘Z)">
          <I.Redo />
        </button>
        <div className="master-vol" title="Volume master">
          <I.Speaker width={16} height={16} />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={p.masterVolume}
            onChange={(e) => s.commit((d) => void (d.masterVolume = Number(e.target.value)), { history: false })}
          />
        </div>
        <button className={`icon-btn ${s.keyboardOpen ? 'on' : ''}`} onClick={() => s.set({ keyboardOpen: !s.keyboardOpen })} title="Tastiera musicale (K)">
          <I.Keyboard />
        </button>
        <button className={`ai-pill ${s.bridgeStatus}`} onClick={() => s.set({ aiOpen: !s.aiOpen })} title="Pannello AI / MCP">
          <span className="dot" />
          <I.Sparkles width={15} height={15} />
          <span>{s.bridgeStatus === 'connected' ? 'AI collegata' : 'MCP'}</span>
        </button>
        <ProjectMenu />
      </div>
    </header>
  );
}
