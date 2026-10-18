// Importing sounds from outside: sampler instruments, drum kits, SoundFont presets, audio clips,
// and self-contained project bundles (.openband = zip of project.json + samples).
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { CustomInstrument, Project, Region, SampleZone } from './types';
import { BEATS_PER_BAR, DRUM_PIECES, uid } from './music';
import { getTrack, makeTrack, projectSampleIds, useStore } from './store';
import { detectPitch, encodeMonoWav, ensureSamples, getStoredSample, importSample, pitchFromName, type SampleInfo } from './audio/samples';
import { SoundFont } from './audio/soundfont';
import { download } from './audio/render';

const st = () => useStore.getState();

export interface InputFile {
  name: string;
  data: ArrayBuffer;
  type?: string;
}

export const readFiles = (files: FileList | File[]) =>
  Promise.all([...files].map(async (f): Promise<InputFile> => ({ name: f.name, data: await f.arrayBuffer(), type: f.type })));

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

function addInstrument(inst: CustomInstrument) {
  st().commit((d) => void (d.instruments = [...(d.instruments ?? []), inst]));
  return inst;
}

// ---------- sampler ----------

/** Spread samples over the keyboard: each owns the keys closest to its root note. */
export function spreadZones(samples: { sampleId: string; root: number }[]): SampleZone[] {
  const sorted = [...samples].sort((a, b) => a.root - b.root);
  return sorted.map((s, i) => ({
    sampleId: s.sampleId,
    root: s.root,
    lo: i === 0 ? 0 : Math.floor((sorted[i - 1].root + s.root) / 2) + 1,
    hi: i === sorted.length - 1 ? 127 : Math.floor((s.root + sorted[i + 1].root) / 2),
  }));
}

export function rootFor(info: SampleInfo) {
  return pitchFromName(info.name) ?? detectPitch(info.id) ?? 60;
}

const DRUM_WORDS: [RegExp, number][] = [
  [/open.?h|oh\b|o.?hat/i, 46],
  [/kick|bd\b|bass.?drum|cassa/i, 36],
  [/snare|sd\b|rullante/i, 38],
  [/clap|cp\b/i, 39],
  [/rim|stick/i, 37],
  [/hat|hh\b|hihat/i, 42],
  [/crash|cymbal/i, 49],
  [/ride/i, 51],
  [/hi.?tom|tom.?1|high.?tom|tom.?h/i, 50],
  [/mid.?tom|tom.?2|tom.?m/i, 48],
  [/lo.?tom|tom.?3|floor|low.?tom|tom.?l|tom/i, 45],
];

/** Assign drum samples to kit pieces by file name; the rest fill the remaining pads in order. */
export function guessDrumPads(infos: SampleInfo[]): SampleZone[] {
  const taken = new Map<number, string>();
  const rest: SampleInfo[] = [];
  for (const info of infos) {
    const hit = DRUM_WORDS.find(([re, pitch]) => re.test(info.name) && !taken.has(pitch));
    if (hit) taken.set(hit[1], info.id);
    else rest.push(info);
  }
  const free = [36, 38, 42, 46, 39, 37, 45, 48, 50, 49, 51].filter((p) => !taken.has(p));
  rest.forEach((info, i) => i < free.length && taken.set(free[i], info.id));
  return [...taken].map(([pitch, sampleId]) => ({ sampleId, root: pitch, lo: pitch, hi: pitch }));
}

export async function createSamplerFromFiles(files: InputFile[], kind: 'instrument' | 'drums', name?: string) {
  if (!files.length) throw new Error('No files');
  const infos = [];
  for (const f of files) infos.push(await importSample(f.data, f.name, f.type));
  const zones = kind === 'drums' ? guessDrumPads(infos) : spreadZones(infos.map((i) => ({ sampleId: i.id, root: rootFor(i) })));
  return addInstrument({
    id: uid('usr'),
    name: name ?? (files.length === 1 ? baseName(files[0].name) : kind === 'drums' ? 'Custom Kit' : 'Sampler'),
    kind,
    source: 'sampler',
    zones,
    attack: 0.003,
    release: kind === 'drums' ? 0.08 : 0.35,
  });
}

// ---------- SoundFont ----------

export function openSoundFont(data: ArrayBuffer) {
  return new SoundFont(data);
}

export async function instrumentFromSoundFont(sf: SoundFont, presetIndex: number) {
  const info = sf.presets.find((p) => p.index === presetIndex);
  if (!info) throw new Error(`Preset ${presetIndex} not found in the SoundFont`);
  const { zones, samples } = sf.buildPreset(presetIndex);
  if (!zones.length) throw new Error(`Preset “${info.name}” has no playable samples`);
  const ids: string[] = [];
  for (const s of samples) {
    const stored = await importSample(encodeMonoWav(s.pcm, s.sampleRate), `${s.name}.wav`);
    ids.push(stored.id);
  }
  // Use the most common envelope of the preset for the whole instrument.
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  return addInstrument({
    id: uid('usr'),
    name: info.name,
    kind: sf.isDrumPreset(info) ? 'drums' : 'instrument',
    source: 'soundfont',
    attack: median(zones.map((z) => z.attack)),
    release: Math.max(0.03, median(zones.map((z) => z.release))),
    zones: zones.map((z) => {
      const rate = samples[z.sampleIndex].sampleRate;
      return {
        sampleId: ids[z.sampleIndex],
        root: z.root,
        lo: z.lo,
        hi: z.hi,
        tune: z.tune,
        // SoundFont samples are mostly full-scale: −6 dB keeps them level with the built-in sounds.
        gain: +(z.gain * 0.5).toFixed(4),
        ...(z.loopStart !== undefined ? { loopStart: z.loopStart / rate, loopEnd: z.loopEnd! / rate } : {}),
      };
    }),
  });
}

// ---------- audio clips ----------

/** Put a sample on the timeline. Creates an audio track when none is given. */
export function addAudioRegion(info: SampleInfo, opts: { trackId?: string; startBeat?: number; name?: string; offset?: number; lengthBeats?: number; gain?: number } = {}) {
  const s = st();
  let trackId = opts.trackId;
  const existing = trackId ? getTrack(s.project, trackId) : undefined;
  if (trackId && existing?.kind !== 'audio') throw new Error('Audio regions need an audio track');
  if (!trackId) {
    const track = makeTrack(s.project, 'audio', undefined, baseName(info.name));
    s.commit((d) => void d.tracks.push(track));
    trackId = track.id;
  }
  const offset = Math.max(0, Math.min(opts.offset ?? 0, info.duration));
  const bpm = st().project.bpm;
  const region: Region = {
    id: uid('rgn'),
    trackId,
    name: opts.name ?? baseName(info.name),
    start: Math.max(0, opts.startBeat ?? 0),
    length: opts.lengthBeats ?? Math.max(0.25, ((info.duration - offset) * bpm) / 60),
    notes: [],
    audio: { sampleId: info.id, offset, gain: opts.gain ?? 1 },
  };
  st().commit((d) => void d.regions.push(region));
  st().selectRegion(region);
  return region;
}

export async function importAudioFiles(files: InputFile[], opts: { trackId?: string; startBeat?: number } = {}) {
  const regions: Region[] = [];
  let at = opts.startBeat ?? 0;
  for (const f of files) {
    const info = await importSample(f.data, f.name, f.type);
    const r = addAudioRegion(info, { trackId: opts.trackId, startBeat: at });
    // Several files on one track go one after the other.
    if (opts.trackId) at = r.start + Math.ceil(r.length / BEATS_PER_BAR) * BEATS_PER_BAR;
    regions.push(r);
  }
  return regions;
}

// ---------- project bundles ----------

export const hasSamples = (p: Project) => projectSampleIds(p).length > 0;

/** Save as plain JSON, or as a .openband zip when the project uses imported sounds. */
export async function saveProject(p: Project) {
  const safe = p.name.replace(/[^\w\- ]+/g, '').trim() || 'openband';
  if (!hasSamples(p)) {
    download(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }), `${safe}.openband.json`);
    return;
  }
  const ids = [...new Set(projectSampleIds(p))];
  await ensureSamples(ids);
  const files: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify(p, null, 2)) };
  const manifest: Record<string, { name: string; type: string }> = {};
  for (const id of ids) {
    const s = getStoredSample(id);
    if (!s) continue;
    manifest[id] = { name: s.name, type: s.type };
    files[`samples/${id}`] = new Uint8Array(s.data);
  }
  files['samples.json'] = strToU8(JSON.stringify(manifest, null, 2));
  const zip = zipSync(files, { level: 0 });
  download(new Blob([zip], { type: 'application/zip' }), `${safe}.openband`);
}

/** Parse a project file (.json or .openband bundle), restoring bundled samples first. */
export async function readProjectFile(data: ArrayBuffer): Promise<Project> {
  const bytes = new Uint8Array(data);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes);
    if (!files['project.json']) throw new Error('Invalid OpenBand bundle: project.json missing');
    const manifest = files['samples.json'] ? (JSON.parse(strFromU8(files['samples.json'])) as Record<string, { name: string; type: string }>) : {};
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith('samples/') || !content.length) continue;
      const id = path.slice(8);
      const ab = content.slice().buffer;
      await importSample(ab, manifest[id]?.name ?? id, manifest[id]?.type);
    }
    return JSON.parse(strFromU8(files['project.json']));
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ---------- drum pad helpers for the UI ----------

export const DRUM_PADS = DRUM_PIECES.map((d) => d.pitch);

export function setZones(instrumentId: string, zones: SampleZone[]) {
  st().commit((d) => {
    const inst = d.instruments?.find((i) => i.id === instrumentId);
    if (inst) inst.zones = zones;
  });
}
