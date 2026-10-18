// High-level command API. This is what the MCP bridge calls, and the UI reuses parts of it.
// Bars are 1-based (bar 1 starts at beat 0); positions inside regions are in beats.
import type { Note, Project, Region, Track, TrackKind } from './types';
import { BEATS_PER_BAR, KEYS, clamp, drumByPitch, noteName, parseChord, parsePitch, uid } from './music';
import { PRESETS, customInstruments, findInstrument } from './audio/instruments';
import { getBuffer, importSample, useSamples } from './audio/samples';
import { normalizeFx } from './audio/fx';
import { AUTO_PARAMS, autoParam, sortPoints } from './automation';
import type { AutoParam } from './types';
import { presetForProgram, readMidi, writeMidi, type MidiSong } from './midi';
import { addPluginEffect, addPluginInstrument, captureWamStates, getPluginParams, removePluginEffect, searchPlugins, setPluginParams, updateSlot } from './plugins';
import { wamCatalog } from './audio/wam';
import { analyzeHarmony, analyzeMix, detectKey, spectrogram } from './mixAnalysis';
import { lint } from './lint/engine';
import { SECTION_COLORS, assertNoOverlap, deleteSection, duplicateSection, energyProfile, moveSection, proposeSections, sortSections, splitRegionAt } from './structure';
import { useAnalysis } from './mixAnalysis';
import { buildLines } from './lyrics/lines';
import { alignProject, prosodyIssues } from './lyrics/project';
import { suggestRhythm } from './lyrics/prosody';
import { toChordPro, toChordText } from './lyrics/chordpro';
import { analyzeChords } from './analysis/harmony';
import type { LyricLine } from './types';
import type { Section, SectionKind } from './types';
import { hash as lintHash } from './lint/util';
import type { LintIssue } from './lint/types';
import type { Severity } from './types';
import { addAudioRegion, guessDrumPads, instrumentFromSoundFont, openSoundFont, rootFor, spreadZones } from './importers';
import { emptyProject, enterAiCommand, exitAiCommand, getRegion, getTrack, makeTrack, projectEnd, useStore } from './store';
import { engine } from './audio/engine';
import { audioRegionToMidi, audioToMidi, recordFromMic, requestRecording, useMic } from './recording';
import { download, renderProject } from './audio/render';
import { t as tr, useLang } from './i18n';

const useLangOf = () => useLang.getState().lang;
import { migrate } from './migrations';

type P = Record<string, any>;

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const safeName = (name: string) => name.replace(/[^\w\- ]+/g, '').trim() || 'openband';

/** Add the parts of a MIDI song as new tracks (or replace the project). */
function importMidiSong(song: MidiSong, fileName: string, replace: boolean) {
  const p = st().project;
  const empty = !p.regions.length;
  if (replace) commands.new_project({ name: song.name || fileName.replace(/\.midi?$/i, ''), bpm: song.bpm ?? p.bpm });
  else if (empty && song.bpm) st().commit((d) => void (d.bpm = clamp(song.bpm!, 40, 240)));
  const created: { track_id: string; name: string; instrument: string; notes: number }[] = [];
  for (const part of song.parts) {
    const drums = part.channel === 9;
    const instrument = drums ? 'kit-studio' : presetForProgram(part.program);
    // Format-0 files often carry only the song title as name: then name the track after its sound.
    const name = part.name && part.name !== song.name ? part.name : undefined;
    const track = makeTrack(st().project, drums ? 'drums' : 'instrument', instrument, name);
    st().commit((d) => void d.tracks.push(track));
    const first = Math.floor(part.notes[0].start / BEATS_PER_BAR) * BEATS_PER_BAR;
    const last = Math.max(...part.notes.map((n) => n.start + n.duration));
    const notes: Note[] = part.notes.map((n) => ({ id: uid('n'), pitch: n.pitch, start: n.start - first, duration: Math.max(0.0625, n.duration), velocity: clamp(n.velocity, 0.05, 1) }));
    createRegion(track.id, first, Math.max(BEATS_PER_BAR, Math.ceil((last - first) / BEATS_PER_BAR) * BEATS_PER_BAR), track.name, notes);
    created.push({ track_id: track.id, name: track.name, instrument, notes: notes.length });
  }
  return { bpm: st().project.bpm, tracks: created };
}

function requireSample(id: string) {
  const info = useSamples.getState().info[id];
  if (!info || !getBuffer(id)) throw new Error(`Sample "${id}" not found. Call import_sample or list_samples.`);
  return info;
}

const SAMPLE_DRUMS: Record<string, number> = { kick: 36, rim: 37, snare: 38, clap: 39, hihat: 42, lowtom: 45, openhat: 46, midtom: 48, crash: 49, hightom: 50, ride: 51 };

const st = () => useStore.getState();
const barToBeat = (bar: number) => (Math.max(1, bar) - 1) * BEATS_PER_BAR;
const beatToBar = (beat: number) => beat / BEATS_PER_BAR + 1;

function requireTrack(p: Project, id: string): Track {
  const t = getTrack(p, id) ?? p.tracks.find((tr) => tr.name.toLowerCase() === String(id).toLowerCase());
  if (!t) throw new Error(`Track "${id}" not found. Call get_project to list track ids.`);
  return t;
}
function requireRegion(p: Project, id: string): Region {
  const r = getRegion(p, id);
  if (!r) throw new Error(`Region "${id}" not found. Call get_project to list region ids.`);
  return r;
}

interface NoteInput {
  pitch: number | string;
  start: number;
  duration?: number;
  velocity?: number;
}

function toNotes(input: NoteInput[] = [], drums: boolean): Note[] {
  return input.map((n) => ({
    id: uid('n'),
    pitch: parsePitch(n.pitch, drums),
    start: Math.max(0, Number(n.start) || 0),
    duration: Math.max(0.0625, Number(n.duration ?? (drums ? 0.25 : 1))),
    velocity: clamp(Number(n.velocity ?? 0.8), 0.05, 1),
  }));
}

const describeNote = (n: Note, drums: boolean) => ({
  id: n.id,
  pitch: n.pitch,
  name: drums ? drumByPitch(n.pitch)?.name ?? noteName(n.pitch) : noteName(n.pitch),
  start: +n.start.toFixed(4),
  duration: +n.duration.toFixed(4),
  velocity: +n.velocity.toFixed(2),
});

function summarize(p: Project, includeNotes = false) {
  return {
    name: p.name,
    bpm: p.bpm,
    key: p.key,
    time_signature: '4/4',
    length_bars: Math.ceil(projectEnd(p) / BEATS_PER_BAR),
    loop: { enabled: p.loop.enabled, start_bar: beatToBar(p.loop.start), end_bar: beatToBar(p.loop.end) },
    metronome: p.metronome,
    master_volume: p.masterVolume,
    tracks: p.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      instrument: t.instrument,
      volume: t.volume,
      pan: t.pan,
      mute: t.mute,
      solo: t.solo,
      reverb: t.reverb,
      delay: t.delay,
      tone: t.cutoff,
      ...(t.fx && (t.fx.amp.on || t.fx.eq.on || t.fx.comp.on) ? { effects: describeFx(t) } : {}),
      ...(t.automation && Object.values(t.automation).some((x) => x?.length)
        ? {
            automation: Object.fromEntries(
              Object.entries(t.automation)
                .filter(([, pts]) => pts?.length)
                .map(([k, pts]) => [k, pts!.map((pt) => ({ bar: +beatToBar(pt.beat).toFixed(4), value: +pt.value.toFixed(3) }))]),
            ),
          }
        : {}),
      regions: p.regions
        .filter((r) => r.trackId === t.id)
        .sort((a, b) => a.start - b.start)
        .map((r) => ({
          id: r.id,
          name: r.name,
          start_bar: beatToBar(r.start),
          length_bars: r.length / BEATS_PER_BAR,
          ...(r.audio
            ? { audio: { sample_id: r.audio.sampleId, offset_seconds: r.audio.offset, gain: r.audio.gain } }
            : { note_count: r.notes.length }),
          ...(includeNotes ? { notes: r.notes.map((n) => describeNote(n, t.kind === 'drums')) } : {}),
        })),
    })),
  };
}

function describeFx(t: Track) {
  const fx = normalizeFx(t.fx);
  return {
    amp: fx.amp,
    eq: { on: fx.eq.on, low: fx.eq.low, mid: fx.eq.mid, high: fx.eq.high, mid_freq: fx.eq.midFreq },
    compressor: fx.comp,
  };
}

function createRegion(trackId: string, startBeat: number, lengthBeats: number, name: string, notes: Note[]): Region {
  const region: Region = { id: uid('rgn'), trackId, name, start: startBeat, length: lengthBeats, notes };
  st().commit((d) => {
    d.regions.push(region);
  });
  st().selectRegion(region);
  return region;
}

function regionLengthFor(notes: Note[], requestedBars?: number) {
  if (requestedBars && requestedBars > 0) return requestedBars * BEATS_PER_BAR;
  const end = notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
  return Math.max(1, Math.ceil(end / BEATS_PER_BAR)) * BEATS_PER_BAR;
}

export const commands: Record<string, (args: P) => unknown> = {
  get_project: ({ include_notes }) => summarize(st().project, !!include_notes),

  get_status: () => {
    const pos = engine.position;
    return {
      playing: engine.playing,
      recording: st().isRecording,
      audio_unlocked: engine.contextRunning,
      position: { bar: Math.floor(pos / BEATS_PER_BAR) + 1, beat: +((pos % BEATS_PER_BAR) + 1).toFixed(2) },
      selected_track_id: st().selectedTrackId,
      selected_region_id: st().selectedRegionId,
    };
  },

  list_instruments: () => ({
    instruments: PRESETS.map((p) => ({ id: p.id, name: p.name, kind: p.kind, category: p.category, description: p.description })),
    imported_instruments: customInstruments().map((c) => ({ id: c.id, name: c.name, kind: c.kind, source: c.source, zones: c.zones.length })),
    audio_tracks: 'add_track with kind "audio", then add_audio_region with a sample_id from import_sample',
    drum_pieces: 'kick(36) snare(38) clap(39) rim(37) hihat(42) openhat(46) lowtom(45) midtom(48) hightom(50) crash(49) ride(51)',
    keys: KEYS,
  }),

  new_project: ({ name, bpm, key }) => {
    const p = emptyProject(name ?? tr('name.newSong'), clamp(Number(bpm ?? 110), 40, 240));
    if (key) p.key = key;
    engine.stop();
    engine.position = 0;
    st().loadProject(p);
    return summarize(p);
  },

  rename_project: ({ name }) => {
    st().commit((d) => void (d.name = String(name)));
    return { name };
  },

  set_tempo: ({ bpm }) => {
    const v = clamp(Number(bpm), 40, 240);
    st().commit((d) => void (d.bpm = v));
    return { bpm: v };
  },

  set_key: ({ key }) => {
    st().commit((d) => void (d.key = String(key)));
    return { key };
  },

  set_master_volume: ({ volume }) => {
    st().commit((d) => void (d.masterVolume = clamp(Number(volume), 0, 1)));
    return { master_volume: st().project.masterVolume };
  },

  add_track: ({ kind, instrument, name }) => {
    const preset = instrument ? findInstrument(instrument) : undefined;
    if (instrument && !preset) throw new Error(`Unknown instrument "${instrument}". Call list_instruments.`);
    const k: TrackKind = preset?.kind ?? (kind === 'drums' || kind === 'audio' ? kind : 'instrument');
    const track = makeTrack(st().project, k, preset?.id, name);
    st().commit((d) => void d.tracks.push(track));
    st().set({ selectedTrackId: track.id });
    return { track_id: track.id, name: track.name, kind: track.kind, instrument: track.instrument };
  },

  update_track: ({ track_id, name, instrument, volume, pan, mute, solo, reverb, delay, tone }) => {
    const t = requireTrack(st().project, track_id);
    if (instrument !== undefined) {
      const preset = findInstrument(instrument);
      if (!preset) throw new Error(`Unknown instrument "${instrument}"`);
      if (preset.kind !== t.kind) throw new Error(`Instrument "${instrument}" is for ${preset.kind} tracks, track is ${t.kind}`);
    }
    st().commit((d) => {
      const tr = d.tracks.find((x) => x.id === t.id)!;
      if (name !== undefined) tr.name = String(name);
      if (instrument !== undefined) {
        tr.instrument = instrument;
        tr.cutoff = findInstrument(instrument)!.cutoff;
      }
      if (volume !== undefined) tr.volume = clamp(Number(volume), 0, 1);
      if (pan !== undefined) tr.pan = clamp(Number(pan), -1, 1);
      if (mute !== undefined) tr.mute = !!mute;
      if (solo !== undefined) tr.solo = !!solo;
      if (reverb !== undefined) tr.reverb = clamp(Number(reverb), 0, 1);
      if (delay !== undefined) tr.delay = clamp(Number(delay), 0, 1);
      if (tone !== undefined) tr.cutoff = clamp(Number(tone), 0, 1);
    });
    return summarize(st().project).tracks.find((x) => x.id === t.id);
  },

  set_track_effects: ({ track_id, amp, eq, compressor }) => {
    const t = requireTrack(st().project, track_id);
    const num = (v: unknown, lo: number, hi: number) => (v === undefined ? undefined : clamp(Number(v), lo, hi));
    st().commit((d) => {
      const tr = d.tracks.find((x) => x.id === t.id)!;
      const fx = normalizeFx(tr.fx);
      if (amp) {
        if (amp.on !== undefined) fx.amp.on = !!amp.on;
        fx.amp.drive = num(amp.drive, 0, 1) ?? fx.amp.drive;
        fx.amp.tone = num(amp.tone, 0, 1) ?? fx.amp.tone;
        fx.amp.level = num(amp.level, 0, 1) ?? fx.amp.level;
        if (amp.on === undefined) fx.amp.on = true;
      }
      if (eq) {
        if (eq.on !== undefined) fx.eq.on = !!eq.on;
        fx.eq.low = num(eq.low, -15, 15) ?? fx.eq.low;
        fx.eq.mid = num(eq.mid, -15, 15) ?? fx.eq.mid;
        fx.eq.high = num(eq.high, -15, 15) ?? fx.eq.high;
        fx.eq.midFreq = num(eq.mid_freq, 200, 6000) ?? fx.eq.midFreq;
        if (eq.on === undefined) fx.eq.on = true;
      }
      if (compressor) {
        const c = compressor;
        if (c.on !== undefined) fx.comp.on = !!c.on;
        fx.comp.threshold = num(c.threshold, -60, 0) ?? fx.comp.threshold;
        fx.comp.ratio = num(c.ratio, 1, 20) ?? fx.comp.ratio;
        fx.comp.attack = num(c.attack, 0.001, 0.2) ?? fx.comp.attack;
        fx.comp.release = num(c.release, 0.02, 1) ?? fx.comp.release;
        fx.comp.makeup = num(c.makeup, 0, 24) ?? fx.comp.makeup;
        if (c.on === undefined) fx.comp.on = true;
      }
      tr.fx = fx;
    });
    return { track_id: t.id, effects: describeFx(getTrack(st().project, t.id)!) };
  },

  set_automation: ({ track_id, param, points, replace }) => {
    const t = requireTrack(st().project, track_id);
    if (!AUTO_PARAMS.some((p) => p.id === param)) throw new Error(`Unknown parameter "${param}". Use: ${AUTO_PARAMS.map((p) => p.id).join(', ')}`);
    const info = autoParam(param as AutoParam);
    const parsed = ((points ?? []) as { bar?: number; beat?: number; value: number }[]).map((pt) => ({
      beat: pt.beat !== undefined ? Math.max(0, Number(pt.beat)) : barToBeat(Number(pt.bar ?? 1)),
      value: clamp(Number(pt.value), info.min, info.max),
    }));
    st().commit((d) => {
      const tr = d.tracks.find((x) => x.id === t.id)!;
      tr.automation ??= {};
      const keep = replace === false ? tr.automation[param as AutoParam] ?? [] : [];
      tr.automation[param as AutoParam] = sortPoints([...keep, ...parsed]);
    });
    return { track_id: t.id, param, points: getTrack(st().project, t.id)!.automation![param as AutoParam]!.length };
  },

  clear_automation: ({ track_id, param }) => {
    const t = requireTrack(st().project, track_id);
    st().commit((d) => {
      const tr = d.tracks.find((x) => x.id === t.id)!;
      if (!tr.automation) return;
      if (param) delete tr.automation[param as AutoParam];
      else delete tr.automation;
    });
    return { track_id: t.id, cleared: param ?? 'all' };
  },

  delete_track: ({ track_id }) => {
    const t = requireTrack(st().project, track_id);
    st().commit((d) => {
      d.tracks = d.tracks.filter((x) => x.id !== t.id);
      d.regions = d.regions.filter((r) => r.trackId !== t.id);
    });
    if (st().selectedTrackId === t.id) st().set({ selectedTrackId: null, selectedRegionId: null });
    return { deleted: t.id };
  },

  add_region: ({ track_id, start_bar, length_bars, name, notes }) => {
    const t = requireTrack(st().project, track_id);
    if (t.kind === 'audio') throw new Error('Audio tracks hold audio clips: use add_audio_region');
    const parsed = toNotes(notes, t.kind === 'drums');
    const region = createRegion(t.id, barToBeat(start_bar ?? 1), regionLengthFor(parsed, length_bars), name ?? t.name, parsed);
    return { region_id: region.id, start_bar: beatToBar(region.start), length_bars: region.length / BEATS_PER_BAR, note_count: parsed.length };
  },

  update_region: ({ region_id, start_bar, length_bars, name, track_id, gain, offset_seconds }) => {
    const r = requireRegion(st().project, region_id);
    let target: Track | undefined;
    if (track_id) {
      target = requireTrack(st().project, track_id);
      const src = requireTrack(st().project, r.trackId);
      if (target.kind !== src.kind) throw new Error('Regions can only move between tracks of the same kind');
    }
    st().commit((d) => {
      const x = d.regions.find((y) => y.id === r.id)!;
      if (start_bar !== undefined) x.start = barToBeat(start_bar);
      if (length_bars !== undefined) x.length = Math.max(0.25, Number(length_bars)) * BEATS_PER_BAR;
      if (name !== undefined) x.name = String(name);
      if (target) x.trackId = target.id;
      if (x.audio && gain !== undefined) x.audio.gain = clamp(Number(gain), 0, 2);
      if (x.audio && offset_seconds !== undefined) x.audio.offset = Math.max(0, Number(offset_seconds));
    });
    return { region_id: r.id };
  },

  delete_region: ({ region_id }) => {
    const r = requireRegion(st().project, region_id);
    st().commit((d) => void (d.regions = d.regions.filter((x) => x.id !== r.id)));
    if (st().selectedRegionId === r.id) st().set({ selectedRegionId: null });
    return { deleted: r.id };
  },

  duplicate_region: ({ region_id, times }) => {
    const r = requireRegion(st().project, region_id);
    const n = clamp(Math.round(Number(times ?? 1)), 1, 64);
    const ids: string[] = [];
    st().commit((d) => {
      for (let i = 1; i <= n; i++) {
        const copy: Region = {
          ...structuredClone(r),
          id: uid('rgn'),
          start: r.start + r.length * i,
          notes: r.notes.map((nt) => ({ ...nt, id: uid('n') })),
        };
        ids.push(copy.id);
        d.regions.push(copy);
      }
    });
    return { region_ids: ids };
  },

  get_region_notes: ({ region_id }) => {
    const p = st().project;
    const r = requireRegion(p, region_id);
    const drums = getTrack(p, r.trackId)?.kind === 'drums';
    return {
      region_id: r.id,
      length_beats: r.length,
      notes: [...r.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch).map((n) => describeNote(n, drums)),
    };
  },

  add_notes: ({ region_id, notes, replace, extend }) => {
    const p = st().project;
    const r = requireRegion(p, region_id);
    const parsed = toNotes(notes, getTrack(p, r.trackId)?.kind === 'drums');
    st().commit((d) => {
      const x = d.regions.find((y) => y.id === r.id)!;
      x.notes = replace ? parsed : [...x.notes, ...parsed];
      if (extend !== false) x.length = Math.max(x.length, regionLengthFor(x.notes));
    });
    return { region_id: r.id, added: parsed.length, total: st().project.regions.find((y) => y.id === r.id)!.notes.length };
  },

  remove_notes: ({ region_id, note_ids, pitch, from_beat, to_beat }) => {
    const p = st().project;
    const r = requireRegion(p, region_id);
    const drums = getTrack(p, r.trackId)?.kind === 'drums';
    const pitchNum = pitch !== undefined ? parsePitch(pitch, drums) : undefined;
    const ids = new Set<string>(note_ids ?? []);
    const doomed = (n: Note) => {
      if (ids.size && !ids.has(n.id)) return false;
      if (pitchNum !== undefined && n.pitch !== pitchNum) return false;
      if (from_beat !== undefined && n.start < from_beat) return false;
      if (to_beat !== undefined && n.start >= to_beat) return false;
      return true;
    };
    const before = r.notes.length;
    st().commit((d) => {
      const x = d.regions.find((y) => y.id === r.id)!;
      x.notes = x.notes.filter((n) => !doomed(n));
    });
    return { removed: before - st().project.regions.find((y) => y.id === r.id)!.notes.length };
  },

  update_notes: ({ region_id, notes }) => {
    const p = st().project;
    const r = requireRegion(p, region_id);
    const drums = getTrack(p, r.trackId)?.kind === 'drums';
    const list = (notes ?? []) as { id: string; pitch?: number | string; start?: number; duration?: number; velocity?: number }[];
    const missing = list.filter((n) => !r.notes.some((x) => x.id === n.id)).map((n) => n.id);
    if (missing.length) throw new Error(`Notes not in region ${r.id}: ${missing.join(', ')}. Call get_region_notes.`);
    st().commit((d) => {
      const x = d.regions.find((y) => y.id === r.id)!;
      for (const u of list) {
        const n = x.notes.find((y) => y.id === u.id)!;
        if (u.pitch !== undefined) n.pitch = parsePitch(u.pitch, drums);
        if (u.start !== undefined) n.start = Math.max(0, Number(u.start));
        if (u.duration !== undefined) n.duration = Math.max(0.0625, Number(u.duration));
        if (u.velocity !== undefined) n.velocity = clamp(Number(u.velocity), 0.05, 1);
      }
    });
    return { region_id: r.id, updated: list.length };
  },

  transpose_region: ({ region_id, semitones }) => {
    const r = requireRegion(st().project, region_id);
    const s = Math.round(Number(semitones));
    st().commit((d) => {
      d.regions.find((y) => y.id === r.id)!.notes.forEach((n) => (n.pitch = clamp(n.pitch + s, 0, 127)));
    });
    return { region_id: r.id, semitones: s };
  },

  quantize_region: ({ region_id, grid }) => {
    const r = requireRegion(st().project, region_id);
    const g = Number(grid ?? 0.25);
    st().commit((d) => {
      d.regions.find((y) => y.id === r.id)!.notes.forEach((n) => {
        n.start = Math.round(n.start / g) * g;
        n.duration = Math.max(g, Math.round(n.duration / g) * g);
      });
    });
    return { region_id: r.id, grid: g };
  },

  add_drum_pattern: ({ track_id, start_bar, bars, steps_per_bar, pattern, name }) => {
    const t = requireTrack(st().project, track_id);
    if (t.kind !== 'drums') throw new Error('add_drum_pattern requires a drums track');
    const nBars = clamp(Math.round(Number(bars ?? 1)), 1, 64);
    const spb = clamp(Math.round(Number(steps_per_bar ?? 16)), 1, 64);
    const stepBeats = BEATS_PER_BAR / spb;
    const notes: Note[] = [];
    for (const [piece, rawSteps] of Object.entries(pattern ?? {})) {
      const pitch = parsePitch(piece, true);
      const steps = String(rawSteps).replace(/[\s|]/g, '');
      if (!steps.length) continue;
      for (let i = 0; i < nBars * spb; i++) {
        const ch = steps[i % steps.length];
        const vel = ch === 'X' ? 1 : ch === 'x' ? 0.8 : ch === 'o' ? 0.45 : 0;
        if (vel) notes.push({ id: uid('n'), pitch, start: i * stepBeats, duration: stepBeats, velocity: vel });
      }
    }
    const region = createRegion(t.id, barToBeat(start_bar ?? 1), nBars * BEATS_PER_BAR, name ?? tr('name.beat'), notes);
    return { region_id: region.id, note_count: notes.length };
  },

  add_chord_progression: ({ track_id, start_bar, chords, beats_per_chord, octave, style, velocity, name }) => {
    const t = requireTrack(st().project, track_id);
    if (t.kind !== 'instrument') throw new Error('add_chord_progression requires an instrument track');
    const bpc = Math.max(0.5, Number(beats_per_chord ?? 4));
    const oct = clamp(Math.round(Number(octave ?? 3)), 1, 6);
    const vel = clamp(Number(velocity ?? 0.75), 0.05, 1);
    const notes: Note[] = [];
    (chords as string[]).forEach((sym, i) => {
      const at = i * bpc;
      if (sym === '-' || sym === '') return;
      const pitches = parseChord(sym, oct);
      if (style === 'arpeggio') {
        const seq = [...pitches, pitches[0] + 12];
        for (let s = 0; s * 0.5 < bpc; s++) {
          notes.push({ id: uid('n'), pitch: seq[s % seq.length], start: at + s * 0.5, duration: 0.5, velocity: vel });
        }
      } else if (style === 'stabs') {
        for (let b = 0; b < bpc; b++) {
          for (const pitch of pitches) notes.push({ id: uid('n'), pitch, start: at + b + 0.5, duration: 0.35, velocity: vel });
        }
      } else {
        for (const pitch of pitches) notes.push({ id: uid('n'), pitch, start: at, duration: bpc, velocity: vel });
      }
    });
    const len = Math.ceil((chords.length * bpc) / BEATS_PER_BAR) * BEATS_PER_BAR;
    const region = createRegion(t.id, barToBeat(start_bar ?? 1), len, name ?? tr('name.chords'), notes);
    return { region_id: region.id, note_count: notes.length, length_bars: len / BEATS_PER_BAR };
  },

  transport: async ({ action, from_bar }) => {
    if (from_bar !== undefined) engine.position = barToBeat(from_bar);
    if (action === 'play' || (action === 'toggle' && !engine.playing)) {
      if (!engine.contextRunning) {
        try {
          await engine.unlock();
        } catch {
          /* blocked */
        }
      }
      await engine.play();
      st().set({ isPlaying: true });
    } else if (action === 'stop' || action === 'toggle') {
      engine.stop();
      st().set({ isPlaying: false });
    } else if (action === 'rewind') {
      engine.position = 0;
    }
    const warn = engine.contextRunning
      ? undefined
      : 'Browser audio is locked: ask the user to click once inside the OpenBand window to enable sound.';
    return { ...(commands.get_status({}) as object), ...(warn ? { warning: warn } : {}) };
  },

  set_loop: ({ enabled, start_bar, end_bar }) => {
    st().commit((d) => {
      if (start_bar !== undefined) d.loop.start = barToBeat(start_bar);
      if (end_bar !== undefined) d.loop.end = barToBeat(end_bar);
      if (d.loop.end <= d.loop.start) d.loop.end = d.loop.start + BEATS_PER_BAR;
      d.loop.enabled = enabled ?? true;
    });
    const l = st().project.loop;
    return { enabled: l.enabled, start_bar: beatToBar(l.start), end_bar: beatToBar(l.end) };
  },

  set_metronome: ({ enabled }) => {
    st().commit((d) => void (d.metronome = !!enabled), { history: false });
    return { metronome: !!enabled };
  },

  open_editor: ({ region_id }) => {
    const r = requireRegion(st().project, region_id);
    st().selectRegion(r);
    st().set({ bottom: 'editor' });
    return { region_id: r.id };
  },

  undo: ({ steps }) => {
    const before = st().past.length;
    st().undo(clamp(Math.round(Number(steps ?? 1)), 1, 100));
    return { undone: before - st().past.length, next_undo: st().past[st().past.length - 1]?.label ?? null };
  },
  redo: ({ steps }) => {
    const before = st().future.length;
    st().redo(clamp(Math.round(Number(steps ?? 1)), 1, 100));
    return { redone: before - st().future.length, next_redo: st().future[0]?.label ?? null };
  },

  // ---------- transactions (one undo step per intent) ----------

  begin_change: ({ label }) => {
    const open = st().activeTransaction;
    if (open) st().endTransaction(open.id);
    const id = st().beginTransaction(String(label || tr('hist.aiChange')), 'ai');
    armTransactionTimer();
    return { tx_id: id, label: st().activeTransaction!.label };
  },

  end_change: () => {
    clearTimeout(txTimer);
    const tx = st().activeTransaction;
    if (!tx) return { closed: false };
    const e = st().endTransaction(tx.id);
    return { closed: true, label: tx.label, commands: tx.commands, changed: !!e };
  },

  get_history: ({ limit }) => {
    const n = clamp(Math.round(Number(limit ?? 20)), 1, 200);
    const fmt = (e: { label: string; source: string; commands: number; at: number }) => ({ label: e.label, source: e.source, commands: e.commands, at: e.at });
    const tx = st().activeTransaction;
    return {
      past: st().past.slice(-n).reverse().map(fmt),
      future: st().future.slice(0, n).map(fmt),
      open: tx ? { label: tx.label, source: tx.source, commands: tx.commands } : null,
    };
  },

  export_project_json: () => st().project,

  // ---------- imported sounds ----------

  list_samples: () => ({
    samples: Object.values(useSamples.getState().info).map((s) => ({ id: s.id, name: s.name, duration_seconds: +s.duration.toFixed(3), channels: s.channels })),
  }),

  import_sample: async ({ data_base64, filename }) => {
    const info = await importSample(fromBase64(data_base64), String(filename ?? 'sample.wav'));
    const root = rootFor(info);
    return { sample_id: info.id, name: info.name, duration_seconds: +info.duration.toFixed(3), detected_root: root, detected_root_name: noteName(root) };
  },

  create_sampler_instrument: ({ name, kind, samples, pads, attack, release }) => {
    const k = kind === 'drums' ? 'drums' : 'instrument';
    let zones;
    if (k === 'drums') {
      if (pads && Object.keys(pads).length) {
        zones = Object.entries(pads as Record<string, string>).map(([piece, id]) => {
          requireSample(id);
          const pitch = SAMPLE_DRUMS[piece.toLowerCase()] ?? parsePitch(piece, true);
          return { sampleId: id, root: pitch, lo: pitch, hi: pitch };
        });
      } else {
        zones = guessDrumPads(((samples ?? []) as { sample_id: string }[]).map((s) => requireSample(s.sample_id)));
      }
    } else {
      const list = (samples ?? []) as { sample_id: string; root?: number | string; lo?: number; hi?: number }[];
      if (!list.length) throw new Error('Give at least one sample');
      const explicit = list.some((s) => s.lo !== undefined || s.hi !== undefined);
      const withRoots = list.map((s) => ({ s, sampleId: s.sample_id, root: s.root !== undefined ? parsePitch(s.root, false) : rootFor(requireSample(s.sample_id)) }));
      zones = explicit
        ? withRoots.map(({ s, sampleId, root }) => ({ sampleId, root, lo: clamp(s.lo ?? 0, 0, 127), hi: clamp(s.hi ?? 127, 0, 127) }))
        : spreadZones(withRoots);
    }
    if (!zones.length) throw new Error('No zones: pass samples or pads');
    const inst = {
      id: uid('usr'),
      name: String(name ?? (k === 'drums' ? 'Custom Kit' : 'Sampler')),
      kind: k as 'instrument' | 'drums',
      source: 'sampler' as const,
      zones,
      attack: clamp(Number(attack ?? 0.003), 0.001, 5),
      release: clamp(Number(release ?? (k === 'drums' ? 0.08 : 0.35)), 0.01, 10),
    };
    st().commit((d) => void (d.instruments = [...(d.instruments ?? []), inst]));
    return { instrument_id: inst.id, name: inst.name, kind: inst.kind, zones: zones.map((z) => ({ sample_id: z.sampleId, root: noteName(z.root), lo: z.lo, hi: z.hi })) };
  },

  import_soundfont: async ({ data_base64, preset }) => {
    const sf = openSoundFont(fromBase64(data_base64));
    const list = sf.presets.map((p) => ({ index: p.index, name: p.name, bank: p.bank, program: p.program, drums: sf.isDrumPreset(p) }));
    if (preset === undefined || preset === null || preset === '') return { presets: list, note: 'Call again with preset (index, name or "bank:program") to import one.' };
    const q = String(preset).trim().toLowerCase();
    const bp = q.match(/^(\d+):(\d+)$/);
    const found =
      (bp ? list.find((p) => p.bank === Number(bp[1]) && p.program === Number(bp[2])) : undefined) ??
      (/^\d+$/.test(q) ? list.find((p) => p.index === Number(q)) : undefined) ??
      list.find((p) => p.name.toLowerCase() === q) ??
      list.find((p) => p.name.toLowerCase().includes(q));
    if (!found) throw new Error(`Preset "${preset}" not found. Call without preset to list them.`);
    const inst = await instrumentFromSoundFont(sf, found.index);
    return { instrument_id: inst.id, name: inst.name, kind: inst.kind, zones: inst.zones.length, note: 'Use it with add_track or update_track (instrument).' };
  },

  add_audio_region: ({ sample_id, track_id, start_bar, name, offset_seconds, length_bars, gain }) => {
    const info = requireSample(sample_id);
    const trackId = track_id ? requireTrack(st().project, track_id).id : undefined;
    const r = addAudioRegion(info, {
      trackId,
      startBeat: barToBeat(start_bar ?? 1),
      name,
      offset: offset_seconds !== undefined ? Number(offset_seconds) : undefined,
      lengthBeats: length_bars !== undefined ? Number(length_bars) * BEATS_PER_BAR : undefined,
      gain: gain !== undefined ? clamp(Number(gain), 0, 2) : undefined,
    });
    return { region_id: r.id, track_id: r.trackId, start_bar: beatToBar(r.start), length_bars: +(r.length / BEATS_PER_BAR).toFixed(3) };
  },

  import_project_json: ({ project }) => {
    const p = migrate(project);
    st().loadProject(p);
    return summarize(p);
  },

  export_wav: async ({ return_data }) => {
    await captureWamStates();
    const p = st().project;
    const blob = await renderProject(p);
    if (return_data) return { bytes: blob.size, filename: `${safeName(p.name)}.wav`, data_base64: toBase64(new Uint8Array(await blob.arrayBuffer())) };
    download(blob, `${safeName(p.name)}.wav`);
    return { exported: true, bytes: blob.size, note: 'The WAV was downloaded by the browser.' };
  },

  // ---------- song structure ----------

  get_structure: () => {
    const p = st().project;
    // Loudness per section when a full analysis (per-bar loudness) is cached.
    const perBar = (useAnalysis.getState().result?.per_bar ?? []) as { bar: number; lufs: number }[];
    const lufsOf = (s: Section) => {
      const bars = perBar.filter((b) => b.bar >= s.start / 4 + 1 && b.bar < (s.start + s.length) / 4 + 1 && b.lufs > -900);
      return bars.length ? +(10 * Math.log10(bars.reduce((a, b) => a + Math.pow(10, b.lufs / 10), 0) / bars.length)).toFixed(1) : undefined;
    };
    return {
      length_bars: Math.ceil(projectEnd(p) / BEATS_PER_BAR),
      sections: sortSections(structuredClone(p)).map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        start_bar: beatToBar(s.start),
        length_bars: s.length / BEATS_PER_BAR,
        energy: { ...energyProfile(p, s.start, s.start + s.length), ...(lufsOf(s) !== undefined ? { lufs: lufsOf(s) } : {}) },
      })),
    };
  },

  add_section: ({ name, kind, start_bar, length_bars }) => {
    const k = (kind ?? 'custom') as SectionKind;
    const s: Section = { id: uid('sec'), name: String(name ?? k), kind: k, start: barToBeat(start_bar ?? 1), length: Math.max(1, Number(length_bars ?? 4)) * BEATS_PER_BAR, color: SECTION_COLORS[k] };
    assertNoOverlap(st().project, s);
    st().commit((d) => {
      (d.sections ??= []).push(s);
      sortSections(d);
    });
    return { section_id: s.id, start_bar: beatToBar(s.start), length_bars: s.length / BEATS_PER_BAR };
  },

  update_section: ({ section_id, name, kind, start_bar, length_bars }) => {
    const cur = st().project.sections?.find((s) => s.id === section_id);
    if (!cur) throw new Error(`Section "${section_id}" not found. Call get_structure.`);
    const next: Section = {
      ...cur,
      ...(name !== undefined ? { name: String(name) } : {}),
      ...(kind !== undefined ? { kind, color: SECTION_COLORS[kind as SectionKind] } : {}),
      ...(start_bar !== undefined ? { start: barToBeat(start_bar) } : {}),
      ...(length_bars !== undefined ? { length: Math.max(1, Number(length_bars)) * BEATS_PER_BAR } : {}),
    };
    assertNoOverlap(st().project, next, cur.id);
    st().commit((d) => {
      d.sections = d.sections!.map((s) => (s.id === cur.id ? next : s));
      sortSections(d);
    });
    return { section_id: cur.id };
  },

  delete_section: ({ section_id, delete_content }) => {
    st().commit((d) => deleteSection(d, String(section_id), !!delete_content));
    return { deleted: section_id, content_deleted: !!delete_content };
  },

  move_section: ({ section_id, to_bar, ripple }) => {
    st().commit((d) => moveSection(d, String(section_id), barToBeat(Number(to_bar)), ripple !== false));
    const s = st().project.sections!.find((x) => x.id === section_id)!;
    return { section_id, start_bar: beatToBar(s.start) };
  },

  duplicate_section: ({ section_id, to_bar, ripple }) => {
    let id = '';
    st().commit((d) => void (id = duplicateSection(d, String(section_id), to_bar !== undefined ? barToBeat(Number(to_bar)) : undefined, ripple !== false)));
    const s = st().project.sections!.find((x) => x.id === id)!;
    return { section_id: id, start_bar: beatToBar(s.start), length_bars: s.length / BEATS_PER_BAR };
  },

  split_region: ({ region_id, at_bar, at_beat }) => {
    const r = requireRegion(st().project, region_id);
    const beat = at_beat !== undefined ? Number(at_beat) : barToBeat(Number(at_bar));
    let id: string | null = null;
    st().commit((d) => void (id = splitRegionAt(d, r.id, beat)));
    if (!id) throw new Error(`Bar/beat ${at_bar ?? at_beat} is not inside region ${r.id}`);
    return { left_region_id: r.id, right_region_id: id };
  },

  auto_sections: () => ({
    proposal: proposeSections(st().project).map((s) => ({ name: s.name, kind: s.kind, start_bar: beatToBar(s.start), length_bars: s.length / BEATS_PER_BAR })),
    note: 'Nothing was changed. Call add_section for the ones you want.',
  }),

  // ---------- lyrics ----------

  set_lyrics: ({ section_id, line_ids, text, language }) => {
    const p = st().project;
    const lang = (language ?? p.lyrics?.language ?? (useLangOf() === 'it' ? 'it' : 'en')) as 'it' | 'en';
    if (section_id && !p.sections?.some((s) => s.id === section_id)) throw new Error(`Section "${section_id}" not found. Call get_structure.`);
    const fresh = buildLines(String(text ?? ''), lang, () => uid('ly'), section_id);
    st().commit((d) => {
      const doc = (d.lyrics ??= { language: lang, lines: [] });
      doc.language = lang;
      if (line_ids?.length) {
        // Replace the given lines one by one, keeping their place and section.
        (line_ids as string[]).forEach((lid, i) => {
          const at = doc.lines.findIndex((l) => l.id === lid);
          if (at < 0) throw new Error(`Line "${lid}" not found. Call get_lyrics.`);
          if (fresh[i]) doc.lines[at] = { ...fresh[i], id: lid, ...(doc.lines[at].sectionId ? { sectionId: doc.lines[at].sectionId } : {}) };
        });
      } else if (section_id) {
        const first = doc.lines.findIndex((l) => l.sectionId === section_id);
        const rest = doc.lines.filter((l) => l.sectionId !== section_id);
        rest.splice(first >= 0 ? first : rest.length, 0, ...fresh);
        doc.lines = rest;
      } else doc.lines = fresh;
      // Keep lines in song order (by section start).
      const order = new Map((d.sections ?? []).map((s) => [s.id, s.start]));
      doc.lines = doc.lines.map((l, i) => ({ l, i })).sort((a, b) => (order.get(a.l.sectionId ?? '') ?? 1e9) - (order.get(b.l.sectionId ?? '') ?? 1e9) || a.i - b.i).map((x) => x.l);
      if (doc.melodyTrackId) {
        try {
          const res = alignProject(d, section_id);
          doc.lines = doc.lines.map((l) => res.updated.get(l.id) ?? l);
        } catch {
          // melody track gone: leave lines unaligned
        }
      }
    });
    return commands.get_lyrics({ section_id });
  },

  get_lyrics: ({ section_id }) => {
    const p = st().project;
    const doc = p.lyrics;
    if (!doc) return { language: null, melody_track_id: null, lines: [] };
    const lines = doc.lines.filter((l) => !section_id || l.sectionId === section_id);
    return {
      language: doc.language,
      melody_track_id: doc.melodyTrackId ?? null,
      lines: lines.map((l) => ({
        id: l.id,
        section_id: l.sectionId ?? null,
        text: l.text,
        syllable_count: l.syllables.length,
        syllables: l.syllables.map((s) => ({ text: s.text, stressed: s.stressed, ...(s.beat !== undefined ? { bar: +beatToBar(s.beat).toFixed(3) } : {}), ...(s.noteId ? { note_id: s.noteId } : {}), ...(s.melisma ? { melisma: true } : {}) })),
        aligned: l.syllables.every((s) => s.noteId),
      })),
    };
  },

  align_lyrics: ({ melody_track_id, section_id }) => {
    const t = requireTrack(st().project, melody_track_id);
    if (t.kind !== 'instrument') throw new Error('The melody must be on an instrument track');
    let report = { orphanSyllables: [] as { line_id: string; count: number }[], orphanNotes: [] as string[] };
    st().commit((d) => {
      const doc = (d.lyrics ??= { language: 'it', lines: [] });
      doc.melodyTrackId = t.id;
      const res = alignProject(d, section_id);
      doc.lines = doc.lines.map((l) => res.updated.get(l.id) ?? l);
      report = res;
    });
    return { melody_track_id: t.id, orphan_syllables: report.orphanSyllables, orphan_notes: report.orphanNotes.length, issues: prosodyIssues(st().project, section_id).length };
  },

  check_prosody: ({ section_id }) => ({ issues: prosodyIssues(st().project, section_id).map((i) => ({ ...i, ...(i.from_beat !== undefined ? { bar: +beatToBar(i.from_beat).toFixed(2) } : {}) })) }),

  suggest_melody_rhythm: ({ line_id }) => {
    const line = st().project.lyrics?.lines.find((l: LyricLine) => l.id === line_id);
    if (!line) throw new Error(`Line "${line_id}" not found. Call get_lyrics.`);
    return { line_id, text: line.text, rhythm: suggestRhythm(line.syllables), note: 'start/duration in beats from the start of the phrase; stressed syllables fall on beats.' };
  },

  export_chord_sheet: ({ format, return_data }) => {
    const p = st().project;
    const melodic = new Set(p.tracks.filter((t) => t.kind === 'instrument' && !t.mute).map((t) => t.id));
    const notes = p.regions.filter((r) => melodic.has(r.trackId) && !r.audio && r.trackId !== p.lyrics?.melodyTrackId).flatMap((r) => r.notes.filter((n) => n.start < r.length).map((n) => ({ pitch: n.pitch, start: r.start + n.start, duration: Math.min(n.duration, r.length - n.start), velocity: n.velocity })));
    const end = projectEnd(p);
    const chords = analyzeChords(notes, p.key, 0, end).map((c) => ({ start: c.start, chord: c.chord }));
    const sheet = { title: p.name, key: p.key, bpm: p.bpm, sections: p.sections ?? [], chords, lines: p.lyrics?.lines ?? [], length: end };
    const fmt = format === 'txt' ? 'txt' : 'chordpro';
    const textOut = fmt === 'txt' ? toChordText(sheet) : toChordPro(sheet);
    const filename = `${p.name.replace(/[^\w\- ]+/g, '').trim() || 'openband'}.${fmt === 'txt' ? 'txt' : 'cho'}`;
    if (return_data) return { filename, format: fmt, text: textOut, data_base64: toBase64(new TextEncoder().encode(textOut)), bytes: textOut.length };
    download(new Blob([textOut], { type: 'text/plain' }), filename);
    return { exported: true, filename, format: fmt, text: textOut };
  },

  // ---------- linter ----------

  lint_project: async ({ rules, include_audio, min_severity }) => {
    const p = st().project;
    const res = lint(p, { rules, minSeverity: min_severity });
    if (include_audio) {
      // Audio rules reuse analyze_mix (rendering the song).
      const AUDIO: Record<string, string> = { clipping: 'clipping', true_peak_high: 'low_headroom', low_headroom: 'low_headroom', masking_low_end: 'masking_low_end', phase_mono: 'phase_mono' };
      const report = (await analyzeMix({ per_track: true })) as unknown as { issues: { code: string; severity: Severity; message: string; suggestion: string; tracks?: string[]; params?: Record<string, string | number> }[] };
      for (const i of report.issues) {
        const rule = AUDIO[i.code];
        if (!rule || (rules && !rules.includes(rule)) || p.lint?.disabled?.includes(rule)) continue;
        const target = i.tracks?.length ? { track_id: i.tracks[0] } : {};
        const issue: LintIssue = { id: `${rule}:${lintHash(JSON.stringify([i.code, target]))}`, rule, severity: p.lint?.severity?.[rule] ?? i.severity, category: 'mix', message: `${i.message}. ${i.suggestion}`, target, params: i.params };
        if (!p.lint?.ignored?.includes(issue.id)) res.issues.push(issue);
      }
      res.counts = { error: 0, warn: 0, info: 0 };
      for (const i of res.issues) res.counts[i.severity]++;
    }
    return res;
  },

  apply_fix: async ({ issue_id }) => {
    const issue = lint(st().project).issues.find((i) => i.id === issue_id);
    if (!issue) throw new Error(`Issue "${issue_id}" not found (already fixed?). Call lint_project.`);
    if (!issue.fix) throw new Error(`Issue "${issue_id}" (${issue.rule}) has no automatic fix`);
    const open = st().activeTransaction;
    if (open?.auto) st().endTransaction(open.id);
    const tx = st().beginTransaction(issue.fix.label, open && !open.auto ? open.source : 'ai');
    try {
      for (const c of issue.fix.commands) await commands[c.method](c.params);
    } finally {
      st().endTransaction(tx);
    }
    return { applied: true, issue_id, label: issue.fix.label, commands: issue.fix.commands.length };
  },

  ignore_issue: ({ issue_id }) => {
    st().commit((d) => {
      d.lint ??= {};
      d.lint.ignored = [...new Set([...(d.lint.ignored ?? []), String(issue_id)])];
    });
    return { ignored: issue_id };
  },

  // ---------- listening (analysis) ----------

  analyze_mix: ({ from_bar, to_bar, section_id, per_track, detail }) => analyzeMix({ from_bar, to_bar, section_id, per_track, detail }),

  detect_key: ({ source }) => detectKey(source),

  analyze_harmony: ({ from_bar, to_bar, section_id, track_ids }) => analyzeHarmony({ from_bar, to_bar, section_id, track_ids }),

  render_spectrogram: ({ from_bar, to_bar, section_id, track_id, width, height }) => spectrogram({ from_bar, to_bar, section_id, track_id, width, height }),

  // ---------- recording ----------

  record_audio: async ({ track_id, start_bar, bars, mode }) => {
    const m = mode === 'hum' ? 'hum' : 'audio';
    if (useMic.getState().state !== 'idle') throw new Error('The microphone is busy');
    if (track_id) {
      const t = getTrack(st().project, track_id);
      if (!t) throw new Error(`No track "${track_id}"`);
      if (m === 'audio' && t.kind !== 'audio') throw new Error('Audio recordings go on an audio track (omit track_id to create one)');
    }
    const startBar = Math.max(1, Math.round(start_bar ?? 1));
    const n = bars === undefined ? undefined : clamp(Math.round(bars), 1, 64);
    // The user always confirms: an AI must not switch the microphone on by itself.
    const ok = await requestRecording(m, startBar, n);
    if (!ok) return { recorded: false, reason: 'The user declined' };
    const r = await recordFromMic({ mode: m, trackId: track_id, startBeat: (startBar - 1) * BEATS_PER_BAR, bars: n });
    return { recorded: true, ...r };
  },

  audio_to_midi: async ({ region_id, sample_id, track_id, instrument, snap_to_key, quantize, strength, start_bar }) => {
    const opts = { trackId: track_id, instrument, snapToKey: snap_to_key !== false, quantize: quantize ?? 0.25, strength: strength ?? 0.6 };
    if (region_id) return audioRegionToMidi(String(region_id), opts);
    if (!sample_id) throw new Error('Pass region_id (an audio region) or sample_id');
    if (!getBuffer(String(sample_id))) throw new Error(`Sample "${sample_id}" is not loaded`);
    return audioToMidi(String(sample_id), (Math.max(1, start_bar ?? 1) - 1) * BEATS_PER_BAR, 0, undefined, opts);
  },

  // ---------- WAM plugins ----------

  list_plugins: async ({ kind }) => ({
    plugins: (await wamCatalog())
      .filter((p) => !kind || p.kind === kind)
      .map((p) => ({ id: p.identifier, name: p.name, vendor: p.vendor, kind: p.kind, description: p.description.slice(0, 160) })),
  }),

  search_plugins: async ({ description, kind }) => ({
    matches: (await searchPlugins(String(description), kind)).map((p) => ({ id: p.identifier, name: p.name, kind: p.kind, score: p.score, description: p.description.slice(0, 160) })),
  }),

  add_plugin: async ({ description, plugin, track_id, kind }) => {
    let ref = plugin as string | undefined;
    let alternatives: { id: string; name: string; kind: string }[] = [];
    if (!ref) {
      const found = await searchPlugins(String(description ?? ''), kind);
      if (!found.length) throw new Error(`No plugin matches "${description}". Call list_plugins to see them all.`);
      ref = found[0].identifier;
      alternatives = found.slice(1, 4).map((p) => ({ id: p.identifier, name: p.name, kind: p.kind }));
    }
    const target = track_id ? requireTrack(st().project, track_id) : getTrack(st().project, st().selectedTrackId);
    const entry = (await wamCatalog()).find((p) => p.identifier === ref || p.url === ref);
    const isInstrument = entry ? entry.kind === 'instrument' : kind === 'instrument';
    const added = isInstrument
      ? await addPluginInstrument(ref, target?.kind === 'instrument' && track_id ? target.id : undefined)
      : await (async () => {
          if (!target) throw new Error('Effects need a track: pass track_id');
          return addPluginEffect(target.id, ref!);
        })();
    return { added_as: isInstrument ? 'instrument' : 'effect', ...added, ...(alternatives.length ? { alternatives } : {}) };
  },

  add_plugin_instrument: ({ plugin, track_id }) => addPluginInstrument(String(plugin), track_id ? requireTrack(st().project, track_id).id : undefined),

  add_plugin_effect: ({ track_id, plugin }) => addPluginEffect(requireTrack(st().project, track_id).id, String(plugin)),

  remove_plugin_effect: ({ track_id, slot_id }) => {
    removePluginEffect(requireTrack(st().project, track_id).id, String(slot_id));
    return { removed: slot_id };
  },

  set_plugin_bypass: ({ track_id, slot_id, on }) => {
    updateSlot(requireTrack(st().project, track_id).id, String(slot_id), (s) => void (s.on = !!on));
    return { slot_id, on: !!on };
  },

  get_plugin_params: async ({ track_id, slot_id }) => ({ params: await getPluginParams(requireTrack(st().project, track_id).id, slot_id) }),

  set_plugin_params: async ({ track_id, slot_id, values }) => ({ updated: await setPluginParams(requireTrack(st().project, track_id).id, slot_id, values ?? {}) }),

  show_plugin: ({ track_id, slot_id }) => {
    const t = requireTrack(st().project, track_id);
    st().set({ pluginWindow: { trackId: t.id, slotId: slot_id ?? null } });
    return { shown: true };
  },

  export_midi: ({ return_data }) => {
    const p = st().project;
    const bytes = writeMidi(p);
    if (return_data) return { bytes: bytes.length, filename: `${safeName(p.name)}.mid`, data_base64: toBase64(bytes) };
    download(new Blob([bytes], { type: 'audio/midi' }), `${safeName(p.name)}.mid`);
    return { exported: true, bytes: bytes.length, note: 'The MIDI file was downloaded by the browser.' };
  },

  import_midi: ({ data_base64, filename, replace }) => importMidiSong(readMidi(fromBase64(data_base64)), String(filename ?? 'song.mid'), !!replace),

  /** UI only: a File dropped or picked by the user. */
  import_midi_file: async ({ file }) => {
    const f = file as File;
    const result = importMidiSong(readMidi(await f.arrayBuffer()), f.name, false);
    st().notify(tr('midi.imported', { n: result.tracks.length }));
    return result;
  },
};

/** Run a command and record it in the AI activity log. */
/** Commands that never change the project: they don't open an undo step. */
const READ_ONLY = new Set([
  'get_project', 'get_status', 'list_instruments', 'get_region_notes', 'export_project_json', 'export_wav', 'export_midi',
  'list_samples', 'list_plugins', 'search_plugins', 'get_plugin_params', 'show_plugin', 'open_editor', 'get_history',
  'analyze_mix', 'detect_key', 'render_spectrogram', 'lint_project', 'get_structure', 'auto_sections', 'analyze_harmony',
  'get_lyrics', 'check_prosody', 'suggest_melody_rhythm', 'export_chord_sheet',
]);
/** Commands that manage history themselves. */
const CONTROL = new Set(['begin_change', 'end_change', 'undo', 'redo']);

/** AI commands without begin_change are grouped until the AI has been quiet for this long. */
export const transactionConfig = { autoCloseMs: 4000, explicitIdleMs: 60000 };
let txTimer: ReturnType<typeof setTimeout> | undefined;

function armTransactionTimer() {
  clearTimeout(txTimer);
  const tx = st().activeTransaction;
  if (!tx || tx.source !== 'ai') return;
  // Explicit changes stay open until end_change; the long timeout only protects against a forgotten one.
  txTimer = setTimeout(() => {
    const open = st().activeTransaction;
    if (open?.id === tx.id) st().endTransaction(open.id);
  }, tx.auto ? transactionConfig.autoCloseMs : transactionConfig.explicitIdleMs);
}

/** Run a command and record it in the AI activity log. AI commands are grouped into undo steps. */
export async function runCommand(method: string, params: P, source: 'ai' | 'ui' = 'ai') {
  const fn = commands[method];
  if (!fn) throw new Error(`Unknown command ${method}`);
  const ai = source === 'ai';
  let txId: string | undefined;
  if (ai && !CONTROL.has(method) && !READ_ONLY.has(method)) {
    if (!st().activeTransaction) st().beginTransaction(shortSummary(method, params ?? {}), 'ai', { auto: true });
    st().countCommand();
    txId = st().activeTransaction?.id;
  }
  if (ai && method === 'end_change') txId = st().activeTransaction?.id;
  if (ai) enterAiCommand();
  try {
    const result = await fn(params ?? {});
    if (ai && method === 'begin_change') txId = st().activeTransaction?.id;
    if (ai) st().logBridge({ method, ok: true, summary: shortSummary(method, params ?? {}), txId });
    return result;
  } catch (e) {
    if (ai) st().logBridge({ method, ok: false, summary: (e as Error).message, txId });
    throw e;
  } finally {
    if (ai) {
      exitAiCommand();
      if (txId && method !== 'end_change') armTransactionTimer();
    }
  }
}

function shortSummary(method: string, p: P): string {
  switch (method) {
    case 'set_tempo':
      return `Tempo → ${p.bpm} BPM`;
    case 'add_track':
      return tr('ai.sum.track', { name: p.name ?? p.instrument ?? p.kind ?? '' });
    case 'add_region':
      return tr('ai.sum.region', { bar: p.start_bar ?? 1, n: p.notes?.length ?? 0 });
    case 'add_notes':
      return tr('ai.sum.notes', { n: p.notes?.length ?? 0 });
    case 'add_drum_pattern':
      return tr('ai.sum.drums', { pieces: Object.keys(p.pattern ?? {}).join(', ') });
    case 'add_chord_progression':
      return tr('ai.sum.chords', { chords: (p.chords ?? []).join(' – ') });
    case 'transport':
      return tr('ai.sum.transport', { action: p.action });
    case 'update_track':
      return tr('ai.sum.updateTrack', { fields: Object.keys(p).filter((k) => k !== 'track_id').join(', ') });
    default:
      return method.replace(/_/g, ' ');
  }
}
