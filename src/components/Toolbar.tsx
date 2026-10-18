import { useRef, useState } from 'react';
import { useStore } from '../store';
import { engine } from '../audio/engine';
import { BEATS_PER_BAR, KEYS, clamp } from '../music';
import { usePosition } from '../hooks';
import { startRecording, stopRecording } from '../input';
import { commands } from '../commands';
import { loadDemo } from '../demo';
import * as I from './Icons';
import { importAudioFlow, importSoundFontFlow, openProjectFile, pickFiles } from './ImportUI';
import { saveProject } from '../importers';
import { useLint } from '../lintLive';
import { LANGS, setLang, useLang, useT } from '../i18n';
import { MicButton } from './Mic';

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
  const t = useT();

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
        <div className="lcd-label">{t('lcd.position')}</div>
      </div>
      <div
        className="lcd-cell lcd-tempo"
        title={t('lcd.tempoHint')}
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
        <div className="lcd-label">{t('lcd.tempo')}</div>
      </div>
      <div className="lcd-cell lcd-key">
        <select className="lcd-select" value={project.key} onChange={(e) => commit((d) => void (d.key = e.target.value))}>
          {KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <div className="lcd-label">{t('lcd.key')}</div>
      </div>
    </div>
  );
}

function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const s = useStore();
  const t = useT();
  const lang = useLang((l) => l.lang);
  const close = () => setOpen(false);

  const exportWav = async () => {
    close();
    s.notify(t('menu.rendering'));
    try {
      await commands.export_wav({});
      s.notify(t('menu.wavDone'));
    } catch (e) {
      s.notify(t('menu.wavFailed', { error: (e as Error).message }));
    }
  };

  return (
    <div className="menu-wrap">
      <button className="icon-btn" onClick={() => setOpen(!open)} title={t('menu.title')}>
        <I.Menu />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={close} />
          <div className="menu">
            <button onClick={() => (close(), commands.new_project({}))}>{t('menu.new')}</button>
            <button onClick={() => (close(), loadDemo())}>{t('menu.demo')}</button>
            <hr />
            <button onClick={() => (close(), void saveProject())}>{t('menu.save')}</button>
            <button onClick={() => (close(), fileRef.current?.click())}>{t('menu.open')}</button>
            <hr />
            <button onClick={() => (close(), void importAudioFlow())}>{t('menu.importAudio')}</button>
            <button onClick={() => (close(), void importSoundFontFlow())}>{t('menu.importSf')}</button>
            <button
              onClick={async () => {
                close();
                const [f] = await pickFiles('.mid,.midi,audio/midi');
                if (!f) return;
                try {
                  await commands.import_midi_file({ file: f });
                } catch (e) {
                  s.notify((e as Error).message);
                }
              }}
            >
              {t('menu.importMidi')}
            </button>
            <hr />
            <button onClick={exportWav}>{t('menu.exportWav')}</button>
            <button onClick={() => (close(), commands.export_midi({}))}>{t('menu.exportMidi')}</button>
            <hr />
            <div className="menu-label">{t('menu.language')}</div>
            <div className="lang-switch">
              {LANGS.map((l) => (
                <button key={l.id} className={l.id === lang ? 'on' : ''} onClick={() => setLang(l.id)}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".json,.openband,application/json,application/zip"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          await openProjectFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function ProblemsBadge() {
  const counts = useLint((l) => l.counts);
  const open = useStore((s) => s.bottom === 'problems');
  const set = useStore((s) => s.set);
  const t = useT();
  const n = counts.error + counts.warn;
  return (
    <button className={`icon-btn pb-badge ${open ? 'on' : ''} ${counts.error ? 'error' : n ? 'warn' : ''}`} onClick={() => set({ bottom: open ? null : 'problems' })} title={t('lint.badge', { e: counts.error, w: counts.warn, i: counts.info })}>
      <I.Sparkles />
      {n > 0 && <span className="pb-count">{n}</span>}
    </button>
  );
}

export function Toolbar() {
  const s = useStore();
  const p = s.project;
  const t = useT();
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
        <button className={`icon-btn ${s.libraryOpen ? 'on' : ''}`} onClick={() => s.set({ libraryOpen: !s.libraryOpen })} title={t('tb.library')}>
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
          <button className="t-btn" onClick={rewind} title={t('tb.toStart')}>
            <I.ToStart />
          </button>
          <button className={`t-btn t-play ${s.isPlaying ? 'on' : ''}`} onClick={togglePlay} title={t('tb.play')}>
            {s.isPlaying ? <I.Pause /> : <I.Play />}
          </button>
          <button className={`t-btn t-rec ${s.isRecording ? 'on' : ''}`} onClick={toggleRecord} title={t('tb.record')}>
            <I.Record />
          </button>
          <MicButton />
          <button
            className={`t-btn t-cycle ${p.loop.enabled ? 'on' : ''}`}
            onClick={() => s.commit((d) => void (d.loop.enabled = !d.loop.enabled))}
            title={t('tb.cycle')}
          >
            <I.Cycle />
          </button>
        </div>
        <Lcd />
        <button
          className={`t-btn t-metro ${p.metronome ? 'on' : ''}`}
          onClick={() => s.commit((d) => void (d.metronome = !d.metronome), { history: false })}
          title={t('tb.metronome')}
        >
          <I.Metronome />
        </button>
      </div>

      <div className="tb-group tb-right">
        <button
          className="icon-btn"
          onClick={() => s.undo()}
          disabled={!s.past.length && !s.activeTransaction}
          title={s.past.length ? t('tb.undoLabel', { label: s.past[s.past.length - 1].label, n: s.past[s.past.length - 1].commands }) : t('tb.undo')}
        >
          <I.Undo />
        </button>
        <button
          className="icon-btn"
          onClick={() => s.redo()}
          disabled={!s.future.length}
          title={s.future.length ? t('tb.redoLabel', { label: s.future[0].label, n: s.future[0].commands }) : t('tb.redo')}
        >
          <I.Redo />
        </button>
        <div className="master-vol" title={t('tb.masterVolume')}>
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
        <button className={`icon-btn ${s.keyboardOpen ? 'on' : ''}`} onClick={() => s.set({ keyboardOpen: !s.keyboardOpen })} title={t('tb.typing')}>
          <I.Keyboard />
        </button>
        <ProblemsBadge />
        <button className={`ai-pill ${s.bridgeStatus}`} onClick={() => s.set({ aiOpen: !s.aiOpen })} title={t('tb.ai')}>
          <span className="dot" />
          <I.Sparkles width={15} height={15} />
          <span>{s.bridgeStatus === 'connected' ? t('tb.aiConnected') : 'MCP'}</span>
        </button>
        <ProjectMenu />
      </div>
    </header>
  );
}
