import { create } from 'zustand';
import { reconcileAnnotations } from './annotations';
import type { ActiveTransaction, AutoParam, BottomPanel, HistoryEntry, BridgeLogEntry, BridgeStatus, Project, Region, Track, TrackKind } from './types';
import { AUDIO_COLOR, DRUM_COLOR, TRACK_COLORS, uid } from './music';
import { defaultPreset, findInstrument, setCustomInstruments } from './audio/instruments';
import { ensureSamples } from './audio/samples';
import { t } from './i18n';
import { migrate } from './migrations';
import { emitStudioEvent, notifyProjectChanged } from './events';

const STORAGE_KEY = 'openband.project.v2';
/** Autosave key used by OpenBand 0.1 (schema v1), still read as a fallback. */
const LEGACY_STORAGE_KEY = 'openband.project.v1';
const HISTORY_LIMIT = 120;

export function emptyProject(name = t('name.untitled'), bpm = 110): Project {
  return {
    version: 2,
    name,
    bpm,
    key: 'Am',
    tracks: [],
    regions: [],
    loop: { enabled: false, start: 0, end: 16 },
    masterVolume: 0.8,
    metronome: false,
    meta: { projectId: uid('song'), createdAt: Date.now(), updatedAt: Date.now() },
  };
}

export function makeTrack(project: Project, kind: TrackKind, instrument?: string, name?: string): Track {
  const found = findInstrument(instrument ?? '');
  const preset = found && found.kind === kind ? found : findInstrument(defaultPreset(kind))!;
  const melodicCount = project.tracks.filter((t) => t.kind === 'instrument').length;
  return {
    id: uid('trk'),
    name: name ?? preset.name,
    kind,
    instrument: preset.id,
    color: kind === 'drums' ? DRUM_COLOR : kind === 'audio' ? AUDIO_COLOR : TRACK_COLORS[melodicCount % TRACK_COLORS.length],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    reverb: kind === 'drums' ? 0.08 : kind === 'audio' ? 0.05 : 0.22,
    delay: 0,
    cutoff: preset.cutoff,
  };
}

interface State {
  project: Project;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Open transaction: commits inside it become a single undo step when it ends. */
  activeTransaction: ActiveTransaction | null;

  selectedTrackId: string | null;
  selectedRegionId: string | null;
  selectedNoteIds: string[];

  isPlaying: boolean;
  isRecording: boolean;
  audioReady: boolean;

  libraryOpen: boolean;
  aiOpen: boolean;
  keyboardOpen: boolean;
  bottom: BottomPanel;
  zoom: number;
  /** Plugin GUI window: the track and effect slot (null = the track's plugin instrument). */
  pluginWindow: { trackId: string; slotId: string | null } | null;
  /** Open automation lanes: track id → parameter shown. */
  automationLanes: Record<string, AutoParam>;

  octave: number;
  velocity: number;

  bridgeStatus: BridgeStatus;
  bridgeLog: BridgeLogEntry[];
  toast: string | null;

  /** Apply a mutation to a deep copy of the project. Outside a transaction it is its own undo step. */
  commit: (mutate: (draft: Project) => void, opts?: { history?: boolean; label?: string }) => void;
  /** Start of a UI gesture (drag, knob): everything until pointer-up is one undo step. */
  checkpoint: (label?: unknown) => void;
  beginTransaction: (label: string, source: 'ui' | 'ai', opts?: { auto?: boolean }) => string;
  endTransaction: (txId?: string) => HistoryEntry | null;
  /** Count one more command in the open transaction. */
  countCommand: () => void;
  undo: (steps?: number) => void;
  redo: (steps?: number) => void;
  /** Replace the project (any schema version: it is migrated). */
  loadProject: (p: unknown) => void;
  set: (partial: Partial<State>) => void;
  selectRegion: (r: Region | null) => void;
  notify: (msg: string) => void;
  logBridge: (e: Omit<BridgeLogEntry, 'id' | 'time'>) => void;
}

function loadSaved(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? migrate(raw) : null;
  } catch {
    return null;
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

const entry = (project: Project, label: string, source: 'ui' | 'ai', commands: number): HistoryEntry => ({ id: uid('h'), project, label, source, commands, at: Date.now() });

/** > 0 while an AI command is running (set by runCommand), so commits know who made them. */
/**
 * In a multiplayer room undo goes through the room's per-user undo manager (you undo your own work,
 * not other people's). Steps are still delimited by the transactions below.
 */
export interface UndoOverride {
  undo(): void;
  redo(): void;
  /** Close the current undo step. */
  boundary(): void;
}
let undoOverride: UndoOverride | null = null;
export const setUndoOverride = (o: UndoOverride | null) => void (undoOverride = o);

let aiDepth = 0;
export const enterAiCommand = () => void aiDepth++;
export const exitAiCommand = () => void (aiDepth = Math.max(0, aiDepth - 1));
/** True while a command sent by the AI is running. */
export const isAiCommand = () => aiDepth > 0;

export const useStore = create<State>((set, get) => ({
  project: loadSaved() ?? emptyProject(),
  past: [],
  future: [],
  activeTransaction: null,

  selectedTrackId: null,
  selectedRegionId: null,
  selectedNoteIds: [],

  isPlaying: false,
  isRecording: false,
  audioReady: false,

  libraryOpen: true,
  aiOpen: false,
  keyboardOpen: false,
  bottom: 'smart',
  zoom: 34,
  automationLanes: {},
  pluginWindow: null,

  octave: 4,
  velocity: 0.8,

  bridgeStatus: 'connecting',
  bridgeLog: [],
  toast: null,

  commit: (mutate, opts) => {
    // A user edit while the AI's change is still open closes the AI step first, so the two don't merge.
    const open = get().activeTransaction;
    if (open?.source === 'ai' && aiDepth === 0) get().endTransaction(open.id);
    const { project, past, activeTransaction } = get();
    const draft = structuredClone(project);
    mutate(draft);
    // Deleting what an annotation points at orphans it (it isn't deleted); undo brings it back.
    if (draft.annotations?.length) reconcileAnnotations(draft);
    const history = (opts?.history ?? true) && !activeTransaction;
    set({
      project: draft,
      past: history ? [...past, entry(project, opts?.label ?? t('hist.edit'), 'ui', 1)].slice(-HISTORY_LIMIT) : past,
      future: history ? [] : get().future,
    });
    if (history) undoOverride?.boundary();
    // A standalone user edit (not inside an AI command or transaction).
    if (history && aiDepth === 0) emitStudioEvent({ kind: 'user_edit', label: opts?.label ?? t('hist.edit') });
    if (!activeTransaction) notifyProjectChanged();
  },
  checkpoint: (label) => {
    const id = get().beginTransaction(typeof label === 'string' ? label : t('hist.edit'), 'ui');
    if (typeof window !== 'undefined') window.addEventListener('pointerup', () => get().endTransaction(id), { once: true });
  },
  beginTransaction: (label, source, opts) => {
    const open = get().activeTransaction;
    if (open) {
      set({ activeTransaction: { ...open, depth: open.depth + 1 } });
      return open.id;
    }
    undoOverride?.boundary();
    const tx: ActiveTransaction = { id: uid('tx'), label, source, commands: 0, snapshot: get().project, depth: 1, auto: opts?.auto };
    set({ activeTransaction: tx });
    return tx.id;
  },
  endTransaction: (txId) => {
    const tx = get().activeTransaction;
    if (!tx || (txId && tx.id !== txId)) return null;
    if (tx.depth > 1) {
      set({ activeTransaction: { ...tx, depth: tx.depth - 1 } });
      return null;
    }
    const { project, past } = get();
    const changed = project !== tx.snapshot && JSON.stringify(project) !== JSON.stringify(tx.snapshot);
    if (!changed) {
      set({ activeTransaction: null });
      return null;
    }
    undoOverride?.boundary();
    const e: HistoryEntry = { id: tx.id, project: tx.snapshot, label: tx.label, source: tx.source, commands: Math.max(1, tx.commands), at: Date.now() };
    set({ activeTransaction: null, past: [...past, e].slice(-HISTORY_LIMIT), future: [] });
    if (tx.source === 'ui') emitStudioEvent({ kind: 'user_edit', label: tx.label });
    notifyProjectChanged();
    return e;
  },
  countCommand: () => {
    const tx = get().activeTransaction;
    if (tx) set({ activeTransaction: { ...tx, commands: tx.commands + 1 } });
  },
  undo: (steps = 1) => {
    const open = get().activeTransaction;
    if (open) get().endTransaction(open.id);
    if (undoOverride) {
      for (let i = 0; i < steps; i++) undoOverride.undo();
      return;
    }
    for (let i = 0; i < steps; i++) {
      const { past, project, future } = get();
      const prev = past[past.length - 1];
      if (!prev) return;
      set({ project: prev.project, past: past.slice(0, -1), future: [{ ...prev, project }, ...future] });
      notifyProjectChanged();
    }
  },
  redo: (steps = 1) => {
    if (undoOverride) {
      for (let i = 0; i < steps; i++) undoOverride.redo();
      return;
    }
    for (let i = 0; i < steps; i++) {
      const { past, project, future } = get();
      const next = future[0];
      if (!next) return;
      set({ project: next.project, past: [...past, { ...next, project }], future: future.slice(1) });
      notifyProjectChanged();
    }
  },
  loadProject: (raw) => {
    const p = migrate(raw);
    const { project, past, activeTransaction } = get();
    set({
      project: p,
      // Inside a transaction (e.g. building a template) the load is part of that one undo step.
      past: activeTransaction ? past : [...past, entry(project, t('hist.load'), 'ui', 1)].slice(-HISTORY_LIMIT),
      future: activeTransaction ? get().future : [],
      selectedRegionId: null,
      selectedNoteIds: [],
      selectedTrackId: p.tracks[0]?.id ?? null,
    });
  },
  set: (partial) => set(partial),
  selectRegion: (r) =>
    set({ selectedRegionId: r?.id ?? null, selectedTrackId: r?.trackId ?? get().selectedTrackId, selectedNoteIds: [] }),
  notify: (msg) => {
    clearTimeout(toastTimer);
    set({ toast: msg });
    toastTimer = setTimeout(() => set({ toast: null }), 2600);
  },
  logBridge: (e) =>
    set({ bridgeLog: [{ ...e, id: uid('log'), time: Date.now() }, ...get().bridgeLog].slice(0, 200) }),
}));

/** Every sample a project depends on (imported instruments and audio clips). */
export const projectSampleIds = (p: Project) => [
  ...(p.instruments ?? []).flatMap((i) => i.zones.map((z) => z.sampleId)),
  ...p.regions.flatMap((r) => (r.audio ? [r.audio.sampleId] : [])),
  ...(p.reference ? [p.reference.sampleId] : []),
];

// Keep the imported-instrument registry and the sample cache in step with the project.
setCustomInstruments(useStore.getState().project.instruments);
void ensureSamples(projectSampleIds(useStore.getState().project));
useStore.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  if (s.project.instruments !== prev.project.instruments) setCustomInstruments(s.project.instruments);
  void ensureSamples(projectSampleIds(s.project));
});

// Debounced autosave.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const p = s.project;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p.meta ? { ...p, meta: { ...p.meta, updatedAt: Date.now() } } : p));
    } catch {
      /* storage unavailable */
    }
  }, 400);
});

export const hasSavedProject = () => loadSaved() !== null;

// ---------- selectors ----------
export const getTrack = (p: Project, id: string | null) => p.tracks.find((t) => t.id === id);
export const getRegion = (p: Project, id: string | null) => p.regions.find((r) => r.id === id);
export const projectEnd = (p: Project) => p.regions.reduce((m, r) => Math.max(m, r.start + r.length), 0);
