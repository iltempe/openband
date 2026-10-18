// UI for bringing sounds in: file pickers, drag & drop, the SoundFont preset browser and the
// editor for imported instruments.
import { useMemo, useState } from 'react';
import { create } from 'zustand';
import type { CustomInstrument, Track } from '../types';
import { getTrack, useStore } from '../store';
import { DRUM_PIECES, clamp, noteName } from '../music';
import { importSample, useSamples } from '../audio/samples';
import type { SoundFont } from '../audio/soundfont';
import { commands } from '../commands';
import { createSamplerFromFiles, importAudioFiles, instrumentFromSoundFont, openSoundFont, readFiles, readProjectFile, rootFor, setZones, spreadZones } from '../importers';
import { drumLabel, t, useT } from '../i18n';
import { Knob } from './Knob';
import * as I from './Icons';

const AUDIO_ACCEPT = 'audio/*,.wav,.mp3,.ogg,.oga,.flac,.aif,.aiff,.m4a,.webm';
const isSoundFont = (name: string) => /\.sf2$/i.test(name);
const isProject = (name: string) => /\.(openband|json)$/i.test(name);
const isMidi = (name: string) => /\.(mid|midi)$/i.test(name);

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

const notify = (msg: string) => useStore.getState().notify(msg);
const fail = (e: unknown) => notify(t('imp.failed', { error: (e as Error).message }));

/** Assign an instrument to the selected track when compatible, otherwise create a track for it. */
function assignInstrument(inst: CustomInstrument) {
  const s = useStore.getState();
  const selected = getTrack(s.project, s.selectedTrackId);
  if (selected && selected.kind === inst.kind) commands.update_track({ track_id: selected.id, instrument: inst.id });
  else commands.add_track({ instrument: inst.id });
}

export async function importSamplerFlow(kind: 'instrument' | 'drums') {
  const files = await pickFiles(AUDIO_ACCEPT, true);
  if (!files.length) return;
  try {
    const inst = await createSamplerFromFiles(await readFiles(files), kind);
    assignInstrument(inst);
    useStore.getState().set({ bottom: 'smart' });
    notify(t('imp.instrumentReady', { name: inst.name }));
  } catch (e) {
    fail(e);
  }
}

export async function importAudioFlow(opts: { trackId?: string; startBeat?: number } = {}) {
  const files = await pickFiles(AUDIO_ACCEPT, true);
  if (files.length) await importAudio(files, opts);
}

async function importAudio(files: File[], opts: { trackId?: string; startBeat?: number }) {
  try {
    notify(t('imp.loading'));
    const regions = await importAudioFiles(await readFiles(files), opts);
    notify(t('imp.audioReady', { n: regions.length }));
  } catch (e) {
    fail(e);
  }
}

export async function importSoundFontFlow(file?: File) {
  const f = file ?? (await pickFiles('.sf2'))[0];
  if (!f) return;
  try {
    notify(t('imp.loading'));
    useImportUi.setState({ soundfont: openSoundFont(await f.arrayBuffer()), soundfontName: f.name });
  } catch (e) {
    fail(e);
  }
}

export async function openProjectFile(f: File) {
  try {
    const p = await readProjectFile(await f.arrayBuffer());
    commands.import_project_json({ project: p });
    notify(t('menu.opened', { name: f.name }));
  } catch (e) {
    notify((e as Error).message);
  }
}

/** Files dropped anywhere: audio → clips, .sf2 → preset browser, projects → open, MIDI → import. */
export async function handleDroppedFiles(files: File[], target: { trackId?: string; startBeat?: number } = {}) {
  const sf = files.find((f) => isSoundFont(f.name));
  if (sf) return importSoundFontFlow(sf);
  const project = files.find((f) => isProject(f.name));
  if (project) return openProjectFile(project);
  const midi = files.find((f) => isMidi(f.name));
  if (midi && commands.import_midi_file) {
    try {
      await commands.import_midi_file({ file: midi });
    } catch (e) {
      fail(e);
    }
    return;
  }
  const audio = files.filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|oga|flac|aiff?|m4a|webm)$/i.test(f.name));
  if (!audio.length) return;
  const track = target.trackId ? getTrack(useStore.getState().project, target.trackId) : undefined;
  await importAudio(audio, { trackId: track?.kind === 'audio' ? track.id : undefined, startBeat: target.startBeat });
}

// ---------- SoundFont preset browser ----------

export const useImportUi = create<{ soundfont: SoundFont | null; soundfontName: string }>(() => ({ soundfont: null, soundfontName: '' }));

export function SoundFontDialog() {
  const sf = useImportUi((s) => s.soundfont);
  const fileName = useImportUi((s) => s.soundfontName);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState<number[]>([]);
  const t = useT();
  const presets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sf?.presets ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [sf, query]);
  if (!sf) return null;
  const close = () => {
    useImportUi.setState({ soundfont: null });
    setDone([]);
    setQuery('');
  };

  const pick = async (index: number) => {
    setBusy(index);
    try {
      const inst = await instrumentFromSoundFont(sf, index);
      assignInstrument(inst);
      setDone((d) => [...d, index]);
      notify(t('imp.instrumentReady', { name: inst.name }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <div className="modal-head">
          <div>
            <div className="lib-title">{t('sf.title')}</div>
            <div className="lib-sub">{t('sf.sub', { name: fileName, n: sf.presets.length })}</div>
          </div>
          <button className="icon-btn" onClick={close}>
            <I.Close />
          </button>
        </div>
        <input className="modal-search" autoFocus placeholder={t('sf.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="modal-list">
          {presets.map((p) => (
            <button key={p.index} className={`sf-preset ${done.includes(p.index) ? 'done' : ''}`} disabled={busy !== null} onClick={() => pick(p.index)}>
              <span className="sf-num">{sf.isDrumPreset(p) ? <I.DrumIcon width={13} height={13} /> : `${p.bank}:${p.program}`}</span>
              <span className="sf-name">{p.name}</span>
              <span className="sf-state">{busy === p.index ? t('sf.importing') : done.includes(p.index) ? t('sf.added') : t('sf.add')}</span>
            </button>
          ))}
          {!presets.length && <div className="ai-log-empty">{t('sf.none')}</div>}
        </div>
        <div className="modal-foot">{t('sf.hint')}</div>
      </div>
    </div>
  );
}

// ---------- imported instrument editor (Smart Controls) ----------

export function InstrumentEditor({ inst, track }: { inst: CustomInstrument; track: Track }) {
  const commit = useStore((s) => s.commit);
  const checkpoint = useStore((s) => s.checkpoint);
  const info = useSamples((s) => s.info);
  const t = useT();
  const update = (fn: (i: CustomInstrument) => void, history = false) =>
    commit((d) => fn(d.instruments!.find((i) => i.id === inst.id)!), { history });

  const loadPad = async (pitch: number) => {
    const [f] = await pickFiles(AUDIO_ACCEPT);
    if (!f) return;
    try {
      const s = await importSample(await f.arrayBuffer(), f.name, f.type);
      setZones(inst.id, [...inst.zones.filter((z) => !(z.lo <= pitch && z.hi >= pitch)), { sampleId: s.id, root: pitch, lo: pitch, hi: pitch }]);
    } catch (e) {
      fail(e);
    }
  };

  const addSamples = async () => {
    const files = await pickFiles(AUDIO_ACCEPT, true);
    if (!files.length) return;
    try {
      const added = [];
      for (const f of files) added.push(await importSample(await f.arrayBuffer(), f.name, f.type));
      setZones(inst.id, spreadZones([...inst.zones, ...added.map((a) => ({ sampleId: a.id, root: rootFor(a) }))]));
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="inst-editor">
      <div className="inst-head">
        <span className="smart-kicker">{inst.source === 'soundfont' ? 'SoundFont' : t('inst.sampler')}</span>
        <input className="inst-name" defaultValue={inst.name} key={inst.id} onBlur={(e) => update((i) => void (i.name = e.target.value || i.name), true)} />
        <Knob label={t('inst.attack')} size={40} value={inst.attack} min={0.001} max={2} defaultValue={0.003} onStart={checkpoint} onChange={(v) => update((i) => void (i.attack = v))} format={(v) => `${v.toFixed(3)} s`} />
        <Knob label={t('inst.release')} size={40} value={inst.release} min={0.01} max={5} defaultValue={0.35} onStart={checkpoint} onChange={(v) => update((i) => void (i.release = v))} format={(v) => `${v.toFixed(2)} s`} />
      </div>
      {inst.source === 'soundfont' ? (
        <div className="inst-note">{t('inst.sfInfo', { n: inst.zones.length })}</div>
      ) : track.kind === 'drums' ? (
        <div className="inst-zones">
          {[...DRUM_PIECES].reverse().map((piece) => {
            const z = inst.zones.find((x) => x.lo <= piece.pitch && x.hi >= piece.pitch);
            return (
              <div key={piece.pitch} className="inst-zone">
                <span className="seq-short">{piece.short}</span>
                <span className="inst-zone-name">{drumLabel(piece)}</span>
                <span className="inst-zone-sample">{z ? info[z.sampleId]?.name ?? '…' : '—'}</span>
                <button className="mini" onClick={() => loadPad(piece.pitch)}>{t('inst.load')}</button>
                {z && (
                  <button className="mini danger" onClick={() => setZones(inst.id, inst.zones.filter((x) => x !== z))}>
                    <I.Close width={12} height={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="inst-zones">
          {inst.zones.map((z, i) => (
            <div key={`${z.sampleId}-${i}`} className="inst-zone">
              <span className="inst-zone-sample">{info[z.sampleId]?.name ?? '…'}</span>
              <label>{t('inst.root')}</label>
              <input
                type="number"
                className="inst-root"
                min={0}
                max={127}
                value={z.root}
                onChange={(e) => {
                  const root = clamp(Math.round(Number(e.target.value)), 0, 127);
                  setZones(inst.id, spreadZones(inst.zones.map((x, j) => ({ sampleId: x.sampleId, root: j === i ? root : x.root }))));
                }}
              />
              <span className="inst-zone-range">
                {noteName(z.root)} · {noteName(z.lo)}–{noteName(z.hi)}
              </span>
              {inst.zones.length > 1 && (
                <button className="mini danger" onClick={() => setZones(inst.id, spreadZones(inst.zones.filter((_, j) => j !== i)))}>
                  <I.Close width={12} height={12} />
                </button>
              )}
            </div>
          ))}
          <button className="mini" onClick={addSamples}>
            <I.Plus width={12} height={12} /> {t('inst.addSamples')}
          </button>
        </div>
      )}
    </div>
  );
}
