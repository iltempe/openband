import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Note, Region, Track } from '../types';
import { getRegion, getTrack, useStore } from '../store';
import { engine } from '../audio/engine';
import { BEATS_PER_BAR, DRUM_PIECES, clamp, isBlackKey, noteName, uid } from '../music';
import { useFrame, usePosition } from '../hooks';
import { commands } from '../commands';
import * as I from './Icons';
import { AudioClipEditor } from './Audio';
import { useSyllablesByNote } from './Lyrics';
import { drumLabel, useT } from '../i18n';

export function Editor() {
  const project = useStore((s) => s.project);
  const regionId = useStore((s) => s.selectedRegionId);
  const region = getRegion(project, regionId);
  const track = region ? getTrack(project, region.trackId) : undefined;
  const t = useT();

  if (!region || !track) {
    return (
      <div className="panel-empty">
        <I.PianoRoll width={28} height={28} />
        <p>{t('ed.empty')}</p>
      </div>
    );
  }
  if (region.audio) return <AudioClipEditor region={region} track={track} />;
  return (
    <div className="editor" style={{ '--track': track.color } as CSSProperties}>
      <EditorBar region={region} track={track} />
      {track.kind === 'drums' ? <StepSequencer region={region} track={track} /> : <PianoRoll region={region} track={track} />}
    </div>
  );
}

function EditorBar({ region, track }: { region: Region; track: Track }) {
  const commit = useStore((s) => s.commit);
  const selectedNoteIds = useStore((s) => s.selectedNoteIds);
  const updateRegion = (fn: (r: Region) => void) => commit((d) => fn(d.regions.find((r) => r.id === region.id)!));
  const bars = region.length / BEATS_PER_BAR;
  const sel = region.notes.filter((n) => selectedNoteIds.includes(n.id));
  const t = useT();
  const avgVel = sel.length ? sel.reduce((a, n) => a + n.velocity, 0) / sel.length : useStore.getState().velocity;

  return (
    <div className="editor-bar">
      <div className="eb-title">
        <span className="eb-dot" />
        <input
          key={region.id}
          className="eb-name"
          defaultValue={region.name}
          onBlur={(e) => updateRegion((r) => void (r.name = e.target.value || r.name))}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="eb-sub">{track.name}</span>
      </div>
      <div className="eb-group">
        <label>{t('ed.length')}</label>
        <button className="mini" onClick={() => updateRegion((r) => void (r.length = Math.max(BEATS_PER_BAR, r.length - BEATS_PER_BAR)))}>
          −
        </button>
        <span className="eb-val">{t('ed.bars', { n: bars % 1 ? bars.toFixed(2) : bars })}</span>
        <button className="mini" onClick={() => updateRegion((r) => void (r.length += BEATS_PER_BAR))}>
          +
        </button>
      </div>
      {track.kind === 'instrument' && (
        <div className="eb-group">
          <label>{t('ed.transpose')}</label>
          <button className="mini" onClick={() => commands.transpose_region({ region_id: region.id, semitones: -12 })}>−8va</button>
          <button className="mini" onClick={() => commands.transpose_region({ region_id: region.id, semitones: -1 })}>−1</button>
          <button className="mini" onClick={() => commands.transpose_region({ region_id: region.id, semitones: 1 })}>+1</button>
          <button className="mini" onClick={() => commands.transpose_region({ region_id: region.id, semitones: 12 })}>+8va</button>
          <button className="mini" onClick={() => commands.quantize_region({ region_id: region.id, grid: 0.25 })} title={t('ed.quantizeHint')}>
            {t('ed.quantize')}
          </button>
        </div>
      )}
      <div className="eb-group">
        <label>{t('ed.velocity')}</label>
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.01}
          value={avgVel}
          onPointerDown={() => useStore.getState().checkpoint()}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!sel.length) return useStore.getState().set({ velocity: v });
            commit(
              (d) => d.regions.find((r) => r.id === region.id)!.notes.forEach((n) => selectedNoteIds.includes(n.id) && (n.velocity = v)),
              { history: false },
            );
          }}
        />
        <span className="eb-val">{Math.round(avgVel * 127)}</span>
      </div>
      <div className="eb-spacer" />
      <button className="mini" onClick={() => commands.duplicate_region({ region_id: region.id })} title={t('ed.duplicateHint')}>
        <I.Copy width={14} height={14} /> {t('ed.duplicate')}
      </button>
      <button className="mini danger" onClick={() => commands.delete_region({ region_id: region.id })} title={t('ed.deleteRegion')}>
        <I.Trash width={14} height={14} />
      </button>
    </div>
  );
}

// ---------- Piano roll ----------

const ROW_H = 15;
const KEYS_W = 66;
const LOW = 21;
const HIGH = 108;
const PR_RULER = 22;

function PianoRoll({ region, track }: { region: Region; track: Track }) {
  const commit = useStore((s) => s.commit);
  const selectedNoteIds = useStore((s) => s.selectedNoteIds);
  const set = useStore((s) => s.set);
  const [ppb, setPpb] = useState(90);
  const [snap, setSnap] = useState(0.25);
  const lastDur = useRef(1);
  const t = useT();
  const syllables = useSyllablesByNote(track.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const rows = HIGH - LOW + 1;
  const viewBeats = Math.max(region.length, ...region.notes.map((n) => n.start + n.duration)) + BEATS_PER_BAR;

  // Center the view on the region's notes (or C4) when switching regions.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pitches = region.notes.map((n) => n.pitch);
    const mid = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
    el.scrollTop = (HIGH - mid) * ROW_H - el.clientHeight / 2 + PR_RULER;
    el.scrollLeft = 0;
  }, [region.id]);

  const locate = (e: { clientX: number; clientY: number }) => {
    const rect = gridRef.current!.getBoundingClientRect();
    return {
      beat: Math.max(0, (e.clientX - rect.left) / ppb),
      pitch: clamp(HIGH - Math.floor((e.clientY - rect.top) / ROW_H), LOW, HIGH),
    };
  };

  const mutateNotes = (fn: (notes: Note[]) => void, history = false) =>
    commit((d) => fn(d.regions.find((r) => r.id === region.id)!.notes), { history });

  const drag = (e: React.PointerEvent, ids: string[], mode: 'move' | 'resize', fresh = false) => {
    const start = locate(e);
    const originals = new Map(region.notes.filter((n) => ids.includes(n.id)).map((n) => [n.id, { ...n }]));
    let lastPitchShift = 0;
    let moved = fresh;
    const move = (ev: PointerEvent) => {
      const at = locate(ev);
      if (!moved) {
        if (Math.abs(at.beat - start.beat) * ppb < 3 && at.pitch === start.pitch) return;
        moved = true;
        useStore.getState().checkpoint();
      }
      const dBeat = Math.round((at.beat - start.beat) / snap) * snap;
      const dPitch = at.pitch - start.pitch;
      mutateNotes((notes) => {
        for (const n of notes) {
          const o = originals.get(n.id);
          if (!o) continue;
          if (mode === 'move') {
            n.start = Math.max(0, o.start + dBeat);
            n.pitch = clamp(o.pitch + dPitch, 0, 127);
          } else {
            n.duration = Math.max(snap, Math.round((o.duration + (at.beat - start.beat)) / snap) * snap);
            lastDur.current = n.duration;
          }
        }
      });
      if (mode === 'move' && dPitch !== lastPitchShift) {
        lastPitchShift = dPitch;
        const first = originals.values().next().value;
        if (first) engine.preview(track.id, first.pitch + dPitch, first.velocity, 0.2);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onGridDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { beat, pitch } = locate(e);
    const note: Note = {
      id: uid('n'),
      pitch,
      start: Math.floor(beat / snap) * snap,
      duration: lastDur.current,
      velocity: useStore.getState().velocity,
    };
    commit((d) => void d.regions.find((r) => r.id === region.id)!.notes.push(note));
    set({ selectedNoteIds: [note.id] });
    engine.preview(track.id, pitch, note.velocity);
    // Dragging right after creating stretches the new note.
    const origin = { clientX: e.clientX, clientY: e.clientY };
    const rect = gridRef.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const b = (ev.clientX - rect.left) / ppb;
      if (Math.abs(ev.clientX - origin.clientX) < 4) return;
      const dur = Math.max(snap, Math.ceil((b - note.start) / snap) * snap);
      lastDur.current = dur;
      mutateNotes((notes) => {
        const n = notes.find((x) => x.id === note.id);
        if (n) n.duration = dur;
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onNoteDown = (e: React.PointerEvent, n: Note) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    let ids = selectedNoteIds;
    if (e.shiftKey) {
      ids = ids.includes(n.id) ? ids.filter((x) => x !== n.id) : [...ids, n.id];
    } else if (!ids.includes(n.id)) {
      ids = [n.id];
    }
    set({ selectedNoteIds: ids });
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const resize = rect.right - e.clientX < 7;
    if (!resize) engine.preview(track.id, n.pitch, n.velocity, 0.25);
    lastDur.current = n.duration;
    if (ids.includes(n.id)) drag(e, ids, resize ? 'resize' : 'move');
  };

  return (
    <div className="pr">
      <div className="pr-tools">
        <label>{t('ed.grid')}</label>
        <select value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
          <option value={1}>1/4</option>
          <option value={0.5}>1/8</option>
          <option value={0.25}>1/16</option>
          <option value={0.125}>1/32</option>
          <option value={1 / 3}>{t('ed.triplet')}</option>
        </select>
        <label>{t('ed.zoom')}</label>
        <input type="range" min={30} max={240} value={ppb} onChange={(e) => setPpb(Number(e.target.value))} />
        <span className="hint">{t('ed.prHint')}</span>
      </div>
      <div className="pr-scroll" ref={scrollRef}>
        <div className="pr-inner" style={{ width: KEYS_W + viewBeats * ppb, height: PR_RULER + rows * ROW_H }}>
          <div className="pr-ruler" style={{ height: PR_RULER }}>
            <div className="pr-ruler-corner" style={{ width: KEYS_W }} />
            {Array.from({ length: Math.ceil(viewBeats) }, (_, b) => (
              <div key={b} className={`pr-beat ${b % BEATS_PER_BAR === 0 ? 'bar' : ''}`} style={{ left: KEYS_W + b * ppb }}>
                {b % BEATS_PER_BAR === 0 ? b / BEATS_PER_BAR + 1 : ''}
              </div>
            ))}
          </div>
          <div className="pr-body">
            <div className="pr-keys" style={{ width: KEYS_W }}>
              {Array.from({ length: rows }, (_, i) => {
                const p = HIGH - i;
                return (
                  <div
                    key={p}
                    className={`pr-key ${isBlackKey(p) ? 'black' : 'white'} ${p % 12 === 0 ? 'c' : ''}`}
                    style={{ height: ROW_H }}
                    onPointerDown={() => engine.preview(track.id, p)}
                  >
                    {p % 12 === 0 ? noteName(p) : ''}
                  </div>
                );
              })}
            </div>
            <div
              className="pr-grid"
              ref={gridRef}
              style={{ width: viewBeats * ppb, height: rows * ROW_H, '--ppb': `${ppb}px`, '--snap': `${ppb * snap}px`, '--row': `${ROW_H}px` } as CSSProperties}
              onPointerDown={onGridDown}
            >
              <div className="pr-rows">
                {Array.from({ length: rows }, (_, i) => (
                  <div key={i} className={`pr-row ${isBlackKey(HIGH - i) ? 'black' : ''} ${(HIGH - i) % 12 === 0 ? 'c' : ''}`} style={{ height: ROW_H }} />
                ))}
              </div>
              <div className="pr-region-end" style={{ left: region.length * ppb }} />
              {region.notes.map((n) => (
                <div
                  key={n.id}
                  className={`pr-note ${selectedNoteIds.includes(n.id) ? 'selected' : ''} ${n.start >= region.length ? 'outside' : ''}`}
                  style={{
                    left: n.start * ppb,
                    top: (HIGH - n.pitch) * ROW_H,
                    width: Math.max(4, n.duration * ppb - 1),
                    height: ROW_H - 1,
                    opacity: 0.5 + n.velocity * 0.5,
                  }}
                  onPointerDown={(e) => onNoteDown(e, n)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    mutateNotes((notes) => notes.splice(notes.findIndex((x) => x.id === n.id), 1), true);
                  }}
                >
                  {syllables.get(n.id) ? (
                    <span className={`pr-syl ${syllables.get(n.id)!.stressed ? 'stressed' : ''} ${syllables.get(n.id)!.bad ? 'bad' : ''}`}>{syllables.get(n.id)!.text}</span>
                  ) : (
                    n.duration * ppb > 34 && <span>{noteName(n.pitch)}</span>
                  )}
                </div>
              ))}
              <EditorPlayhead region={region} ppb={ppb} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function EditorPlayhead({ region, ppb, offset = 0 }: { region: Region; ppb: number; offset?: number }) {
  const pos = usePosition();
  const rel = pos - region.start;
  if (rel < 0 || rel > region.length) return null;
  return <div className="editor-playhead" style={{ transform: `translateX(${offset + rel * ppb}px)` }} />;
}

// ---------- Step sequencer ----------

const CELL_W = 30;
const STEP = 0.25;

function StepSequencer({ region, track }: { region: Region; track: Track }) {
  const commit = useStore((s) => s.commit);
  const paint = useRef<null | 'add' | 'remove'>(null);
  const t = useT();
  const steps = Math.round(region.length / STEP);
  const [current, setCurrent] = useState(-1);
  useFrame(() => {
    const rel = engine.position - region.start;
    const step = engine.playing && rel >= 0 && rel < region.length ? Math.floor(rel / STEP) : -1;
    setCurrent((c) => (c === step ? c : step));
  });

  useEffect(() => {
    const up = () => (paint.current = null);
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  const find = (notes: Note[], pitch: number, step: number) =>
    notes.findIndex((n) => n.pitch === pitch && Math.abs(n.start - step * STEP) < STEP / 2);

  const apply = (pitch: number, step: number, mode: 'add' | 'remove', accent = false) =>
    commit(
      (d) => {
        const notes = d.regions.find((r) => r.id === region.id)!.notes;
        const i = find(notes, pitch, step);
        if (mode === 'add' && i < 0) notes.push({ id: uid('n'), pitch, start: step * STEP, duration: STEP, velocity: accent ? 1 : 0.8 });
        if (mode === 'remove' && i >= 0) notes.splice(i, 1);
      },
      { history: false },
    );

  const onCellDown = (e: React.PointerEvent, pitch: number, step: number) => {
    e.preventDefault();
    useStore.getState().checkpoint();
    const i = find(region.notes, pitch, step);
    if (e.shiftKey && i >= 0) {
      commit((d) => {
        const n = d.regions.find((r) => r.id === region.id)!.notes[i];
        n.velocity = n.velocity >= 0.95 ? 0.5 : n.velocity >= 0.7 ? 1 : 0.8;
      }, { history: false });
      return;
    }
    paint.current = i >= 0 ? 'remove' : 'add';
    apply(pitch, step, paint.current, e.shiftKey);
    if (paint.current === 'add') engine.preview(track.id, pitch);
  };

  return (
    <div className="seq">
      <div className="pr-tools">
        <span className="hint">{t('ed.seqHint')}</span>
      </div>
      <div className="seq-scroll">
        <div className="seq-grid" style={{ gridTemplateColumns: `128px repeat(${steps}, ${CELL_W}px)` }}>
          <div className="seq-corner" />
          {Array.from({ length: steps }, (_, s) => (
            <div key={s} className={`seq-num ${s % 4 === 0 ? 'beat' : ''} ${s === current ? 'now' : ''}`}>
              {s % 4 === 0 ? `${Math.floor(s / 16) + 1}.${(Math.floor(s / 4) % 4) + 1}` : ''}
            </div>
          ))}
          {DRUM_PIECES.map((piece) => (
            <Row key={piece.pitch}>
              <button className="seq-label" onPointerDown={() => engine.preview(track.id, piece.pitch)}>
                <span className="seq-short">{piece.short}</span>
                {drumLabel(piece)}
              </button>
              {Array.from({ length: steps }, (_, s) => {
                const i = find(region.notes, piece.pitch, s);
                const vel = i >= 0 ? region.notes[i].velocity : 0;
                return (
                  <div
                    key={s}
                    className={`seq-cell ${Math.floor(s / 4) % 2 ? 'alt' : ''} ${vel ? 'on' : ''} ${s === current ? 'now' : ''}`}
                    style={vel ? ({ '--vel': vel } as CSSProperties) : undefined}
                    onPointerDown={(e) => onCellDown(e, piece.pitch, s)}
                    onPointerEnter={() => paint.current && apply(piece.pitch, s, paint.current)}
                  />
                );
              })}
            </Row>
          ))}
        </div>
      </div>
    </div>
  );
}

const Row = ({ children }: { children: React.ReactNode }) => <>{children}</>;
