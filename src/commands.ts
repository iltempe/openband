// High-level command API. This is what the MCP bridge calls, and the UI reuses parts of it.
// Bars are 1-based (bar 1 starts at beat 0); positions inside regions are in beats.
import type { Note, Project, Region, Track, TrackKind } from './types';
import { markFirstExport } from './firstRun';
import { BEATS_PER_BAR, KEYS, clamp, keyInterval, normalizeKey, drumByPitch, noteName, parseChord, parsePitch, uid } from './music';
import { PRESETS, customInstruments, findInstrument } from './audio/instruments';
import { getBuffer, importSample, useSamples } from './audio/samples';
import { normalizeFx } from './audio/fx';
import { AUTO_PARAMS, FX_PARAMS, hasAutomation, isAutomated, lanesOf, mix, parseTargetKey, pointsOf, setPoints, targetKey, targetRange } from './automation';
import type { Annotation, AutoTarget } from './types';
import type { AutoParam } from './types';
import { presetForProgram, readMidi, writeMidi, type MidiSong } from './midi';
import { addNativeEffect, addNativeInstrument, addPluginEffect, addPluginInstrument, captureWamStates, findNativePlugin, getPluginParams, nativePlugins, nativeRef, rankNativePlugins, removePluginEffect, searchAllPlugins, setPluginParams, updateSlot } from './plugins';
import { suggest } from './suggest/engine';
import { addTransition, arrangeFromEnergy, getEnergy, setEnergyCurve } from './arranger/apply';
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
import { emptyProject, enterAiCommand, exitAiCommand, isAiCommand, getRegion, getTrack, makeTrack, projectEnd, useStore } from './store';
import { engine } from './audio/engine';
import { checkSegments, compNotes, nextTakeName, withTakes, type CompSegment } from './takes';
import { startABTest } from './abtest';
import { readMeter, resetMeters } from './audio/meters';
import { targetStatus } from './analysis/liveLoudness';
import { currentTarget, setMonitoring, useMonitoring } from './monitoring';
import { levelMatch } from './levelMatch';
import { projectAt, restoreAt, timeline } from './journal';
import { exportDawproject, importDawproject } from './interop/dawproject';
import { addLoop, findLoops } from './loopsLive';
import { detectTempo, stretchFactor } from './audio/stretch';
import { DRUM_STYLES, generateDrums, spansFor, type DrumStyle, type DrummerOptions } from './generate/drummer';

/** A key in KEYS' spelling, from any common way of writing it; an error the AI can act on otherwise. */
function requireKey(input: unknown): string {
  const k = normalizeKey(String(input));
  if (!k) throw new Error(`"${input}" is not a key: use a note and optionally "m" for minor, e.g. "Am", "Eb", "F#m"`);
  return k;
}

function drummerOptions(o: P): DrummerOptions {
  const style = String(o.style ?? 'pop') as DrumStyle;
  if (!DRUM_STYLES.includes(style)) throw new Error(`Unknown style "${o.style}". Styles: ${DRUM_STYLES.join(', ')}`);
  const fills = (o.fills ?? 'end_of_section') as DrummerOptions['fills'];
  if (!['none', 'end_of_section', 'every_4'].includes(fills)) throw new Error('fills: none, end_of_section or every_4');
  const num = (v: unknown, d: number) => (v === undefined || v === null ? d : clamp(Number(v), 0, 1));
  return { style, complexity: num(o.complexity, 0.5), loudness: num(o.loudness, 0.7), swing: num(o.swing, style === 'shuffle' || style === 'boom-bap' || style === 'lo-fi' ? 0.5 : 0), fills, seed: Number.isFinite(Number(o.seed)) && o.seed !== undefined ? Math.floor(Number(o.seed)) : Math.floor(Math.random() * 1e6) };
}

/** The drummer's notes for [from, to) as region notes (beats from `from`). */
function drummerNotes(sections: Section[], from: number, to: number, o: DrummerOptions): Note[] {
  return generateDrums(spansFor(sections, from, to), o)
    .filter((n) => n.start >= from - 0.05 && n.start < to)
    .map((n) => ({ ...n, id: uid('n'), start: +Math.max(0, n.start - from).toFixed(4) }));
}

import { autoVersion } from './versioning';
import { createPart, scopeFor, type CreateArgs } from './ensemble/create';
import { transformPart, type TransformArgs } from './ensemble/transform';
import { separateRegion, type SeparateArgs } from './ensemble/separate';
import { singPart, type SingArgs } from './sing/sing';
import { applyPatch, describeSynth, keepPatch, setSynthParams } from './soundmatch/patches';
import { soundFromWords } from './soundmatch/words';
import { checkReleaseCommand, generateCover, getRelease, releaseKit, setRelease, type SetReleaseArgs } from './publish/commands';
import { preferencesFor, tasteByCapability } from './ensemble/taste';
import { buildContext } from './ensemble/context';
import { allEngines, setPolicy, useEnsemble } from './ensemble/engines';
import { route } from './ensemble/router';
import type { Capability } from './ensemble/types';
import { attributions, nonCommercial, shares } from './ensemble/ledger';

/** ISO date, ms since epoch, or a relative "-20m" / "-2h" / "-90s". */
function toTime(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  const rel = s.match(/^-(\d+(?:\.\d+)?)\s*(s|m|min|h|d)$/i);
  if (rel) return Date.now() - Number(rel[1]) * ({ s: 1e3, m: 6e4, min: 6e4, h: 3.6e6, d: 8.64e7 } as Record<string, number>)[rel[2].toLowerCase()];
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error('time: an ISO date ("2026-10-20T14:32:00"), ms since epoch, or relative like "-20m"');
  return ms;
}
import { pluginsChanged } from './pluginHistory';
import type { HistoryEntry } from './types';
import { bestTakeAt, fixWindow, takeOf } from './flubs';
import { markFlub, useFlubLive } from './flubLive';
import { createRoom, getPeers, joinRoom, leaveRoom, useCollab } from './collab/session';
import { jamStatus, keepAnswer, keepPhrase, playPhrase, setJamMode, useJam } from './jamMode';
import { canonicalJSON } from './versions/canonical';
import { checkout, createBranch, diffVersions, listVersions, mergeBranch, saveVersion } from './versioning';
import { MAX_ANNOTATION, checkTarget, matchesTarget } from './annotations';
import { useTeachMode } from './events';
import { clearReference, compareToReference, importReference } from './reference';
import { armTrack, audioRegionToMidi, audioToMidi, recordFromMic, requestRecording, setPunch, useMic, useRecSetup } from './recording';
import { download, renderProject, WAV_BITS, WAV_RATES, type WavFormat } from './audio/render';
import { PLATFORM_TARGETS, mergeMaster, type Platform } from './audio/master';
import { fitLimiter, outOfReach } from './audio/fitLimiter';
import { fixPilot, runPilot, setPilotAmount, setTrackRole } from './pilot/pilot';
import { exportForPlatforms } from './pilot/exportPlatforms';
import type { MixRole } from './types';
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
/** Who is writing: the person (by their room name), or the AI acting for them. */
function authorNow(ai: boolean): Annotation['author'] {
  const c = useCollab.getState();
  const me = c.status === 'connected' ? c.me.name : null;
  return ai ? { kind: 'ai', name: me ? `AI · ${me}` : 'AI' } : { kind: 'user', name: me ?? 'You' };
}

function requireFlub(id: string) {
  const f = st().project.flubs?.find((x) => x.id === id);
  if (!f) throw new Error(`Flub "${id}" not found. Call list_flubs.`);
  return f;
}
/** set_automation's target: a mix param name ("volume"…), a target object, or a key ("fx:eq.midFreq"). */
function resolveTarget(t: Track, param: unknown, target: unknown): AutoTarget {
  if (target && typeof target === 'object') {
    const o = target as Record<string, unknown>;
    if (o.kind === 'mix' && AUTO_PARAMS.some((p) => p.id === o.param)) return mix(o.param as AutoParam);
    if (o.kind === 'fx') {
      const tg = parseTargetKey(`fx:${o.unit}.${o.param}`);
      if (!tg) throw new Error(`Unknown effect parameter "${o.unit}.${o.param}". Call list_automatable.`);
      return tg;
    }
    if (o.kind === 'plugin') {
      const slotId = (o.slot_id ?? o.slotId ?? null) as string | null;
      const paramId = String(o.param_id ?? o.paramId ?? '');
      if (!paramId) throw new Error('A plugin target needs param_id. Call list_automatable.');
      if (slotId && !t.fx?.plugins?.some((s) => s.id === slotId)) throw new Error(`Plugin slot "${slotId}" not found on this track`);
      return { kind: 'plugin', slotId, paramId };
    }
    throw new Error('target.kind must be "mix", "fx" or "plugin"');
  }
  const p = String(param ?? '');
  if (AUTO_PARAMS.some((x) => x.id === p)) return mix(p as AutoParam);
  const parsed = parseTargetKey(p);
  if (parsed) return parsed;
  throw new Error(`Unknown parameter "${p}". Use ${AUTO_PARAMS.map((x) => x.id).join(', ')}, or a target from list_automatable.`);
}

/** A plugin parameter's native range (the plugin has to be loaded). */
async function pluginRange(trackId: string, tg: Extract<AutoTarget, { kind: 'plugin' }>) {
  const prm = (await getPluginParams(trackId, tg.slotId ?? undefined)).find((x) => x.id === tg.paramId || x.label.toLowerCase() === tg.paramId.toLowerCase());
  if (!prm) throw new Error(`Unknown plugin parameter "${tg.paramId}". Call list_automatable.`);
  tg.paramId = prm.id;
  return { min: prm.min, max: prm.max };
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
    ...(p.master ? { master_chain: p.master } : {}),
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
      ...(hasAutomation(t)
        ? {
            // Keys as in set_automation: "volume", "pan"… for the mix, "fx:eq.midFreq", "plugin:<slot>:<param>".
            automation: Object.fromEntries(
              lanesOf(t)
                .filter((l) => l.points.length)
                .map((l) => [l.target.kind === 'mix' ? l.target.param : targetKey(l.target), l.points.map((pt) => ({ bar: +beatToBar(pt.beat).toFixed(4), value: +pt.value.toFixed(4) }))]),
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
    eq: { on: fx.eq.on, low: fx.eq.low, mid: fx.eq.mid, high: fx.eq.high, mid_freq: fx.eq.midFreq, ...(fx.eq.hpf ? { hpf: fx.eq.hpf } : {}) },
    compressor: { ...fx.comp, ...(fx.comp.sidechain ? { sidechain: { source_track_id: fx.comp.sidechain.sourceTrackId, amount: fx.comp.sidechain.amount } } : {}) },
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
      teach_mode: useTeachMode.getState().on,
      jam: jamStatus(),
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
    void autoVersion(tr('jr.newSong'), st().project, isAiCommand() ? 'ai' : 'user');
    const p = emptyProject(name ?? tr('name.newSong'), clamp(Number(bpm ?? 110), 40, 240));
    if (key) p.key = requireKey(key);
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

  set_key: ({ key: input, transpose_audio }) => {
    const key = requireKey(input);
    const from = st().project.key;
    const shift = transpose_audio ? keyInterval(from, String(key)) : 0;
    st().commit((d) => {
      d.key = key;
      // "Also transpose the audio clips" (F23): the nearest way (up to a tritone up or down).
      if (shift)
        for (const r of d.regions)
          if (r.audio) {
            const v = +((r.audio.pitch ?? 0) + shift).toFixed(2);
            if (v) r.audio.pitch = v;
            else delete r.audio.pitch;
          }
    });
    return { key, ...(transpose_audio ? { audio_clips_transposed_by: shift, clips: st().project.regions.filter((r) => r.audio).length } : {}) };
  },

  detect_tempo: async ({ sample_id, region_id, apply }) => {
    const p = st().project;
    const r = region_id ? requireRegion(p, region_id) : undefined;
    const id = String(sample_id ?? r?.audio?.sampleId ?? '');
    const info = requireSample(id);
    const buf = getBuffer(id)!;
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
    }
    const t = detectTempo(mono, buf.sampleRate, info.name);
    // Remember it on the clips of this sample (follow_tempo uses it), and switch them on if asked.
    st().commit((d) => {
      for (const x of d.regions)
        if (x.audio?.sampleId === id && (!r || x.id === r.id)) {
          const before = stretchFactor(x.audio, d.bpm);
          x.audio.stretch = { ...(x.audio.stretch ?? { mode: 'off' }), originalBpm: t.bpm, ...(apply ? { mode: 'follow_tempo' as const } : {}) };
          const after = stretchFactor(x.audio, d.bpm);
          if (before !== after) x.length = +((x.length * after) / before).toFixed(4);
        }
    });
    return { sample_id: id, bpm: t.bpm, confidence: t.confidence, from: t.source, beats: +((info.duration * t.bpm) / 60).toFixed(2), ...(apply ? { follow_tempo: true } : {}) };
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

  update_track: ({ track_id, name, instrument, volume, pan, mute, solo, reverb, delay, tone, polarity }) => {
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
      if (polarity !== undefined) {
        if (polarity) tr.polarity = true;
        else delete tr.polarity;
      }
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
        if (eq.hpf === null) delete fx.eq.hpf;
        else if (eq.hpf) fx.eq.hpf = { on: eq.hpf.on !== false, hz: num(eq.hpf.hz, 20, 2000) ?? fx.eq.hpf?.hz ?? 80 };
        // The high-pass alone doesn't switch the EQ bands on.
        if (eq.on === undefined && Object.keys(eq).some((k) => k !== 'hpf')) fx.eq.on = true;
      }
      if (compressor) {
        const c = compressor;
        if (c.on !== undefined) fx.comp.on = !!c.on;
        fx.comp.threshold = num(c.threshold, -60, 0) ?? fx.comp.threshold;
        fx.comp.ratio = num(c.ratio, 1, 20) ?? fx.comp.ratio;
        fx.comp.attack = num(c.attack, 0.001, 0.2) ?? fx.comp.attack;
        fx.comp.release = num(c.release, 0.02, 1) ?? fx.comp.release;
        fx.comp.makeup = num(c.makeup, 0, 24) ?? fx.comp.makeup;
        if (c.sidechain === null) delete fx.comp.sidechain;
        else if (c.sidechain) {
          const src = requireTrack(st().project, c.sidechain.source_track_id);
          if (src.id === t.id) throw new Error('A track can’t key its own compressor');
          fx.comp.sidechain = { sourceTrackId: src.id, amount: num(c.sidechain.amount, 0, 1) ?? fx.comp.sidechain?.amount ?? 1 };
        }
        if (c.on === undefined) fx.comp.on = true;
      }
      tr.fx = fx;
    });
    return { track_id: t.id, effects: describeFx(getTrack(st().project, t.id)!) };
  },

  set_automation: async ({ track_id, param, target, points, replace }) => {
    const t = requireTrack(st().project, track_id);
    const tg = resolveTarget(t, param, target);
    const range = tg.kind === 'plugin' ? await pluginRange(t.id, tg) : targetRange(tg);
    const parsed = ((points ?? []) as { bar?: number; beat?: number; value: number }[]).map((pt) => ({
      beat: pt.beat !== undefined ? Math.max(0, Number(pt.beat)) : barToBeat(Number(pt.bar ?? 1)),
      value: clamp(Number(pt.value), range.min, range.max),
    }));
    st().commit((d) => {
      const tr = d.tracks.find((x) => x.id === t.id)!;
      const keep = replace === false ? pointsOf(tr, tg) ?? [] : [];
      setPoints(tr, tg, [...keep, ...parsed]);
    });
    return { track_id: t.id, target: targetKey(tg), points: pointsOf(getTrack(st().project, t.id)!, tg)?.length ?? 0, range };
  },

  clear_automation: ({ track_id, param, target }) => {
    const t = requireTrack(st().project, track_id);
    const tg = param || target ? resolveTarget(t, param, target) : null;
    st().commit((d) => {
      const tr = d.tracks.find((x) => x.id === t.id)!;
      if (tg) setPoints(tr, tg, []);
      else delete tr.automation;
    });
    return { track_id: t.id, cleared: tg ? targetKey(tg) : 'all' };
  },

  list_automatable: async ({ track_id }) => {
    const t = requireTrack(st().project, track_id);
    const fx = normalizeFx(t.fx);
    const auto = (tg: Parameters<typeof targetKey>[0]) => (isAutomated(t, tg) ? { automated: true } : {});
    const plugins: { target: unknown; key: string; label: string; plugin: string; min: number; max: number; value: number; automated?: boolean }[] = [];
    const custom = st().project.instruments?.find((i) => i.id === t.instrument && (i.source === 'wam' || i.source === 'native'));
    const slots: { slotId: string | null; name: string }[] = [...(custom ? [{ slotId: null, name: custom.name }] : []), ...(fx.plugins ?? []).map((s) => ({ slotId: s.id, name: s.name }))];
    for (const s of slots) {
      try {
        for (const prm of await getPluginParams(t.id, s.slotId ?? undefined)) {
          const tg = { kind: 'plugin' as const, slotId: s.slotId, paramId: prm.id };
          plugins.push({ target: { kind: 'plugin', slot_id: s.slotId, param_id: prm.id }, key: targetKey(tg), label: prm.label, plugin: s.name, min: prm.min, max: prm.max, value: prm.value, ...auto(tg) });
        }
      } catch {
        // not loaded: no parameters to offer
      }
    }
    return {
      track_id: t.id,
      mix: AUTO_PARAMS.map((p) => ({ param: p.id, key: targetKey(mix(p.id)), min: p.min, max: p.max, value: +p.base(t).toFixed(4), ...auto(mix(p.id)) })),
      fx: FX_PARAMS.map((p) => {
        const tg = { kind: 'fx' as const, unit: p.unit, param: p.param };
        return { target: { kind: 'fx', unit: p.unit, param: p.param }, key: targetKey(tg), unit: p.unit, param: p.param, min: p.min, max: p.max, ...(p.units ? { units: p.units } : {}), value: (fx[p.unit] as unknown as Record<string, number>)[p.param], on: fx[p.unit].on, ...auto(tg) };
      }),
      plugins,
    };
  },

  delete_track: ({ track_id }) => {
    const t = requireTrack(st().project, track_id);
    if (st().project.regions.some((r) => r.trackId === t.id)) void autoVersion(`delete ${t.name}`, st().project, isAiCommand() ? 'ai' : 'user');
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

  update_region: ({ region_id, start_bar, length_bars, name, track_id, gain, offset_seconds, stretch_mode, ratio, original_bpm, pitch }) => {
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
      // Time-stretch and pitch (F23).
      if (x.audio && (stretch_mode !== undefined || ratio !== undefined || original_bpm !== undefined)) {
        const cur = x.audio.stretch ?? { mode: 'off' as const };
        const mode = (stretch_mode ?? (ratio !== undefined ? 'fixed' : cur.mode)) as 'off' | 'fixed' | 'follow_tempo';
        const next = { ...cur, mode, ...(ratio !== undefined ? { ratio: clamp(Number(ratio), 0.25, 4) } : {}), ...(original_bpm !== undefined ? { originalBpm: clamp(Number(original_bpm), 40, 240) } : {}) };
        if (mode === 'follow_tempo' && !next.originalBpm) throw new Error('follow_tempo needs the clip\'s original tempo: pass original_bpm, or call detect_tempo first');
        if (mode === 'fixed' && !next.ratio) next.ratio = 1;
        // The clip keeps its musical length: in beats when it follows the tempo, in seconds × ratio when fixed.
        const before = stretchFactor(x.audio, d.bpm);
        x.audio.stretch = next;
        const after = stretchFactor(x.audio, d.bpm);
        if (length_bars === undefined && before !== after) x.length = +((x.length * after) / before).toFixed(4);
      }
      if (x.audio && pitch !== undefined) {
        const v = clamp(Math.round(Number(pitch) * 100) / 100, -24, 24);
        if (v) x.audio.pitch = v;
        else delete x.audio.pitch;
      }
    });
    const a = getRegion(st().project, r.id)!.audio;
    return { region_id: r.id, ...(a?.stretch ? { stretch: a.stretch, factor: +stretchFactor(a, st().project.bpm).toFixed(4) } : {}), ...(a?.pitch ? { pitch: a.pitch } : {}) };
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
    const { past, future, project } = st();
    // Each entry holds the project before its step: the step's result is the next snapshot.
    const fmt = (e: HistoryEntry, after: Project) => ({
      label: e.label,
      source: e.source,
      commands: e.commands,
      at: e.at,
      plugins_changed: pluginsChanged(e.project, after),
      ...(e.pluginStateDropped ? { plugin_state_dropped: true } : {}),
    });
    const tx = st().activeTransaction;
    return {
      past: past.map((e, i) => fmt(e, past[i + 1]?.project ?? project)).slice(-n).reverse(),
      // Future entries hold the project after their step; the step starts from the previous one.
      future: future.slice(0, n).map((e, i) => ({ ...fmt(e, e.project), plugins_changed: pluginsChanged(i === 0 ? project : future[i - 1].project, e.project) })),
      open: tx ? { label: tx.label, source: tx.source, commands: tx.commands } : null,
    };
  },

  export_project_json: ({ canonical }) => (canonical ? { canonical: true, json: canonicalJSON(st().project) } : st().project),

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
    void autoVersion(tr('jr.import'), st().project, isAiCommand() ? 'ai' : 'user');
    st().loadProject(p);
    return summarize(p);
  },

  export_wav: async ({ return_data, sample_rate, bit_depth, dither }) => {
    const sampleRate = Number(sample_rate ?? 44100);
    const bits = Number(bit_depth ?? 16);
    if (!(WAV_RATES as readonly number[]).includes(sampleRate)) throw new Error(`sample_rate must be one of ${WAV_RATES.join(', ')}`);
    if (!(WAV_BITS as readonly number[]).includes(bits)) throw new Error('bit_depth must be 16, 24 or 32 (float)');
    markFirstExport();
    await captureWamStates();
    const p = st().project;
    const blob = await renderProject(p, { sampleRate: sampleRate as WavFormat['sampleRate'], bits: bits as WavFormat['bits'], dither: dither ?? bits === 16 });
    if (return_data) return { bytes: blob.size, filename: `${safeName(p.name)}.wav`, data_base64: toBase64(new Uint8Array(await blob.arrayBuffer())) };
    download(blob, `${safeName(p.name)}.wav`);
    return { exported: true, bytes: blob.size, sample_rate: sampleRate, bit_depth: bits === 32 ? '32-bit float' : bits, note: 'The WAV was downloaded by the browser.' };
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

  set_energy_curve: ({ points, shape, length_bars, seconds }) => setEnergyCurve({ points, shape, length_bars, seconds }),
  get_energy: () => getEnergy(),
  arrange_from_energy: ({ seed, genre, as_branch, keep_sections, modulate }) => arrangeFromEnergy({ seed, genre, as_branch, keep_sections, modulate }, isAiCommand() ? 'ai' : 'user'),
  add_transition: ({ at_bar, kind, bars }) => addTransition({ at_bar, kind, bars }),

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

  // ---------- multiplayer ----------

  create_room: ({ password, via }) => createRoom({ password, via }),
  join_room: ({ room, password, via }) => joinRoom(String(room ?? ''), password, via),
  leave_room: () => leaveRoom(),
  get_peers: () => getPeers(),

  // ---------- jam (call-and-response) ----------

  play_phrase: ({ track_id, notes, at, commit }) => {
    const p = st().project;
    const trackId = track_id ?? useJam.getState().trackId;
    if (!trackId) throw new Error('Give track_id (or set_jam_mode with response_track_id)');
    const track = requireTrack(p, trackId);
    const parsed = toNotes(notes, track.kind === 'drums').map(({ id: _, ...n }) => n);
    return playPhrase(track.id, parsed, at, !!commit);
  },

  set_jam_mode: ({ enabled, response_track_id, window }) => {
    const id = response_track_id ? requireTrack(st().project, response_track_id).id : undefined;
    return setJamMode(enabled !== false, id, window);
  },

  keep_answer: () => keepAnswer(),
  keep_phrase: ({ phrase_id }) => keepPhrase(String(phrase_id ?? '')),

  // ---------- versions ----------

  save_version: async ({ label }) => {
    const v = await saveVersion(String(label ?? ''), isAiCommand() ? 'ai' : 'user');
    return { version_id: v.id, label: v.label, branch: v.branch };
  },

  list_versions: ({ branch }) => listVersions(branch),

  create_branch: ({ name, from_version_id }) => createBranch(String(name ?? ''), from_version_id),

  checkout: ({ branch, version_id }) => checkout({ branch, version_id }, isAiCommand() ? 'ai' : 'user'),

  diff_versions: async ({ a, b }) => {
    const d = await diffVersions(String(a ?? 'HEAD'), b);
    // Compact: the summary plus counts and ids, not whole regions.
    return {
      identical: d.identical,
      summary: d.summary,
      project: d.project,
      tracks: { added: d.tracks.added.map((t) => ({ id: t.id, name: t.name })), removed: d.tracks.removed.map((t) => ({ id: t.id, name: t.name })), changed: d.tracks.changed },
      regions: {
        added: d.regions.added.map((r) => ({ id: r.id, name: r.name, track_id: r.trackId, start_bar: beatToBar(r.start) })),
        removed: d.regions.removed.map((r) => ({ id: r.id, name: r.name, track_id: r.trackId, start_bar: beatToBar(r.start) })),
        changed: d.regions.changed.map((r) => ({ id: r.id, name: r.name, track_id: r.track_id, fields: r.fields, ...(r.notes ? { notes: { added: r.notes.added.length, removed: r.notes.removed.length, changed: r.notes.changed.length } } : {}) })),
      },
      sections: { added: d.sections.added.map((s) => s.name), removed: d.sections.removed.map((s) => s.name), changed: d.sections.changed },
      lyrics_changed: d.lyrics_changed,
    };
  },

  merge: ({ from_branch, strategy, pick }) => mergeBranch(String(from_branch ?? ''), strategy ?? 'manual', pick ?? [], isAiCommand() ? 'ai' : 'user'),

  // ---------- annotations ("Explain" mode) ----------

  annotate: ({ target, text, reply_to }) => {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('text is empty');
    if (body.length > MAX_ANNOTATION) throw new Error(`Annotations are at most ${MAX_ANNOTATION} characters (got ${body.length}): keep them short`);
    const p = st().project;
    const parent = reply_to ? p.annotations?.find((x) => x.id === reply_to) : undefined;
    if (reply_to && !parent) throw new Error(`Annotation "${reply_to}" not found. Call list_annotations.`);
    const tgt = parent ? parent.target : checkTarget(p, target);
    const ai = isAiCommand();
    const a: Annotation = { id: uid('ann'), target: tgt, text: body, author: authorNow(ai), createdAt: Date.now(), ...(parent ? { replyTo: parent.id } : {}), ...(ai && st().activeTransaction ? { txId: st().activeTransaction!.id } : {}) };
    st().commit((d) => void (d.annotations = [...(d.annotations ?? []), a]), { label: 'Annotation' });
    return { annotation_id: a.id, target: tgt };
  },

  list_annotations: ({ target, include_resolved }) => {
    const list = (st().project.annotations ?? []).filter((a) => (include_resolved || !a.resolved) && (!target || matchesTarget(a.target, target)));
    return { annotations: list.map((a) => ({ id: a.id, target: a.target, text: a.text, author: a.author, ...(a.replyTo ? { reply_to: a.replyTo } : {}), created_at: a.createdAt, ...(a.resolved ? { resolved: true } : {}), ...(a.orphaned ? { orphaned: true } : {}) })) };
  },

  resolve_annotation: ({ annotation_id, resolved }) => {
    const a = (st().project.annotations ?? []).find((x) => x.id === annotation_id);
    if (!a) throw new Error(`Annotation "${annotation_id}" not found`);
    const on = resolved !== false;
    st().commit((d) => {
      const x = d.annotations!.find((y) => y.id === annotation_id)!;
      if (on) x.resolved = true;
      else delete x.resolved;
    }, { label: 'Annotation' });
    return { annotation_id, resolved: on };
  },

  delete_annotation: ({ annotation_id }) => {
    if (!(st().project.annotations ?? []).some((x) => x.id === annotation_id)) throw new Error(`Annotation "${annotation_id}" not found`);
    st().commit((d) => void (d.annotations = d.annotations!.filter((y) => y.id !== annotation_id)), { label: 'Annotation' });
    return { deleted: annotation_id };
  },

  // ---------- takes ----------

  add_take: ({ region_id, notes, name, activate }) => {
    const p = st().project;
    const r = requireRegion(p, region_id);
    if (r.audio) throw new Error('add_take adds MIDI notes; this is an audio region');
    const parsed = toNotes(notes, getTrack(p, r.trackId)?.kind === 'drums');
    const base = withTakes(r, Date.now(), () => uid('take'));
    const take = { id: uid('take'), name: String(name ?? nextTakeName(base.takes)), notes: parsed, createdAt: Date.now(), author: (isAiCommand() ? 'ai' : 'user') as 'ai' | 'user' };
    const on = activate !== false;
    st().commit((d) => {
      const x = d.regions.find((y) => y.id === r.id)!;
      x.takes = [...base.takes, take];
      x.activeTakeId = on ? take.id : base.activeTakeId;
      if (on) {
        x.notes = parsed.map((n) => ({ ...n }));
        x.length = Math.max(x.length, regionLengthFor(parsed));
      }
    });
    return { region_id: r.id, take_id: take.id, name: take.name, takes: base.takes.length + 1, active: on };
  },

  list_takes: ({ region_id }) => {
    const r = requireRegion(st().project, region_id);
    const { takes, activeTakeId } = withTakes(r, Date.now(), () => 'take_1');
    return {
      region_id: r.id,
      active_take_id: r.takes?.length ? activeTakeId : null,
      takes: (r.takes?.length ? takes : []).map((t) => ({ id: t.id, name: t.name, author: t.author, notes: t.notes.length, audio: !!t.audio, active: t.id === activeTakeId, created_at: t.createdAt })),
    };
  },

  set_active_take: ({ region_id, take_id }) => {
    const r = requireRegion(st().project, region_id);
    if (!r.takes?.length) throw new Error('This region has no takes');
    const { takes } = withTakes(r, Date.now(), () => uid('take'));
    const take = takes.find((t) => t.id === take_id || t.name.toLowerCase() === String(take_id).toLowerCase());
    if (!take) throw new Error(`Take "${take_id}" not found. Call list_takes.`);
    st().commit((d) => {
      const x = d.regions.find((y) => y.id === r.id)!;
      x.takes = takes;
      x.activeTakeId = take.id;
      x.notes = take.notes.map((n) => ({ ...n }));
      if (take.audio) x.audio = { ...take.audio };
      x.length = Math.max(x.length, x.audio ? x.length : regionLengthFor(x.notes));
    });
    return { region_id: r.id, active_take_id: take.id, name: take.name };
  },

  delete_take: ({ region_id, take_id }) => {
    const r = requireRegion(st().project, region_id);
    const { takes, activeTakeId } = withTakes(r, Date.now(), () => uid('take'));
    const i = takes.findIndex((t) => t.id === take_id);
    if (i < 0) throw new Error(`Take "${take_id}" not found`);
    if (takes.length === 1) throw new Error('A region keeps at least one take');
    const rest = takes.filter((t) => t.id !== take_id);
    const active = activeTakeId === take_id ? rest[Math.max(0, i - 1)] : rest.find((t) => t.id === activeTakeId)!;
    st().commit((d) => {
      const x = d.regions.find((y) => y.id === r.id)!;
      x.takes = rest;
      x.activeTakeId = active.id;
      x.notes = active.notes.map((n) => ({ ...n }));
      if (active.audio) x.audio = { ...active.audio };
    });
    return { region_id: r.id, deleted: take_id, active_take_id: active.id };
  },

  comp_takes: ({ region_id, segments, name }) => {
    const r = requireRegion(st().project, region_id);
    if (r.audio) throw new Error('Comping works on MIDI takes');
    if (!r.takes?.length) throw new Error('This region has no takes');
    const { takes } = withTakes(r, Date.now(), () => uid('take'));
    const segs = checkSegments((segments ?? []) as CompSegment[], takes, r.length);
    const notes = compNotes(takes, segs, () => uid('n'));
    const comp = { id: uid('take'), name: String(name ?? 'Comp'), notes, createdAt: Date.now(), author: (isAiCommand() ? 'ai' : 'user') as 'ai' | 'user' };
    st().commit((d) => {
      const x = d.regions.find((y) => y.id === r.id)!;
      x.takes = [...takes, comp];
      x.activeTakeId = comp.id;
      x.notes = notes.map((n) => ({ ...n }));
    });
    return { region_id: r.id, take_id: comp.id, name: comp.name, notes: notes.length, segments: segs.map((s) => ({ ...s, take: takes.find((t) => t.id === s.take_id)!.name })) };
  },

  // ---- drummer (F24)
  add_drummer: ({ track_id, section_id, from_bar, to_bar, style, complexity, loudness, swing, fills, seed }) => {
    const p = st().project;
    const opts = drummerOptions({ style, complexity, loudness, swing, fills, seed });
    let from: number;
    let to: number;
    if (section_id) {
      const sec = p.sections?.find((s) => s.id === section_id || s.name.toLowerCase() === String(section_id).toLowerCase());
      if (!sec) throw new Error(`Section "${section_id}" not found. Call get_structure.`);
      from = sec.start;
      to = sec.start + sec.length;
    } else if (from_bar !== undefined) {
      from = barToBeat(Number(from_bar));
      to = to_bar !== undefined ? barToBeat(Number(to_bar) + 1) : from + 4 * BEATS_PER_BAR;
    } else {
      const secs = p.sections ?? [];
      from = secs.length ? Math.min(...secs.map((s) => s.start)) : 0;
      to = secs.length ? Math.max(...secs.map((s) => s.start + s.length)) : Math.max(8 * BEATS_PER_BAR, Math.ceil(projectEnd(p) / BEATS_PER_BAR) * BEATS_PER_BAR);
    }
    if (!(to > from)) throw new Error('to_bar must be after from_bar');
    let track = track_id ? requireTrack(p, track_id) : p.tracks.find((t) => t.kind === 'drums');
    if (track && track.kind !== 'drums') throw new Error('The drummer plays on a drum track');
    if (!track) {
      track = makeTrack(p, 'drums', opts.style === 'trap' ? 'kit-808' : opts.style === 'lo-fi' || opts.style === 'boom-bap' ? 'kit-lofi' : 'kit-studio', 'Drummer');
      const tr = track;
      st().commit((d) => void d.tracks.push(tr));
    }
    const notes = drummerNotes(p.sections ?? [], from, to, opts);
    const region: Region = { id: uid('rgn'), trackId: track.id, name: `Drummer · ${opts.style}`, start: from, length: to - from, notes, drummer: opts };
    st().commit((d) => void d.regions.push(region));
    return { region_id: region.id, track_id: track.id, from_bar: beatToBar(from), bars: (to - from) / BEATS_PER_BAR, notes: notes.length, ...opts };
  },

  regenerate_drummer: ({ region_id, seed, as_take, style, complexity, loudness, swing, fills }) => {
    const p = st().project;
    const r = requireRegion(p, region_id);
    if (!r.drummer) throw new Error('This region was not made by the drummer (add_drummer)');
    const opts = drummerOptions({ ...r.drummer, ...(style !== undefined ? { style } : {}), ...(complexity !== undefined ? { complexity } : {}), ...(loudness !== undefined ? { loudness } : {}), ...(swing !== undefined ? { swing } : {}), ...(fills !== undefined ? { fills } : {}), seed: seed ?? r.drummer.seed + 1 });
    const notes = drummerNotes(p.sections ?? [], r.start, r.start + r.length, opts);
    if (as_take) {
      const base = withTakes(r, Date.now(), () => uid('take'));
      const take = { id: uid('take'), name: `${nextTakeName(base.takes)} · seed ${opts.seed}`, notes, createdAt: Date.now(), author: (isAiCommand() ? 'ai' : 'user') as 'ai' | 'user' };
      st().commit((d) => {
        const x = d.regions.find((y) => y.id === r.id)!;
        x.takes = [...base.takes, take];
        x.activeTakeId = take.id;
        x.notes = notes.map((n) => ({ ...n }));
        x.drummer = opts;
      });
      return { region_id: r.id, take_id: take.id, notes: notes.length, ...opts };
    }
    st().commit((d) => {
      const x = d.regions.find((y) => y.id === r.id)!;
      x.notes = notes;
      x.drummer = opts;
      x.name = `Drummer · ${opts.style}`;
    });
    return { region_id: r.id, notes: notes.length, ...opts };
  },

  // ---- loop library (F24)
  search_loops: async ({ query, bpm, key, limit }) => {
    const p = st().project;
    const res = await findLoops({ query, bpm: bpm ?? undefined, key: key ?? undefined, limit: limit ?? 12 });
    return { song: { bpm: p.bpm, key: p.key }, loops: res.map((l) => ({ id: l.id, name: l.name, bpm: l.bpm, ...(l.key ? { key: l.key } : {}), bars: l.bars, tags: l.tags, license: l.license, author: l.author })) };
  },

  add_loop: async ({ loop_id, track_id, start_bar, repeat, follow_tempo, match_key }) =>
    addLoop(String(loop_id ?? ''), { trackId: track_id ? requireTrack(st().project, track_id).id : undefined, startBar: start_bar, repeat, followTempo: follow_tempo, matchKey: match_key }),

  // ---- master chain (G1)
  set_master_chain: async ({ on, eq, glue, width, limiter, platform }) => {
    const p = st().project;
    const target = platform ? PLATFORM_TARGETS[platform as Platform] : undefined;
    if (platform && !target) throw new Error(`Unknown platform "${platform}". Platforms: ${Object.keys(PLATFORM_TARGETS).join(', ')}`);
    const n = (v: unknown, lo: number, hi: number) => (v === undefined || v === null ? undefined : clamp(Number(v), lo, hi));
    const strip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
    const m = mergeMaster(p.master, {
      ...(on !== undefined ? { on: !!on } : {}),
      ...(eq ? { eq: strip({ on: eq.on ?? true, tilt: n(eq.tilt, -3, 3), low: n(eq.low, -12, 12), high: n(eq.high, -12, 12), bands: eq.bands?.map((x: { hz: number; gain: number; q?: number }) => ({ hz: clamp(Number(x.hz), 20, 20000), gain: clamp(Number(x.gain), -12, 12), q: clamp(Number(x.q ?? 1), 0.1, 10) })) }) } : {}),
      ...(glue ? { glue: strip({ on: glue.on ?? true, threshold: n(glue.threshold, -40, 0), ratio: n(glue.ratio, 1, 10), attack: n(glue.attack, 0.001, 0.2), release: n(glue.release, 0.02, 1.5), makeup: n(glue.makeup, 0, 12) }) } : {}),
      ...(width ? { width: strip({ on: width.on ?? true, amount: n(width.amount, 0, 2), monoBelowHz: n(width.mono_below_hz, 20, 400) }) } : {}),
      ...(limiter || target ? { limiter: strip({ on: limiter?.on ?? true, ceilingDbtp: n(limiter?.ceiling_dbtp, -6, 0) ?? target?.ceiling, targetLufs: n(limiter?.target_lufs, -30, -4) ?? target?.lufs, release: n(limiter?.release_ms, 10, 1000) }) } : {}),
    });
    let report: Record<string, unknown> = {};
    if (m.on && m.limiter.on) {
      // Find the limiter's input gain by rendering: the loudness target is a specification, met within ±0.3 LU.
      const f = await fitLimiter(p, m);
      m.limiter.inputGainDb = f.inputGainDb;
      report = {
        loudness: { before_lufs: +f.beforeLufs.toFixed(1), after_lufs: +f.lufs.toFixed(1), target_lufs: m.limiter.targetLufs, true_peak_dbtp: +f.truePeak.toFixed(2), ceiling_dbtp: m.limiter.ceilingDbtp, limiter_gain_db: m.limiter.inputGainDb, renders: f.renders },
        ...(f.reached ? {} : { warning: outOfReach(m, f.lufs) }),
      };
    }
    st().commit((d) => void (d.master = m), { label: 'Master chain' });
    return { master: m, ...report };
  },

  // ---- Mix & Master Pilot (G1)
  mix_pilot: (args) => runPilot(args),
  set_pilot_amount: ({ amount }) => setPilotAmount(Number(amount)),
  fix_pilot: () => fixPilot(),
  set_track_role: ({ track_id, role }) => setTrackRole(String(track_id ?? ''), (role ?? null) as MixRole | null),
  export_for_platforms: async ({ platforms, stems, versions, return_data }) => {
    markFirstExport();
    await captureWamStates();
    const res = await exportForPlatforms(st().project, { platforms: Array.isArray(platforms) ? platforms.map(String) : [], stems: !!stems, versions });
    const summary = { platforms: res.reports, stems: res.stems, ...(res.stem_residual_db !== null ? { stem_residual_db: Number.isFinite(res.stem_residual_db) ? +res.stem_residual_db.toFixed(1) : -999 } : {}), ...(res.notes.length ? { notes: res.notes } : {}) };
    if (return_data) return { bytes: res.zip.length, filename: res.filename, data_base64: toBase64(res.zip), ...summary };
    download(new Blob([res.zip as BlobPart], { type: 'application/zip' }), res.filename);
    return { exported: true, bytes: res.zip.length, filename: res.filename, note: 'The zip was downloaded by the browser.', ...summary };
  },

  // ---- Ensemble (SPEC v0.6)
  create: (args) => createPart(args as CreateArgs),
  transform: (args) => transformPart(args as TransformArgs),
  separate: (args) => separateRegion(args as SeparateArgs),
  sing: (args) => singPart(args as SingArgs),
  start_session: async (args) => (await import('./session/session')).startSession(args as import('./session/session').SessionArgs),
  stop_session: async () => (await import('./session/session')).stopSession(),
  get_session: async () => (await import('./session/session')).summary(),
  set_synth_params: ({ track_id, values, reset }) => (values && Object.keys(values).length) || reset ? setSynthParams(String(track_id), (values ?? {}) as Record<string, number>, !!reset) : describeSynth(String(track_id)),
  sound_from_words: ({ description, family }) => {
    const w = soundFromWords(String(description), family);
    const patch = keepPatch({ preset: w.preset, params: w.params, label: String(description), why: w.why });
    return { candidate_id: patch.id, preset: patch.preset, family: w.family, params: patch.params, why: w.why, note: 'A starting point from the words: apply it with apply_patch (on a track, or a new one), then shape it with set_synth_params.' };
  },
  apply_patch: ({ candidate_id, track_id }) => applyPatch(String(candidate_id), track_id),
  match_sound: async (args) => (await import('./soundmatch/match')).matchSoundCommand(args as Parameters<typeof import('./soundmatch/match').matchSoundCommand>[0]),
  tone_match: async ({ track_id, from_bar, to_bar, apply, ...source }) => {
    const { resolveSource, toneMatch } = await import('./soundmatch/tone');
    return toneMatch(String(track_id), resolveSource(source), { from_bar, to_bar, apply });
  },
  get_release: () => getRelease(),
  set_release: ({ ai_disclosure, ...a }) => setRelease({ ...(a as SetReleaseArgs), ...(ai_disclosure ? { aiDisclosure: String(ai_disclosure) } : {}) }),
  check_release: ({ platforms }) => checkReleaseCommand(platforms as string[] | undefined),
  generate_cover: (a) => generateCover(a as { style?: string; palette?: string; seed?: number }),
  export_release_kit: async () => {
    const kit = await releaseKit();
    const name = `${safeName(st().project.release?.title || st().project.name)} - Release Kit.zip`;
    download(new Blob([kit.zip as BlobPart], { type: 'application/zip' }), name);
    return { saved: name, files: kit.files, bytes: kit.zip.length };
  },
  list_publish_targets: async () => (await import('./publish/publish')).listPublishTargets(),
  publish: async ({ platforms, privacy, confirm_timeout_ms }) => (await import('./publish/publish')).publish({ platforms, privacy, confirm_timeout_ms }),
  get_publications: async () => (await import('./publish/publish')).getPublications(),
  render_video: async ({ format, section_id, max_seconds }) => {
    const { renderVideo } = await import('./publish/video');
    const v = await renderVideo(st().project, { format, section_id, max_seconds });
    const name = `${safeName(st().project.release?.title || st().project.name)}${v.format === '9:16' ? ' (Short)' : ''}.mp4`;
    download(new Blob([v.mp4 as BlobPart], { type: 'video/mp4' }), name);
    return { saved: name, format: v.format, width: v.width, height: v.height, seconds: Math.round(v.seconds * 100) / 100, from_seconds: Math.round(v.from * 100) / 100, ...(v.section ? { section: v.section } : {}), video_codec: v.videoCodec, audio_codec: v.audioCodec, bytes: v.mp4.length, lyric_lines: v.cues.length };
  },
  set_voice_control: async ({ enabled, engine: eng, language, push_to_talk_cc, feedback }) => {
    const { setVoiceControl, useVoice } = await import('./voice/control');
    setVoiceControl({ ...(enabled !== undefined ? { enabled } : {}), ...(eng ? { engine: eng } : {}), ...(language ? { lang: language } : {}), ...(push_to_talk_cc !== undefined ? { pushToTalkCc: push_to_talk_cc } : {}), ...(feedback !== undefined ? { feedback } : {}) });
    const v = useVoice.getState();
    return { enabled: v.enabled, engine: v.engine, language: v.lang, push_to_talk: v.pushToTalkCc !== null ? `MIDI CC ${v.pushToTalkCc}, or hold the \` key` : 'hold the ` key', feedback: v.feedback, ...(v.engine === 'webspeech' ? { note: 'Web Speech: on some browsers the audio goes to an online service; Vosk keeps it on this computer.' } : {}) };
  },
  // The Song Context Package (§3): what an engine — or the director — needs to know about the song.
  get_context: async ({ section_id, from_bar, to_bar }) => {
    const p = st().project;
    const scope = section_id || from_bar !== undefined ? scopeFor(p, { section_id, from_bar, to_bar }) : undefined;
    return buildContext(p, { ...(scope ? { scope } : {}) });
  },

  list_engines: async ({ capability }) => {
    const engines = await allEngines();
    const policy = useEnsemble.getState().policy;
    const caps = capability ? [String(capability)] : [...new Set(engines.flatMap((e) => Object.keys(e.manifest.capabilities)))];
    return {
      policy,
      engines: engines.map((e) => ({
        id: e.id,
        name: e.manifest.engine.name,
        version: e.manifest.engine.version,
        where: e.manifest.runtime.where,
        capabilities: Object.keys(e.manifest.capabilities),
        licence: { code: e.manifest.license.code, weights: e.manifest.license.weights, commercial: e.manifest.license.commercial, ...(e.manifest.license.attribution ? { attribution: e.manifest.license.attribution } : {}) },
        ...(e.manifest.runtime.pricing ? { pricing: e.manifest.runtime.pricing } : {}),
        ...(e.gpu ? { gpu: e.gpu } : {}),
      })),
      // The same routes create takes: the user's taste from blind tests included.
      routes: caps.map((c) => {
        const t = preferencesFor(c);
        const r = route({ capability: c as Capability }, engines, policy, { [c]: t.prefs }, { [c]: t.confidence });
        const taste = tasteByCapability().find((x) => x.capability === c)?.ranking;
        return { capability: c, order: r.candidates.map((x) => x.id), excluded: r.excluded, ...(taste?.length ? { taste: taste.map((x) => ({ engine: x.engine, score: x.score, interval: x.interval, comparisons: x.comparisons })) } : {}) };
      }),
      unavailable: useEnsemble.getState().broken,
    };
  },

  get_ledger: () => {
    const p = st().project;
    return { contributions: (p.ledger ?? []).map((e) => ({ ...e, at: new Date(e.at).toISOString() })), share: shares(p), attributions: attributions(p), non_commercial: nonCommercial(p).map((e) => e.engine) };
  },

  set_engine_policy: ({ commercial_only, local_only, allow_cloud }) =>
    setPolicy({ ...(commercial_only !== undefined ? { commercial_only: !!commercial_only } : {}), ...(local_only !== undefined ? { local_only: !!local_only } : {}), ...(allow_cloud !== undefined ? { allow_cloud: !!allow_cloud } : {}) }),

  // ---- safety net (F21)
  get_timeline: async ({ from, to }) => {
    const r = await timeline(from !== undefined ? toTime(from) : undefined, to !== undefined ? toTime(to) : undefined);
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
    return { first: iso(r.first), last: iso(r.last), entries: r.entries.slice(-300).map((e) => ({ at: iso(e.at), seq: e.seq, kind: e.kind, label: e.label, source: e.source })) };
  },

  preview_at: async ({ time }) => {
    const { project, entry } = await projectAt(toTime(time));
    return { at: new Date(entry.at).toISOString(), after: entry.label, project: summarize(project) };
  },

  restore_at: async ({ time, as_branch }) => restoreAt(toTime(time), as_branch, isAiCommand() ? 'ai' : 'user'),

  // ---- monitoring (F20)
  get_meters: () => {
    const p = st().project;
    const fin = (v: number) => (Number.isFinite(v) ? +v.toFixed(1) : null);
    const read = (key: string) => {
      const r = readMeter(key);
      return { momentary_lufs: fin(r.momentary), short_term_lufs: fin(r.shortTerm), integrated_lufs: fin(r.integrated), true_peak_dbtp: fin(r.truePeak), true_peak_max_dbtp: fin(r.truePeakMax) };
    };
    const master = read('master');
    const target = currentTarget();
    return {
      playing: engine.playing,
      master: { ...master, target: { id: target.id, lufs: target.lufs, ceiling_dbtp: target.ceiling }, status: targetStatus(master.short_term_lufs ?? -Infinity, master.true_peak_max_dbtp ?? -Infinity, target) },
      tracks: p.tracks.map((tr) => ({ track_id: tr.id, name: tr.name, ...read(tr.id) })),
      monitoring: { mono: useMonitoring.getState().mono, dim: useMonitoring.getState().dim },
      ...(engine.playing ? {} : { note: 'The meters read live audio: start playback (transport play) and wait at least 3 s for short-term values.' }),
    };
  },

  set_monitoring: ({ mono, dim, target, reset_meters }) => {
    setMonitoring({ ...(mono !== undefined ? { mono: !!mono } : {}), ...(dim !== undefined ? { dim: !!dim } : {}), ...(target ? { target } : {}) });
    if (reset_meters) resetMeters();
    return { ...useMonitoring.getState(), note: 'Monitoring only: mono and dim never affect exports.' };
  },

  level_match: async ({ track_id, slot_id, apply }) => levelMatch(requireTrack(st().project, track_id).id, slot_id ?? null, !!apply),

  // ---- flub markers (F18)
  add_flub: ({ beat, bar, kind, text, track_id }) => {
    const at = beat !== undefined ? Number(beat) : bar !== undefined ? barToBeat(Number(bar)) : undefined;
    const trackId = track_id ? requireTrack(st().project, track_id).id : undefined;
    const f = markFlub(kind ?? 'flub', { beat: at, trackId, text, author: isAiCommand() ? 'ai' : 'user' });
    return { flub_id: f.id, beat: f.beat, bar: +beatToBar(f.beat).toFixed(2), kind: f.kind, pending: !st().project.flubs?.some((x) => x.id === f.id) };
  },

  list_flubs: ({ unresolved_only }) => {
    const p = st().project;
    const pending = useFlubLive.getState().pending.map((x) => ({ ...x.flub, pending: true }));
    const all = [...(p.flubs ?? []), ...pending].filter((f) => !unresolved_only || !f.resolved).sort((a, b) => a.beat - b.beat);
    return {
      flubs: all.map((f) => {
        const r = f.regionId ? getRegion(p, f.regionId) : undefined;
        const takeId = r ? takeOf(f, r) : undefined;
        return {
          id: f.id,
          kind: f.kind,
          bar: +beatToBar(f.beat).toFixed(2),
          beat: f.beat,
          ...(f.text ? { text: f.text } : {}),
          ...(f.trackId ? { track_id: f.trackId, track: getTrack(p, f.trackId)?.name } : {}),
          ...(r ? { region_id: r.id, take_id: takeId ?? null, take: r.takes?.find((t) => t.id === takeId)?.name ?? null, takes_in_region: r.takes?.length ?? 0 } : {}),
          resolved: !!f.resolved,
          ...('pending' in f ? { pending: true } : {}),
          author: f.author ?? 'user',
        };
      }),
    };
  },

  resolve_flub: ({ flub_id, resolved }) => {
    const f = requireFlub(flub_id);
    st().commit((d) => void (d.flubs!.find((x) => x.id === f.id)!.resolved = resolved !== false));
    return { flub_id: f.id, resolved: resolved !== false };
  },

  delete_flub: ({ flub_id }) => {
    const f = requireFlub(flub_id);
    st().commit((d) => void (d.flubs = d.flubs!.filter((x) => x.id !== f.id)));
    return { deleted: f.id };
  },

  replace_with_best_take: ({ flub_id }) => {
    const f = requireFlub(flub_id);
    const p = st().project;
    const r = f.regionId ? getRegion(p, f.regionId) : undefined;
    if (!r?.takes || r.takes.length < 2) throw new Error('This flub is not on a region with several takes: record more takes (cycle recording) or fix it by hand');
    const best = bestTakeAt(r, p.flubs ?? [], f.beat);
    if (!best) throw new Error('Every take has a mistake at this point: re-record this part');
    const { takes, activeTakeId } = withTakes(r, Date.now(), () => uid('take'));
    if (best.id === activeTakeId) {
      st().commit((d) => void (d.flubs!.find((x) => x.id === f.id)!.resolved = true));
      return { region_id: r.id, take_id: best.id, take: best.name, already_active: true };
    }
    const { from, to } = fixWindow(r, f.beat);
    // Audio takes switch as a whole; MIDI takes are comped: the best take only around the mistake.
    if (r.audio) {
      st().commit((d) => {
        const x = d.regions.find((y) => y.id === r.id)!;
        x.takes = takes;
        x.activeTakeId = best.id;
        if (best.audio) x.audio = { ...best.audio };
        d.flubs!.find((y) => y.id === f.id)!.resolved = true;
      });
      return { region_id: r.id, take_id: best.id, take: best.name, whole_take: true };
    }
    const segs: CompSegment[] = [
      ...(from > 0 ? [{ from_beat: 0, to_beat: from, take_id: activeTakeId }] : []),
      { from_beat: from, to_beat: to, take_id: best.id },
      ...(to < r.length ? [{ from_beat: to, to_beat: r.length, take_id: activeTakeId }] : []),
    ];
    const notes = compNotes(takes, segs, () => uid('n'));
    const comp = { id: uid('take'), name: `Comp (${best.name} @ ${+beatToBar(f.beat).toFixed(2)})`, notes, createdAt: Date.now(), author: (isAiCommand() ? 'ai' : 'user') as 'ai' | 'user' };
    st().commit((d) => {
      const x = d.regions.find((y) => y.id === r.id)!;
      x.takes = [...takes, comp];
      x.activeTakeId = comp.id;
      x.notes = notes.map((n) => ({ ...n }));
      d.flubs!.find((y) => y.id === f.id)!.resolved = true;
    });
    return { region_id: r.id, take_id: comp.id, name: comp.name, from_take: best.name, from_beat: from, to_beat: to };
  },

  start_ab_test: ({ region_id, take_ids, loop }) => {
    const r = requireRegion(st().project, region_id);
    const ids = (take_ids as string[] | undefined)?.length ? (take_ids as string[]) : (r.takes ?? []).slice(-4).map((t) => t.id);
    return startABTest(r.id, ids, loop !== false);
  },

  // ---------- reference track ----------

  import_reference: ({ data_base64, filename, from_seconds, to_seconds }) =>
    importReference(fromBase64(data_base64), String(filename ?? 'reference.wav'), from_seconds === undefined ? undefined : Number(from_seconds), to_seconds === undefined ? undefined : Number(to_seconds)),

  compare_to_reference: ({ from_bar, to_bar, section_id }) => compareToReference({ from_bar, to_bar, section_id }),

  clear_reference: () => clearReference(),

  // ---------- recording ----------

  arm_track: ({ track_id, input_channel, armed }) => {
    const t = requireTrack(st().project, track_id);
    const a = armTrack(t.id, armed === false ? null : Number(input_channel ?? 1) - 1);
    const tracks = st().project.tracks;
    return { armed: Object.entries(a).map(([id, ch]) => ({ track_id: id, name: tracks.find((x) => x.id === id)?.name, input_channel: ch + 1 })) };
  },

  set_punch: ({ enabled, in_bar, out_bar, pre_roll_bars }) => {
    const cur = useRecSetup.getState().punch;
    const p = setPunch({
      enabled: enabled ?? (in_bar !== undefined || out_bar !== undefined ? true : cur.enabled),
      ...(in_bar !== undefined ? { inBeat: barToBeat(Number(in_bar)) } : {}),
      ...(out_bar !== undefined ? { outBeat: barToBeat(Number(out_bar)) } : {}),
      ...(pre_roll_bars !== undefined ? { preRollBars: clamp(Math.round(Number(pre_roll_bars)), 0, 8) } : {}),
    });
    return { enabled: p.enabled, in_bar: beatToBar(p.inBeat), out_bar: beatToBar(p.outBeat), pre_roll_bars: p.preRollBars, note: 'record_audio now records only between the punch points, after the pre-roll, as a new take of the clip there (5 ms crossfades).' };
  },

  record_audio: async ({ track_id, start_bar, bars, mode, use_setup }) => {
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
    const r = await recordFromMic({ mode: m, trackId: track_id, startBeat: (startBar - 1) * BEATS_PER_BAR, bars: n, useSetup: use_setup !== false });
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
    // In the desktop app the plugins installed on the computer come first when they fit (G8.9).
    matches: (await searchAllPlugins(String(description), kind)).map(({ native: _n, ...p }) => p),
  }),

  // Ghost notes (G3): local, instant suggestions — no LLM, nothing leaves the computer.
  suggest_continuation: ({ region_id, kind, count, seed, note_ids }) => {
    const r = requireRegion(st().project, String(region_id));
    const { kind: used, suggestions } = suggest(st().project, r.id, { kind, count, seed, noteIds: note_ids });
    return {
      region_id: r.id,
      kind: used,
      suggestions: suggestions.map((s, i) => ({ index: i + 1, score: s.score, why: s.reasons, ...(s.chords ? { chords: s.chords } : {}), ...(s.newTrack ? { for: 'a new harmony track' } : {}), notes: s.notes })),
      note: suggestions.length ? 'Notes are in beats from the region start. Add the one you like with add_notes (harmonize: on a new track).' : 'Nothing to suggest here: write a few notes first, or pick another kind.',
    };
  },

  list_native_plugins: async ({ kind, query }) => {
    const { plugins, failed, available } = await nativePlugins();
    if (!available) return { available: false, plugins: [], note: 'Native plugins (VST3, CLAP, AU) are available in the OpenBand desktop app only.' };
    const list = query ? rankNativePlugins(plugins, String(query), kind) : plugins.filter((p) => !kind || p.kind === kind);
    return { available: true, plugins: list.map((p) => ({ id: nativeRef(p), name: p.name, vendor: p.vendor, version: p.version, format: p.format, kind: p.kind, features: p.features })), ignored: failed.length };
  },

  rescan_plugins: async () => {
    const { plugins, failed, available } = await nativePlugins({ rescan: true });
    if (!available) return { available: false, plugins: 0, note: 'Native plugins (VST3, CLAP, AU) are available in the OpenBand desktop app only.' };
    return { available: true, plugins: plugins.length, ignored: failed.map((f) => ({ path: f.path, reason: f.reason })) };
  },

  add_plugin: async ({ description, plugin, track_id, kind, format }) => {
    let ref = plugin as string | undefined;
    let alternatives: { id: string; name: string; kind: string; format: string }[] = [];
    const target = track_id ? requireTrack(st().project, track_id) : getTrack(st().project, st().selectedTrackId);
    let native = ref && format !== 'wam' ? await findNativePlugin(ref, format) : null;
    if (!ref) {
      const found = (await searchAllPlugins(String(description ?? ''), kind)).filter((p) => !format || p.format === format);
      if (!found.length) throw new Error(`No plugin matches "${description}". Call list_plugins (or list_native_plugins) to see them.`);
      native = found[0].native ?? null;
      ref = found[0].id;
      alternatives = found.slice(1, 4).map((p) => ({ id: p.id, name: p.name, kind: p.kind, format: p.format }));
    }
    if (native) {
      const more = alternatives.length ? { alternatives } : {};
      if (native.kind === 'instrument') return { added_as: 'instrument', ...addNativeInstrument(native, target?.kind === 'instrument' && track_id ? target.id : undefined), ...more };
      if (!target) throw new Error('Effects need a track: pass track_id');
      return { added_as: 'effect', ...addNativeEffect(target.id, native), ...more };
    }
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

  add_plugin_instrument: async ({ plugin, track_id, format }) => {
    const id = track_id ? requireTrack(st().project, track_id).id : undefined;
    const native = format !== 'wam' ? await findNativePlugin(String(plugin), format) : null;
    return native ? addNativeInstrument(native, id) : addPluginInstrument(String(plugin), id);
  },

  add_plugin_effect: async ({ track_id, plugin, format }) => {
    const id = requireTrack(st().project, track_id).id;
    const native = format !== 'wam' ? await findNativePlugin(String(plugin), format) : null;
    return native ? addNativeEffect(id, native) : addPluginEffect(id, String(plugin));
  },

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

  // ---- DAWproject (F17)
  import_dawproject: ({ data_base64, filename, replace }) => importDawproject(new Uint8Array(fromBase64(data_base64)), String(filename ?? 'song.dawproject'), replace !== false, isAiCommand() ? 'ai' : 'user'),

  /** UI only: a .dawproject dropped, picked or opened from the OS. */
  import_dawproject_file: async ({ file, replace }) => {
    const f = file as File;
    const r = await importDawproject(new Uint8Array(await f.arrayBuffer()), f.name, replace !== false, 'user', true);
    st().notify(tr('dp.imported', { n: r.tracks.length }));
    return r;
  },

  export_dawproject: ({ return_data }) => exportDawproject(!!return_data),

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
  'get_context', 'get_project', 'get_status', 'list_instruments', 'get_region_notes', 'export_project_json', 'export_wav', 'export_midi', 'export_dawproject', 'export_for_platforms',
  'list_samples', 'list_plugins', 'search_plugins', 'list_native_plugins', 'rescan_plugins', 'suggest_continuation', 'get_plugin_params', 'show_plugin', 'open_editor', 'get_history',
  'analyze_mix', 'detect_key', 'render_spectrogram', 'lint_project', 'get_structure', 'auto_sections', 'get_energy', 'analyze_harmony',
  'list_engines', 'get_ledger', 'set_engine_policy',
  'get_lyrics', 'check_prosody', 'suggest_melody_rhythm', 'export_chord_sheet', 'compare_to_reference', 'list_takes', 'list_flubs', 'list_automatable', 'search_loops', 'arm_track', 'set_punch', 'get_meters', 'set_monitoring', 'get_timeline', 'preview_at', 'start_ab_test', 'get_peers', 'create_room', 'join_room', 'leave_room', 'play_phrase', 'set_jam_mode', 'list_annotations', 'list_versions', 'diff_versions', 'save_version', 'create_branch',
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
    // A big AI request (over 20 commands): keep the song as it was before it, as a version.
    const open = st().activeTransaction;
    if (open?.source === 'ai' && open.commands === 21) void autoVersion(open.label, open.snapshot, 'ai');
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
