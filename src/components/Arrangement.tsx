import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { Region, Track } from '../types';
import { useStore, projectEnd } from '../store';
import { engine } from '../audio/engine';
import { BEATS_PER_BAR, DRUM_PIECES, clamp, uid } from '../music';
import { presetById } from '../audio/instruments';
import { usePosition } from '../hooks';
import { commands } from '../commands';
import * as I from './Icons';
import { useT } from '../i18n';

export const HEADER_W = 252;
export const TRACK_H = 80;
const RULER_H = 38;
const LOOP_STRIP = 14;

const snapFor = (zoom: number) => (zoom >= 22 ? 1 : BEATS_PER_BAR);

export function Arrangement() {
  const project = useStore((s) => s.project);
  const zoom = useStore((s) => s.zoom);
  const set = useStore((s) => s.set);
  const scrollRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const totalBeats = Math.max(40 * BEATS_PER_BAR, Math.ceil((projectEnd(project) + 24 * BEATS_PER_BAR) / BEATS_PER_BAR) * BEATS_PER_BAR);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const z = useStore.getState().zoom;
      set({ zoom: clamp(z * (e.deltaY < 0 ? 1.1 : 0.9), 8, 160) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [set]);

  const style = { width: HEADER_W + totalBeats * zoom, '--beat': `${zoom}px`, '--bar': `${zoom * BEATS_PER_BAR}px` } as CSSProperties;

  return (
    <section className="arrangement">
      <div className="arr-scroll" ref={scrollRef}>
        <div className="arr-inner" style={style}>
          <div className="arr-top" style={{ height: RULER_H }}>
            <div className="arr-corner">
              <button className="chip" onClick={() => commands.add_track({ kind: 'instrument' })}>
                <I.Plus width={14} height={14} /> {t('arr.addInstrument')}
              </button>
              <button className="chip" onClick={() => commands.add_track({ kind: 'drums' })}>
                <I.Plus width={14} height={14} /> {t('arr.addDrums')}
              </button>
            </div>
            <Ruler totalBeats={totalBeats} />
          </div>
          {project.tracks.map((t, i) => (
            <TrackRow key={t.id} track={t} index={i} regions={project.regions.filter((r) => r.trackId === t.id)} />
          ))}
          {project.tracks.length === 0 && <EmptyState />}
          <Playhead scrollRef={scrollRef} />
        </div>
      </div>
      <div className="zoom-ctl">
        <span>−</span>
        <input type="range" min={8} max={160} value={zoom} onChange={(e) => set({ zoom: Number(e.target.value) })} />
        <span>+</span>
      </div>
    </section>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="empty-state" style={{ marginLeft: HEADER_W }}>
      <h2>{t('arr.emptyTitle')}</h2>
      <p>{t('arr.emptyText')}</p>
      <div className="row">
        <button className="btn primary" onClick={() => commands.add_track({ kind: 'instrument' })}>
          <I.KeysIcon /> {t('arr.softwareInstrument')}
        </button>
        <button className="btn" onClick={() => commands.add_track({ kind: 'drums' })}>
          <I.DrumIcon /> {t('arr.addDrums')}
        </button>
      </div>
    </div>
  );
}

// ---------- Ruler & cycle ----------

function Ruler({ totalBeats }: { totalBeats: number }) {
  const zoom = useStore((s) => s.zoom);
  const loop = useStore((s) => s.project.loop);
  const commit = useStore((s) => s.commit);
  const checkpoint = useStore((s) => s.checkpoint);
  const ref = useRef<HTMLDivElement>(null);
  const bars = totalBeats / BEATS_PER_BAR;
  const labelEvery = zoom < 12 ? 4 : zoom < 22 ? 2 : 1;

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const beatAt = (x: number) => Math.max(0, (x - rect.left) / zoom);
    (e.target as Element).setPointerCapture(e.pointerId);
    const y = e.clientY - rect.top;
    const b0 = beatAt(e.clientX);
    let move: (ev: PointerEvent) => void;

    if (y < LOOP_STRIP + 4) {
      checkpoint();
      const edge = 8 / zoom;
      const bar = (b: number) => Math.round(b / BEATS_PER_BAR) * BEATS_PER_BAR;
      const setLoop = (start: number, end: number) =>
        commit((d) => void (d.loop = { enabled: true, start: Math.max(0, start), end: Math.max(start + BEATS_PER_BAR, end) }), { history: false });
      if (loop.enabled && Math.abs(b0 - loop.start) < edge) {
        move = (ev) => setLoop(Math.min(bar(beatAt(ev.clientX)), loop.end - BEATS_PER_BAR), loop.end);
      } else if (loop.enabled && Math.abs(b0 - loop.end) < edge) {
        move = (ev) => setLoop(loop.start, Math.max(bar(beatAt(ev.clientX)), loop.start + BEATS_PER_BAR));
      } else if (loop.enabled && b0 > loop.start && b0 < loop.end) {
        const len = loop.end - loop.start;
        move = (ev) => {
          const s = Math.max(0, bar(loop.start + beatAt(ev.clientX) - b0));
          setLoop(s, s + len);
        };
      } else {
        const anchor = Math.floor(b0 / BEATS_PER_BAR) * BEATS_PER_BAR;
        setLoop(anchor, anchor + BEATS_PER_BAR);
        move = (ev) => {
          const b = beatAt(ev.clientX);
          if (b >= anchor) setLoop(anchor, Math.ceil(b / BEATS_PER_BAR) * BEATS_PER_BAR);
          else setLoop(Math.floor(b / BEATS_PER_BAR) * BEATS_PER_BAR, anchor + BEATS_PER_BAR);
        };
      }
    } else {
      const snap = snapFor(zoom);
      const seek = (b: number) => (engine.position = e.altKey ? b : Math.round(b / snap) * snap);
      seek(b0);
      move = (ev) => seek(beatAt(ev.clientX));
    }
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="ruler" ref={ref} onPointerDown={onPointerDown}>
      <div className="loop-strip" />
      <RulerCap />
      {loop.enabled && (
        <div className="loop-range" style={{ left: loop.start * zoom, width: (loop.end - loop.start) * zoom }} />
      )}
      {Array.from({ length: bars }, (_, i) =>
        i % labelEvery === 0 ? (
          <div key={i} className="ruler-bar" style={{ left: i * BEATS_PER_BAR * zoom }}>
            <span>{i + 1}</span>
          </div>
        ) : null,
      )}
    </div>
  );
}

// ---------- Playhead ----------

function RulerCap() {
  const pos = usePosition();
  const zoom = useStore((s) => s.zoom);
  return <div className="ruler-cap" style={{ transform: `translateX(${pos * zoom}px)` }} />;
}

function Playhead({ scrollRef }: { scrollRef: RefObject<HTMLDivElement> }) {
  const pos = usePosition();
  const zoom = useStore((s) => s.zoom);
  const playing = useStore((s) => s.isPlaying);
  const x = HEADER_W + pos * zoom;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const right = el.scrollLeft + el.clientWidth;
    if (x > right - 60 || x < el.scrollLeft + HEADER_W) el.scrollLeft = Math.max(0, x - HEADER_W - 80);
  }, [x, playing, scrollRef]);

  return (
    <div className="playhead" style={{ transform: `translateX(${x}px)` }}>
      <div className="playhead-cap" />
    </div>
  );
}

// ---------- Tracks ----------

const TrackRow = memo(function TrackRow({ track, index, regions }: { track: Track; index: number; regions: Region[] }) {
  const zoom = useStore((s) => s.zoom);
  const selected = useStore((s) => s.selectedTrackId === track.id);
  const set = useStore((s) => s.set);
  const commit = useStore((s) => s.commit);
  const t = useT();

  const onLaneDoubleClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const beat = Math.floor((e.clientX - rect.left) / zoom / BEATS_PER_BAR) * BEATS_PER_BAR;
    const region: Region = { id: uid('rgn'), trackId: track.id, name: track.name, start: beat, length: BEATS_PER_BAR * (track.kind === 'drums' ? 1 : 2), notes: [] };
    commit((d) => void d.regions.push(region));
    useStore.getState().selectRegion(region);
    set({ bottom: 'editor' });
  };

  return (
    <div className={`track-row ${selected ? 'selected' : ''}`} style={{ height: TRACK_H, '--track': track.color } as CSSProperties}>
      <TrackHeader track={track} selected={selected} />
      <div
        className="lane"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) set({ selectedTrackId: track.id, selectedRegionId: null });
        }}
        onDoubleClick={onLaneDoubleClick}
        title={t('arr.laneHint')}
      >
        {regions.map((r) => (
          <RegionView key={r.id} region={r} track={track} trackIndex={index} />
        ))}
      </div>
    </div>
  );
});

function TrackHeader({ track, selected }: { track: Track; selected: boolean }) {
  const set = useStore((s) => s.set);
  const commit = useStore((s) => s.commit);
  const [renaming, setRenaming] = useState(false);
  const t = useT();
  const update = (fn: (t: Track) => void, history = true) =>
    commit((d) => fn(d.tracks.find((t) => t.id === track.id)!), { history });

  return (
    <div className={`track-header ${selected ? 'selected' : ''}`} onPointerDown={() => set({ selectedTrackId: track.id })}>
      <div className="th-color" />
      <div className="th-icon">{track.kind === 'drums' ? <I.DrumIcon /> : <I.KeysIcon />}</div>
      <div className="th-main">
        {renaming ? (
          <input
            className="th-rename"
            autoFocus
            defaultValue={track.name}
            onBlur={(e) => {
              update((t) => void (t.name = e.target.value || t.name));
              setRenaming(false);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <div className="th-name" onDoubleClick={() => setRenaming(true)} title={t('arr.renameHint')}>
            {track.name}
          </div>
        )}
        <div className="th-sub">{presetById(track.instrument)?.name}</div>
        <input
          className="th-vol"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={track.volume}
          onPointerDown={() => useStore.getState().checkpoint()}
          onChange={(e) => update((t) => void (t.volume = Number(e.target.value)), false)}
          title={t('sc.volume')}
        />
      </div>
      <div className="th-btns">
        <button className={`ms mute ${track.mute ? 'on' : ''}`} onClick={() => update((t) => void (t.mute = !t.mute))} title="Mute">
          M
        </button>
        <button className={`ms solo ${track.solo ? 'on' : ''}`} onClick={() => update((t) => void (t.solo = !t.solo))} title="Solo">
          S
        </button>
      </div>
      <button className="th-delete" onClick={() => commands.delete_track({ track_id: track.id })} title={t('arr.deleteTrack')}>
        <I.Trash width={14} height={14} />
      </button>
    </div>
  );
}

// ---------- Regions ----------

function RegionView({ region, track, trackIndex }: { region: Region; track: Track; trackIndex: number }) {
  const zoom = useStore((s) => s.zoom);
  const selected = useStore((s) => s.selectedRegionId === region.id);

  const startDrag = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    e.stopPropagation();
    const s = useStore.getState();
    s.selectRegion(region);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const snap = e.altKey && mode === 'resize' ? 0.25 : snapFor(zoom);
    const tracks = s.project.tracks;
    let started = false;

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / zoom;
      const dy = ev.clientY - y0;
      if (!started) {
        if (Math.abs(ev.clientX - x0) < 3 && Math.abs(dy) < 3) return;
        started = true;
        useStore.getState().checkpoint();
        if (e.altKey && mode === 'move') {
          // Alt-drag leaves a copy behind.
          const copy = { ...structuredClone(region), id: uid('rgn') };
          useStore.getState().commit((d) => void d.regions.push(copy), { history: false });
        }
      }
      useStore.getState().commit(
        (d) => {
          const r = d.regions.find((x) => x.id === region.id);
          if (!r) return;
          if (mode === 'move') {
            r.start = Math.max(0, Math.round((region.start + dx) / snap) * snap);
            const ti = clamp(trackIndex + Math.round(dy / TRACK_H), 0, tracks.length - 1);
            if (tracks[ti].kind === track.kind) r.trackId = tracks[ti].id;
          } else {
            r.length = Math.max(snap, Math.round((region.length + dx) / snap) * snap);
          }
        },
        { history: false },
      );
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`region ${selected ? 'selected' : ''} ${track.kind}`}
      style={{ left: region.start * zoom, width: Math.max(6, region.length * zoom - 1) }}
      onPointerDown={(e) => startDrag(e, 'move')}
      onDoubleClick={(e) => {
        e.stopPropagation();
        useStore.getState().set({ bottom: 'editor' });
      }}
    >
      <div className="region-head">{region.name}</div>
      <RegionPreview region={region} drums={track.kind === 'drums'} />
      <div className="region-resize" onPointerDown={(e) => startDrag(e, 'resize')} />
    </div>
  );
}

const RegionPreview = memo(function RegionPreview({ region, drums }: { region: Region; drums: boolean }) {
  const notes = region.notes.filter((n) => n.start < region.length);
  if (!notes.length) return <div className="region-body empty" />;
  let rowOf: (p: number) => number;
  let rows: number;
  if (drums) {
    rows = DRUM_PIECES.length;
    rowOf = (p) => Math.max(0, DRUM_PIECES.findIndex((d) => d.pitch === p));
  } else {
    const lo = Math.min(...notes.map((n) => n.pitch));
    const hi = Math.max(...notes.map((n) => n.pitch));
    rows = Math.max(12, hi - lo + 1);
    const pad = (rows - (hi - lo + 1)) / 2;
    rowOf = (p) => rows - 1 - (p - lo + pad);
  }
  const h = 100 / rows;
  return (
    <svg className="region-body" viewBox={`0 0 ${region.length} 100`} preserveAspectRatio="none">
      {notes.map((n) => (
        <rect
          key={n.id}
          x={n.start}
          y={rowOf(n.pitch) * h + h * 0.15}
          width={drums ? Math.min(0.12, n.duration) : Math.max(0.06, Math.min(n.duration, region.length - n.start) - 0.03)}
          height={Math.max(h * 0.7, 2.2)}
          rx={0.04}
          opacity={0.45 + n.velocity * 0.55}
        />
      ))}
    </svg>
  );
});
