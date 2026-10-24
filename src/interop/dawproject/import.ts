// DAWproject 1.0 → OpenBand. Tracks (folders flattened), mixer channels, note and audio clips (nested
// clips, loops, playStart, seconds or beats), markers → sections, volume/pan automation, built-in EQ and
// compressor → OpenBand's; everything else goes into the report. An archive made by OpenBand and not
// changed since is restored exactly from its openband.json.
import { strFromU8, unzipSync } from 'fflate';
import type { AutoPoint, CustomInstrument, Note, PluginSlot, Project, Region, Section, Track, TrackFx } from '../../types';
import type { NativePluginInfo } from '../../audio/native';
import { vstPresetToState } from './vstpreset';
import { emptyProject, makeTrack } from '../../store';
import { PRESETS } from '../../audio/instruments';
import { defaultFx } from '../../audio/fx';
import { migrate } from '../../migrations';
import { BEATS_PER_BAR, uid } from '../../music';
import { attr, bool, kid, kids, num, parseXml } from './xml';
import { mix, setPoints } from '../../automation';
import { emptyReport, type ImportReport } from './report';
import { OPENBAND_JSON, xmlHash } from './export';

export interface ImportedSample {
  /** Placeholder id used in the project's audio regions (replaced once the sample is stored). */
  ref: string;
  name: string;
  data: Uint8Array;
}

export interface DawprojectImport {
  project: Project;
  samples: ImportedSample[];
  report: ImportReport;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A volume parameter (linear 0..2, decibel or normalized) → OpenBand fader (0.8 = 0 dB). */
function volumeToFader(el: Element | null, fallback = 0.8): number {
  if (!el) return fallback;
  const v = num(el, 'value');
  if (!Number.isFinite(v)) return fallback;
  const unit = attr(el, 'unit');
  const gain = unit === 'decibel' ? Math.pow(10, v / 20) : unit === 'normalized' ? v / 0.8 : v;
  return clamp(+(gain * 0.8).toFixed(4), 0, 1);
}
const valueToFader = (v: number, unit: string | null) => clamp(+((unit === 'decibel' ? Math.pow(10, v / 20) : v) * 0.8).toFixed(4), 0, 1);
/** A send level (linear or decibel) → 0..1. */
function sendLevel(el: Element | null): number {
  const v = num(el, 'value', 0);
  return clamp(attr(el, 'unit') === 'decibel' ? Math.pow(10, v / 20) : v, 0, 1);
}
/** Pan: normalized 0..1 (0.5 = centre) or −1..1 → OpenBand −1..1. */
function panOf(el: Element | null): number {
  if (!el) return 0;
  const v = num(el, 'value', 0.5);
  const min = num(el, 'min', 0);
  return clamp(+(min < 0 ? v : v * 2 - 1).toFixed(4), -1, 1);
}

const DRUMS = /drum|kit|beat|perc|808|909|snare|kick|hats?\b|batteria/i;
const KEYWORDS: [RegExp, string][] = [
  [/rhodes|e\.?\s?piano|wurli|electric piano|epiano/i, 'velvet-keys'],
  [/piano|grand|keys/i, 'felt-piano'],
  [/organ|hammond|b3/i, 'retro-organ'],
  [/bell|celesta|glock|music ?box/i, 'crystal-bells'],
  [/acid|303/i, 'acid-bass'],
  [/finger|electric bass|e\.? ?bass/i, 'finger-bass'],
  [/bass|sub/i, 'sub-bass'],
  [/string|violin|cello|orchestra/i, 'silk-strings'],
  [/pad|ambient|choir|atmo/i, 'aurora-pad'],
  [/pluck|harp|guitar|kalimba/i, 'pluck'],
  [/chip|8.?bit|nes|gameboy/i, 'chip'],
  [/lead|synth|saw|surge|serum|vital|diva/i, 'neon-lead'],
];
/** The closest built-in preset for an instrument plugin or a track name. */
export function presetFor(text: string, drums: boolean): string {
  if (drums) return /808|trap/i.test(text) ? 'kit-808' : /lo.?fi|dusty/i.test(text) ? 'kit-lofi' : 'kit-studio';
  return KEYWORDS.find(([re]) => re.test(text))?.[1] ?? 'felt-piano';
}

const DEVICE_TAGS = ['Vst2Plugin', 'Vst3Plugin', 'ClapPlugin', 'AuPlugin', 'BuiltinDevice', 'Equalizer', 'Compressor', 'NoiseGate', 'Limiter', 'Device'];
const FORMAT: Record<string, string> = { Vst2Plugin: 'VST2', Vst3Plugin: 'VST3', ClapPlugin: 'CLAP', AuPlugin: 'AU', BuiltinDevice: 'built-in', Equalizer: 'built-in EQ', Compressor: 'built-in compressor', NoiseGate: 'built-in gate', Limiter: 'built-in limiter', Device: 'device' };

interface TrackInfo {
  el: Element;
  channel: Element | null;
  name: string;
  path: string[];
}

const NATIVE_FORMAT: Record<string, 'vst3' | 'clap' | 'au'> = { Vst3Plugin: 'vst3', ClapPlugin: 'clap', AuPlugin: 'au' };

const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * A VST3 / CLAP / AU device of the file that is installed on this computer (G8.9), with its state from
 * the archive: a CLAP preset is the plugin's own state, a .vstpreset becomes the component and controller
 * state, an AU preset is a property list the plugin reads as it is.
 */
function installedDevice(d: Element, files: Record<string, Uint8Array>, installed: NativePluginInfo[]) {
  const format = NATIVE_FORMAT[d.tagName];
  const id = attr(d, 'deviceID');
  if (!format || !id) return null;
  const info = installed.find((p) => p.format === format && (format === 'vst3' ? p.id.toLowerCase() === id.toLowerCase() : p.id === id));
  if (!info) return null;
  const file = files[attr(kid(d, 'State'), 'path') ?? ''];
  const state = file ? (format === 'vst3' ? (vstPresetToState(file)?.state ?? null) : file) : null;
  return { info, native: { id: info.id, vendor: info.vendor, version: info.version, path_hint: info.path, ...(state ? { state_b64: b64(state) } : {}) }, stateMissing: !state };
}

/** installed: the native plugins of this computer (desktop app) — devices of the file found there load with their state. */
export function dawprojectToProject(zip: Uint8Array, installed: NativePluginInfo[] = []): DawprojectImport {
  const files = unzipSync(zip);
  const xmlBytes = files['project.xml'];
  if (!xmlBytes) throw new Error('Not a DAWproject file: project.xml is missing');
  const xml = strFromU8(xmlBytes);
  const report = emptyReport();

  // Made by OpenBand and unchanged since: exact restore.
  const obBytes = files[OPENBAND_JSON];
  let ob: { projectXml?: string; project?: unknown } | null = null;
  if (obBytes) {
    try {
      ob = JSON.parse(strFromU8(obBytes));
    } catch {
      ob = null;
    }
  }
  if (ob?.project && ob.projectXml === xmlHash(xml)) {
    const project = migrate(ob.project);
    const samples = sampleFiles(files, project);
    report.application = 'OpenBand';
    report.lossless = true;
    return { project, samples, report };
  }

  const root = parseXml(xml);
  if (root.tagName !== 'Project') throw new Error('Not a DAWproject file: the root element is not <Project>');
  report.application = [attr(kid(root, 'Application'), 'name'), attr(kid(root, 'Application'), 'version')].filter(Boolean).join(' ') || null;
  const title = (() => {
    const meta = files['metadata.xml'];
    if (!meta) return null;
    try {
      return kid(parseXml(strFromU8(meta)), 'Title')?.textContent?.trim() || null;
    } catch {
      return null;
    }
  })();

  // ---- transport
  const transport = kid(root, 'Transport');
  const bpm = clamp(Math.round(num(kid(transport, 'Tempo'), 'value', 120) * 100) / 100, 40, 240);
  const ts = kid(transport, 'TimeSignature');
  const meter = `${num(ts, 'numerator', 4)}/${num(ts, 'denominator', 4)}`;
  if (meter !== '4/4') report.items.push({ code: 'meter', detail: meter });
  const spb = 60 / bpm;

  const p = emptyProject(title ?? 'DAWproject import', bpm);
  p.tracks = [];
  p.regions = [];

  // ---- structure: every track with a regular channel; folders flattened; master and returns apart
  const byId = new Map<string, Element>();
  const index = (el: Element) => {
    const id = attr(el, 'id');
    if (id) byId.set(id, el);
    for (const c of kids(el)) index(c);
  };
  index(root);
  const structure = kid(root, 'Structure');
  const infos: TrackInfo[] = [];
  const returns = new Map<string, string>(); // channel id → name
  let masterChannel: Element | null = null;
  const walk = (el: Element, path: string[]) => {
    if (el.tagName === 'Channel') {
      if (attr(el, 'role') === 'master') masterChannel = el;
      return;
    }
    if (el.tagName !== 'Track') return;
    const ch = kid(el, 'Channel');
    const name = attr(el, 'name') ?? 'Track';
    const role = attr(ch, 'role');
    const children = kids(el, 'Track');
    if (role === 'master') masterChannel = ch;
    else if (role === 'effect') returns.set(attr(ch, 'id') ?? '', name);
    else if (children.length) {
      report.items.push({ code: 'group', detail: name });
      if (ch && kids(kid(ch, 'Devices')).length) report.items.push({ code: 'plugin', track: name, detail: kids(kid(ch, 'Devices')).map((d) => attr(d, 'deviceName') ?? d.tagName).join(', ') });
    } else infos.push({ el, channel: ch, name, path });
    for (const c of children) walk(c, [...path, name]);
  };
  for (const el of kids(structure)) walk(el, []);
  if (masterChannel) p.masterVolume = volumeToFader(kid(masterChannel, 'Volume'));

  // Parameter id → (track, which) for automation targets.
  const params = new Map<string, { trackId: string; param: 'volume' | 'pan' | 'mute' | 'other'; unit: string | null; name: string }>();
  const trackIdOf = new Map<string, string>(); // XML track id → OpenBand id

  for (const info of infos) {
    const ch = info.channel;
    const devices = kids(kid(ch, 'Devices')).filter((d) => DEVICE_TAGS.includes(d.tagName));
    const instrument = devices.find((d) => attr(d, 'deviceRole') === 'instrument');
    const content = (attr(info.el, 'contentType') ?? '').split(/\s+/);
    const isAudio = content.includes('audio') && !content.includes('notes');
    const instText = `${info.name} ${attr(instrument, 'deviceName') ?? ''} ${attr(instrument, 'name') ?? ''}`;
    const drums = !isAudio && DRUMS.test(instText);
    const kind = isAudio ? 'audio' : drums ? 'drums' : 'instrument';
    const preset = kind === 'audio' ? undefined : presetFor(instText, drums);
    const t: Track = makeTrack(p, kind, preset, info.name);
    const color = attr(info.el, 'color');
    if (color && /^#[0-9a-f]{6}$/i.test(color)) t.color = color;
    t.volume = volumeToFader(kid(ch, 'Volume'));
    t.pan = panOf(kid(ch, 'Pan'));
    t.mute = bool(kid(ch, 'Mute'), 'value') ?? false;
    t.solo = bool(ch, 'solo') ?? false;
    const nativeInst = instrument && kind !== 'audio' ? installedDevice(instrument, files, installed) : null;
    if (nativeInst) {
      const inst: CustomInstrument = { id: uid('nat'), name: nativeInst.info.name, kind: 'instrument', source: 'native', zones: [], attack: 0, release: 0, format: nativeInst.info.format, native: nativeInst.native };
      p.instruments = [...(p.instruments ?? []), inst];
      t.kind = 'instrument';
      t.instrument = inst.id;
      if (nativeInst.stateMissing) report.items.push({ code: 'plugin_state', track: info.name, detail: `${nativeInst.info.name}: loaded without its settings (not in the file)` });
    }
    // OpenBand-made instruments are built-in devices with an OpenBand vendor: no report for them.
    else if (instrument && attr(instrument, 'deviceVendor') !== 'OpenBand') {
      report.items.push({ code: 'instrument_replaced', track: info.name, detail: `${attr(instrument, 'deviceName')} (${FORMAT[instrument.tagName] ?? instrument.tagName}) → ${PRESETS.find((x) => x.id === preset)?.name ?? preset}` });
    }
    // Sends: the biggest one to a return track becomes the reverb send, a second one the echo.
    const sends = kids(kid(ch, 'Sends'), 'Send')
      .map((s) => ({ to: attr(s, 'destination') ?? '', level: sendLevel(kid(s, 'Volume')), name: returns.get(attr(s, 'destination') ?? '') ?? attr(s, 'name') ?? 'send' }))
      .sort((a, b) => b.level - a.level);
    t.reverb = sends[0] ? +sends[0].level.toFixed(3) : 0;
    t.delay = sends[1] ? +sends[1].level.toFixed(3) : 0;
    const isOurs = sends.every((s) => /reverb|echo|delay/i.test(s.name));
    if (sends.length && !isOurs) report.items.push({ code: 'send', track: info.name, detail: `${sends.map((s) => s.name).join(', ')} → ${sends.length > 1 ? 'reverb and echo' : 'reverb'}` });
    if (sends.length > 2) report.items.push({ code: 'send', track: info.name, detail: `${sends.length - 2} more send(s) dropped` });
    // Built-in EQ and compressor → OpenBand's; any other device is reported.
    const fx: TrackFx = defaultFx();
    let fxUsed = false;
    for (const d of devices) {
      if (d === instrument) continue;
      if (d.tagName === 'Equalizer') {
        const bands = kids(d, 'Band');
        const gainOf = (b: Element) => num(kid(b, 'Gain'), 'value', 0);
        const low = bands.find((b) => attr(b, 'type') === 'lowShelf');
        const high = bands.find((b) => attr(b, 'type') === 'highShelf');
        const bell = bands.find((b) => attr(b, 'type') === 'bell');
        fx.eq = { on: bool(kid(d, 'Enabled'), 'value') ?? true, low: clamp(low ? gainOf(low) : 0, -15, 15), mid: clamp(bell ? gainOf(bell) : 0, -15, 15), high: clamp(high ? gainOf(high) : 0, -15, 15), midFreq: clamp(bell ? num(kid(bell, 'Freq'), 'value', 1000) : 1000, 200, 6000) };
        fxUsed = true;
        const other = bands.filter((b) => b !== low && b !== high && b !== bell);
        if (other.length) report.items.push({ code: 'plugin', track: info.name, detail: `EQ bands not imported: ${other.map((b) => attr(b, 'type')).join(', ')}` });
        continue;
      }
      if (d.tagName === 'Compressor') {
        const v = (tag: string, dflt: number) => num(kid(d, tag), 'value', dflt);
        fx.comp = { on: bool(kid(d, 'Enabled'), 'value') ?? true, threshold: clamp(v('Threshold', -18), -60, 0), ratio: clamp(v('Ratio', 4), 1, 20), attack: clamp(v('Attack', 0.01), 0.001, 1), release: clamp(v('Release', 0.18), 0.01, 2), makeup: clamp(v('OutputGain', 0), 0, 24) };
        fxUsed = true;
        continue;
      }
      if (attr(d, 'deviceVendor') === 'OpenBand') continue;
      const nat = installedDevice(d, files, installed);
      if (nat) {
        const slot: PluginSlot = { id: uid('fx'), url: '', name: nat.info.name, on: bool(kid(d, 'Enabled'), 'value') ?? true, format: nat.info.format, native: nat.native };
        fx.plugins = [...(fx.plugins ?? []), slot];
        fxUsed = true;
        if (nat.stateMissing) report.items.push({ code: 'plugin_state', track: info.name, detail: `${nat.info.name}: loaded without its settings (not in the file)` });
        continue;
      }
      report.items.push({ code: 'plugin', track: info.name, detail: `${attr(d, 'deviceName') ?? attr(d, 'name') ?? d.tagName} (${FORMAT[d.tagName] ?? d.tagName})` });
    }
    if (fxUsed) t.fx = fx;
    p.tracks.push(t);
    const xmlId = attr(info.el, 'id');
    if (xmlId) trackIdOf.set(xmlId, t.id);
    const chId = attr(ch, 'id');
    if (chId) trackIdOf.set(chId, t.id);
    for (const [tag, param] of [['Volume', 'volume'], ['Pan', 'pan'], ['Mute', 'mute']] as const) {
      const el = kid(ch, tag);
      const id = attr(el, 'id');
      if (id) params.set(id, { trackId: t.id, param, unit: attr(el, 'unit'), name: tag });
    }
    for (const d of devices) for (const prm of kids(kid(d, 'Parameters'))) {
      const id = attr(prm, 'id');
      if (id) params.set(id, { trackId: t.id, param: 'other', unit: attr(prm, 'unit'), name: `${attr(d, 'deviceName') ?? d.tagName} · ${attr(prm, 'name') ?? id}` });
    }
  }

  // ---- arrangement
  const samples: ImportedSample[] = [];
  const sampleRefs = new Map<string, string>();
  const arrangement = kid(root, 'Arrangement');
  const trackOfName = (id: string | null) => (id ? p.tracks.find((t) => t.id === trackIdOf.get(id)) : undefined);

  /** Notes in a clip's content time, cut to [playStart, playStart+duration), looped when the clip is longer than its loop. */
  const notesOf = (notesEl: Element, unitToBeats: (v: number) => number, playStart: number, duration: number, loop: { start: number; end: number } | null): Note[] => {
    const raw = kids(notesEl, 'Note').map((n) => ({ t: unitToBeats(num(n, 'time', 0)), d: unitToBeats(num(n, 'duration', 0.25)), key: num(n, 'key', 60), vel: num(n, 'vel', 0.8) }));
    const out: Note[] = [];
    const push = (start: number, n: (typeof raw)[number]) => {
      if (start < -1e-9 || start >= duration - 1e-9) return;
      out.push({ id: uid('n'), pitch: clamp(Math.round(n.key), 0, 127), start: +start.toFixed(4), duration: +Math.max(0.0625, Math.min(n.d, duration - start)).toFixed(4), velocity: clamp(+n.vel.toFixed(3), 0.01, 1) });
    };
    if (loop && loop.end > loop.start) {
      const len = loop.end - loop.start;
      // Play from playStart; at loop end, jump back to loop start.
      let pos = 0;
      let from = playStart;
      while (pos < duration - 1e-9) {
        const to = from < loop.end ? loop.end : from + len;
        for (const n of raw) if (n.t >= from - 1e-9 && n.t < to - 1e-9) push(pos + n.t - from, n);
        pos += to - from;
        from = loop.start;
      }
    } else for (const n of raw) push(n.t - playStart, n);
    return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  };

  /** One clip (possibly with nested clips) on a track; `offset` is where its timeline starts, in beats. */
  const clipToRegions = (clip: Element, track: Track, timeToBeats: (v: number) => number, offset: number) => {
    const start = offset + timeToBeats(num(clip, 'time', 0));
    const duration = timeToBeats(num(clip, 'duration', 4));
    const contentUnit = attr(clip, 'contentTimeUnit');
    const contentToBeats = contentUnit === 'seconds' ? (v: number) => v / spb : contentUnit === 'beats' ? (v: number) => v : timeToBeats;
    const playStart = contentToBeats(num(clip, 'playStart', 0));
    const loopStart = num(clip, 'loopStart');
    const loopEnd = num(clip, 'loopEnd');
    const loop = Number.isFinite(loopStart) && Number.isFinite(loopEnd) ? { start: contentToBeats(loopStart), end: contentToBeats(loopEnd) } : null;
    const name = attr(clip, 'name') ?? track.name;
    if ((num(clip, 'fadeInTime', 0) || num(clip, 'fadeOutTime', 0)) > 0) report.items.push({ code: 'fade', track: track.name, detail: name });
    const notesEl = kid(clip, 'Notes');
    if (notesEl) {
      const r: Region = { id: uid('rgn'), trackId: track.id, name, start: +start.toFixed(4), length: +Math.max(0.25, duration).toFixed(4), notes: notesOf(notesEl, contentToBeats, playStart, duration, loop && loop.end - loop.start < duration ? loop : null) };
      if (track.kind === 'audio') return report.items.push({ code: 'automation', track: track.name, detail: 'notes on an audio track skipped' });
      p.regions.push(r);
      return;
    }
    const nested = kid(clip, 'Clips');
    if (nested) {
      // An inner timeline (Bitwig audio clips): its times are relative to the clip's content start.
      for (const c of kids(nested, 'Clip')) clipToRegions(c, track, contentToBeats, start - playStart);
      return;
    }
    const warps = kid(clip, 'Warps');
    const audio = kid(warps ?? clip, 'Audio');
    if (audio) {
      if (track.kind !== 'audio') return report.items.push({ code: 'automation', track: track.name, detail: 'audio on a note track skipped' });
      const path = attr(kid(audio, 'File'), 'path') ?? '';
      const data = files[path] ?? files[path.replace(/^\.?\//, '')];
      if (!data) return report.items.push({ code: 'audio_missing', track: track.name, detail: path || name });
      let ref = sampleRefs.get(path);
      if (!ref) {
        ref = `dawp:${samples.length}`;
        sampleRefs.set(path, ref);
        samples.push({ ref, name: path.split('/').pop() || 'audio.wav', data });
      }
      // Offset into the file (seconds): from the warp map at playStart, or playStart itself.
      let offsetSec = contentUnit === 'seconds' ? num(clip, 'playStart', 0) : playStart * spb;
      let stretch: { mode: 'fixed'; ratio: number } | undefined;
      if (warps) {
        const w = kids(warps, 'Warp').map((e) => ({ t: num(e, 'time', 0), c: num(e, 'contentTime', 0) }));
        const wUnit = attr(warps, 'contentTimeUnit');
        const wTime = attr(warps, 'timeUnit');
        const toSec = (v: number) => (wUnit === 'beats' ? v * spb : v);
        const tToBeats = (v: number) => (wTime === 'seconds' ? v / spb : v);
        if (w.length >= 2) {
          const [a, b] = [w[0], w[w.length - 1]];
          const ratio = (toSec(b.c) - toSec(a.c)) / ((tToBeats(b.t) - tToBeats(a.t)) * spb);
          // A warp map → OpenBand's time-stretch (F23): played length / original = 1 / ratio.
          if (Math.abs(ratio - 1) > 0.001) stretch = { mode: 'fixed', ratio: +(1 / ratio).toFixed(5) };
          if (w.length > 2) report.items.push({ code: 'warp', track: track.name, detail: `${name}: ${w.length} warp markers simplified to one ratio (×${(1 / ratio).toFixed(2)})` });
          offsetSec = toSec(a.c) + (playStart - tToBeats(a.t)) * spb * ratio;
        }
      }
      p.regions.push({ id: uid('rgn'), trackId: track.id, name, start: +start.toFixed(4), length: +Math.max(0.25, duration).toFixed(4), notes: [], audio: { sampleId: ref, offset: +Math.max(0, offsetSec).toFixed(4), gain: 1, ...(stretch ? { stretch } : {}) } });
      return;
    }
    if (kid(clip, 'Video')) report.items.push({ code: 'video', track: track.name });
  };

  const walkLanes = (lanes: Element, timeToBeats: (v: number) => number, track?: Track) => {
    const unit = attr(lanes, 'timeUnit');
    const toBeats = unit === 'seconds' ? (v: number) => v / spb : unit === 'beats' ? (v: number) => v : timeToBeats;
    const t = trackOfName(attr(lanes, 'track')) ?? track;
    for (const c of kids(lanes)) {
      if (c.tagName === 'Lanes') walkLanes(c, toBeats, t);
      else if (c.tagName === 'Clips' && t) for (const clip of kids(c, 'Clip')) clipToRegions(clip, t, attr(c, 'timeUnit') === 'seconds' ? (v) => v / spb : toBeats, 0);
      else if (c.tagName === 'Points') automation(c, toBeats);
      else if (c.tagName === 'ClipSlot') report.items.push({ code: 'clip_launcher', detail: t?.name ?? 'clip slot' });
    }
  };

  const automation = (pts: Element, toBeats: (v: number) => number) => {
    const target = attr(kid(pts, 'Target'), 'parameter');
    const info = target ? params.get(target) : undefined;
    const unit = attr(pts, 'unit') ?? info?.unit ?? null;
    const unitBeats = attr(pts, 'timeUnit') === 'seconds' ? (v: number) => v / spb : toBeats;
    const points = kids(pts).filter((e) => /Point$/.test(e.tagName));
    if (!info || info.param === 'other' || info.param === 'mute') {
      const owner = info ? p.tracks.find((t) => t.id === info.trackId)?.name : undefined;
      if (points.length) report.items.push({ code: 'automation', track: owner, detail: info?.name ?? (target ? `parameter ${target}` : attr(kid(pts, 'Target'), 'expression') ?? 'unknown target') });
      return;
    }
    const tr = p.tracks.find((t) => t.id === info.trackId)!;
    const out: AutoPoint[] = points.map((e) => {
      const v = num(e, 'value', 0);
      const value = info.param === 'volume' ? valueToFader(v, unit) : clamp(+(v * 2 - 1).toFixed(4), -1, 1);
      return { beat: +Math.max(0, unitBeats(num(e, 'time', 0))).toFixed(4), value };
    });
    if (out.length) setPoints(tr, mix(info.param), out);
  };

  const top = kid(arrangement, 'Lanes');
  if (top) walkLanes(top, (v) => v);
  // Tempo changes and markers
  const tempo = kid(arrangement, 'TempoAutomation');
  const tempos = [...new Set(kids(tempo).filter((e) => /Point$/.test(e.tagName)).map((e) => num(e, 'value')))].filter(Number.isFinite);
  if (tempos.length > 1) report.items.push({ code: 'tempo_changes', detail: `${tempos.length} tempos (${Math.min(...tempos)}–${Math.max(...tempos)} BPM), kept ${bpm}` });
  const markersEl = kid(arrangement, 'Markers');
  const markerUnit = attr(markersEl, 'timeUnit') ?? attr(top, 'timeUnit');
  const mBeats = (v: number) => (markerUnit === 'seconds' ? v / spb : v);
  const marks = kids(markersEl, 'Marker')
    .map((m) => ({ at: mBeats(num(m, 'time', 0)), name: attr(m, 'name') ?? 'Marker', color: attr(m, 'color') }))
    .sort((a, b) => a.at - b.at);
  const songEnd = Math.max(0, ...p.regions.map((r) => r.start + r.length));
  const sections: Section[] = [];
  const isEnd = (name: string) => /^(end|ende|fine|fin)$/i.test(name.trim());
  marks.forEach((m, i) => {
    // An "End" marker closes the section before it and starts nothing.
    if (isEnd(m.name)) return;
    const end = i + 1 < marks.length ? marks[i + 1].at : Math.max(songEnd, m.at + BEATS_PER_BAR);
    if (end - m.at < 1e-6) return;
    sections.push({ id: uid('sec'), name: m.name, kind: 'custom', start: +m.at.toFixed(4), length: +(end - m.at).toFixed(4), ...(m.color && /^#[0-9a-f]{6}$/i.test(m.color) ? { color: m.color } : {}) });
  });
  if (sections.length) p.sections = sections;
  if (kids(kid(root, 'Scenes'), 'Scene').length) report.items.push({ code: 'clip_launcher', detail: `${kids(kid(root, 'Scenes'), 'Scene').length} scene(s)` });

  // OpenBand-specific parts of an archive that another DAW has since changed: what still matches by name.
  if (ob?.project) restoreExtras(p, migrate(ob.project));
  return { project: migrate(p), samples, report };
}

/** Sample files referenced by an exact OpenBand project (by the audio paths export.ts writes). */
function sampleFiles(files: Record<string, Uint8Array>, p: Project): ImportedSample[] {
  const out: ImportedSample[] = [];
  for (const id of new Set(p.regions.flatMap((r) => (r.audio ? [r.audio.sampleId] : [])))) {
    const path = Object.keys(files).find((k) => k.startsWith(`audio/${id}-`));
    if (path) out.push({ ref: id, name: path.slice(`audio/${id}-`.length), data: files[path] });
  }
  return out;
}

/** Lyrics, comments and per-track instruments from openband.json, matched by track name. */
function restoreExtras(p: Project, ob: Project) {
  if (ob.lyrics) p.lyrics = { ...ob.lyrics, melodyTrackId: p.tracks.find((t) => t.name === ob.tracks.find((x) => x.id === ob.lyrics!.melodyTrackId)?.name)?.id };
  p.key = ob.key;
  p.name = ob.name;
  for (const t of p.tracks) {
    const o = ob.tracks.find((x) => x.name === t.name && x.kind === t.kind);
    if (!o) continue;
    t.instrument = o.instrument;
    t.cutoff = o.cutoff;
    t.color = o.color;
  }
  if (ob.instruments?.length) p.instruments = ob.instruments;
}
