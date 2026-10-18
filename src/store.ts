import { create } from 'zustand';
import type { AutoParam, BottomPanel, BridgeLogEntry, BridgeStatus, Project, Region, Track, TrackKind } from './types';
import { AUDIO_COLOR, DRUM_COLOR, TRACK_COLORS, uid } from './music';
import { defaultPreset, findInstrument, setCustomInstruments } from './audio/instruments';
import { ensureSamples } from './audio/samples';
import { t } from './i18n';

const STORAGE_KEY = 'openband.project.v1';
const HISTORY_LIMIT = 120;

export function emptyProject(name = t('name.untitled'), bpm = 110): Project {
  return {
    version: 1,
    name,
    bpm,
    key: 'Am',
    tracks: [],
    regions: [],
    loop: { enabled: false, start: 0, end: 16 },
    masterVolume: 0.8,
    metronome: false,
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
  past: Project[];
  future: Project[];

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

  /** Apply a mutation to a deep copy of the project. */
  commit: (mutate: (draft: Project) => void, opts?: { history?: boolean }) => void;
  /** Push a history snapshot once at the beginning of a drag gesture. */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  loadProject: (p: Project) => void;
  set: (partial: Partial<State>) => void;
  selectRegion: (r: Region | null) => void;
  notify: (msg: string) => void;
  logBridge: (e: Omit<BridgeLogEntry, 'id' | 'time'>) => void;
}

function loadSaved(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Project;
    return p && p.version === 1 && Array.isArray(p.tracks) ? p : null;
  } catch {
    return null;
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State>((set, get) => ({
  project: loadSaved() ?? emptyProject(),
  past: [],
  future: [],

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
    const { project, past } = get();
    const draft = structuredClone(project);
    mutate(draft);
    const history = opts?.history ?? true;
    set({
      project: draft,
      past: history ? [...past, project].slice(-HISTORY_LIMIT) : past,
      future: history ? [] : get().future,
    });
  },
  checkpoint: () => {
    const { project, past } = get();
    set({ past: [...past, project].slice(-HISTORY_LIMIT), future: [] });
  },
  undo: () => {
    const { past, project, future } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({ project: prev, past: past.slice(0, -1), future: [project, ...future] });
  },
  redo: () => {
    const { past, project, future } = get();
    const next = future[0];
    if (!next) return;
    set({ project: next, past: [...past, project], future: future.slice(1) });
  },
  loadProject: (p) => {
    const { project, past } = get();
    set({
      project: p,
      past: [...past, project].slice(-HISTORY_LIMIT),
      future: [],
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s.project));
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
