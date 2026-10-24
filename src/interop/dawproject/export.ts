// OpenBand → DAWproject 1.0 (zip with project.xml, metadata.xml, the audio files and openband.json).
// Element order follows Project.xsd (bitwig/dawproject, MIT). What DAWproject can't hold (lyrics, takes,
// annotations, flubs, WAM plugins, the amp sim…) travels in openband.json: other DAWs ignore it, and
// OpenBand restores it on import, so OpenBand → DAWproject → OpenBand loses nothing.
import { strToU8, zipSync } from 'fflate';
import type { PluginSlot, Project, Track } from '../../types';
import { normalizeFx } from '../../audio/fx';
import { findInstrument } from '../../audio/instruments';
import { lanesOf, mix, pointsOf, targetKey } from '../../automation';
import { stretchFactor } from '../../audio/stretch';
import { BEATS_PER_BAR } from '../../music';
import { writeXml, x, type XNode } from './xml';
import type { ReportItem } from './report';
import { stateToVstPreset } from './vstpreset';

export interface ExportSample {
  name: string;
  data: Uint8Array;
  channels: number;
  sampleRate: number;
  /** Seconds. */
  duration: number;
}

export const OPENBAND_JSON = 'openband.json';

/** FNV-1a of project.xml, so a re-import can tell whether another DAW changed the file. */
export function xmlHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Fader (0..1, 0.8 = 0 dB) → linear gain, as DAWproject's Volume (unit linear, 0..2). */
const faderToGain = (v: number) => Math.min(2, Math.max(0, v / 0.8));
/** Send amount 0..1 → linear gain. */
const sendGain = (v: number) => Math.min(1, Math.max(0, v));

/** XML ids must start with a letter; OpenBand ids already do, but be safe. */
const xid = (id: string) => (/^[A-Za-z_]/.test(id) ? id : `id_${id}`).replace(/[^\w.-]/g, '_');

const audioPath = (sampleId: string, name: string) => `audio/${sampleId}-${name.replace(/[^\w.\- ]+/g, '_')}`;

export function projectToDawproject(p: Project, samples: Record<string, ExportSample>, app = { name: 'OpenBand', version: '0' }): { zip: Uint8Array; report: ReportItem[] } {
  const report: ReportItem[] = [];
  const spb = 60 / p.bpm;
  const files: Record<string, Uint8Array> = {};

  /**
   * A native plugin (G8.9) as DAWproject writes it: Vst3Plugin / ClapPlugin / AuPlugin with its id and its
   * state in plugins/ (.vstpreset, .clap-preset, .aupreset), so Bitwig, Studio One or Cubase load it.
   */
  const nativeDevice = (id: string, role: 'instrument' | 'audioFX', name: string, format: string, native: NonNullable<PluginSlot['native']>, on = true): XNode => {
    const tag = format === 'vst3' ? 'Vst3Plugin' : format === 'au' ? 'AuPlugin' : 'ClapPlugin';
    let state: XNode | null = null;
    if (native.state_b64) {
      const bytes = Uint8Array.from(atob(native.state_b64), (c) => c.charCodeAt(0));
      const path = `plugins/${id}.${format === 'vst3' ? 'vstpreset' : format === 'au' ? 'aupreset' : 'clap-preset'}`;
      files[path] = format === 'vst3' ? stateToVstPreset(native.id, bytes) : bytes;
      state = x('State', { path });
    }
    return x(tag, { deviceID: native.id, deviceName: name, deviceRole: role, deviceVendor: native.vendor, pluginVersion: native.version, loaded: true, id, name }, [x('Enabled', { value: on, id: `${id}_on`, name: 'On/Off' }), state]);
  };
  const isNative = (format?: string) => format === 'clap' || format === 'vst3' || format === 'au';

  const channelOf = (t: Track): XNode => {
    const fx = normalizeFx(t.fx);
    const devices: XNode[] = [];
    const preset = findInstrument(t.instrument);
    const custom = p.instruments?.find((i) => i.id === t.instrument);
    if (t.kind !== 'audio' && custom?.source === 'native' && custom.native && isNative(custom.format)) devices.push(nativeDevice(`${xid(t.id)}_inst`, 'instrument', custom.name, custom.format!, custom.native));
    else if (t.kind !== 'audio') devices.push(x('BuiltinDevice', { deviceName: custom?.name ?? preset?.name ?? t.instrument, deviceRole: 'instrument', deviceVendor: 'OpenBand', id: `${xid(t.id)}_inst`, name: custom?.name ?? preset?.name ?? t.instrument }));
    if (fx.eq.on) {
      const band = (type: string, freq: number, gain: number, order: number) =>
        x('Band', { type, order }, [x('Freq', { unit: 'hertz', value: freq }), x('Gain', { unit: 'decibel', value: gain }), x('Q', { unit: 'linear', value: 0.7 }), x('Enabled', { value: true })]);
      devices.push(x('Equalizer', { deviceName: 'EQ', deviceRole: 'audioFX', deviceVendor: 'OpenBand', id: `${xid(t.id)}_eq`, name: 'EQ' }, [band('lowShelf', 250, fx.eq.low, 0), band('bell', fx.eq.midFreq, fx.eq.mid, 1), band('highShelf', 3500, fx.eq.high, 2)]));
    }
    if (fx.comp.on) {
      devices.push(
        x('Compressor', { deviceName: 'Compressor', deviceRole: 'audioFX', deviceVendor: 'OpenBand', id: `${xid(t.id)}_comp`, name: 'Compressor' }, [
          x('Attack', { unit: 'seconds', value: fx.comp.attack }),
          x('AutoMakeup', { value: false }),
          x('InputGain', { unit: 'decibel', value: 0 }),
          x('OutputGain', { unit: 'decibel', value: fx.comp.makeup }),
          x('Ratio', { unit: 'linear', value: fx.comp.ratio }),
          x('Release', { unit: 'seconds', value: fx.comp.release }),
          x('Threshold', { unit: 'decibel', value: fx.comp.threshold }),
        ]),
      );
    }
    if (fx.amp.on) report.push({ code: 'export_skipped', track: t.name, detail: 'amp simulator' });
    for (const s of fx.plugins ?? []) {
      if (s.native && isNative(s.format)) devices.push(nativeDevice(`${xid(t.id)}_${xid(s.id)}`, 'audioFX', s.name, s.format!, s.native, s.on));
      else report.push({ code: 'export_skipped', track: t.name, detail: `${(s.format ?? 'wam').toUpperCase()} plugin ${s.name}` });
    }
    if (custom?.source === 'wam') report.push({ code: 'export_skipped', track: t.name, detail: `WAM instrument ${custom.name}` });
    const other = lanesOf(t).filter((l) => l.points.length && !(l.target.kind === 'mix' && (l.target.param === 'volume' || l.target.param === 'pan')));
    if (other.length) report.push({ code: 'export_skipped', track: t.name, detail: `automation of ${other.map((l) => targetKey(l.target)).join(', ')}` });
    return x('Channel', { audioChannels: 2, destination: 'master_ch', role: 'regular', solo: t.solo, id: `${xid(t.id)}_ch` }, [
      devices.length ? x('Devices', {}, devices) : null,
      x('Mute', { value: t.mute, id: `${xid(t.id)}_mute`, name: 'Mute' }),
      x('Pan', { max: 1, min: 0, unit: 'normalized', value: (t.pan + 1) / 2, id: `${xid(t.id)}_pan`, name: 'Pan' }),
      t.reverb > 0 || t.delay > 0
        ? x('Sends', {}, [
            t.reverb > 0 ? x('Send', { destination: 'reverb_ch', type: 'post', id: `${xid(t.id)}_rev`, name: 'Reverb' }, [x('Volume', { max: 1, min: 0, unit: 'linear', value: sendGain(t.reverb), id: `${xid(t.id)}_revv` })]) : null,
            t.delay > 0 ? x('Send', { destination: 'delay_ch', type: 'post', id: `${xid(t.id)}_del`, name: 'Echo' }, [x('Volume', { max: 1, min: 0, unit: 'linear', value: sendGain(t.delay), id: `${xid(t.id)}_delv` })]) : null,
          ])
        : null,
      x('Volume', { max: 2, min: 0, unit: 'linear', value: faderToGain(t.volume), id: `${xid(t.id)}_vol`, name: 'Volume' }),
    ]);
  };

  const returnTrack = (id: string, name: string) =>
    x('Track', { contentType: 'audio', loaded: true, id: `${id}_trk`, name }, [
      x('Channel', { audioChannels: 2, destination: 'master_ch', role: 'effect', solo: false, id: `${id}_ch` }, [x('Mute', { value: false }), x('Pan', { max: 1, min: 0, unit: 'normalized', value: 0.5 }), x('Volume', { max: 2, min: 0, unit: 'linear', value: 1 })]),
    ]);

  const structure: XNode[] = [
    ...p.tracks.map((t) => x('Track', { contentType: t.kind === 'audio' ? 'audio' : 'notes', loaded: true, id: xid(t.id), name: t.name, color: t.color }, [channelOf(t)])),
    returnTrack('reverb', 'Reverb'),
    returnTrack('delay', 'Echo'),
    x('Track', { contentType: 'audio notes', loaded: true, id: 'master_trk', name: 'Master' }, [
      x('Channel', { audioChannels: 2, role: 'master', solo: false, id: 'master_ch' }, [x('Mute', { value: false }), x('Pan', { max: 1, min: 0, unit: 'normalized', value: 0.5 }), x('Volume', { max: 2, min: 0, unit: 'linear', value: faderToGain(p.masterVolume), id: 'master_vol', name: 'Volume' })]),
    ]),
  ];

  const trackLanes = p.tracks.map((t) => {
    const clips = p.regions
      .filter((r) => r.trackId === t.id)
      .sort((a, b) => a.start - b.start)
      .map((r) => {
        if (r.audio) {
          const s = samples[r.audio.sampleId];
          if (!s) {
            report.push({ code: 'audio_missing', track: t.name, detail: r.name });
            return null;
          }
          const path = audioPath(r.audio.sampleId, s.name);
          files[path] = s.data;
          const startSec = r.audio.offset;
          // A stretched clip (F23) covers less (or more) of its file than its length in seconds.
          const factor = stretchFactor(r.audio, p.bpm);
          if (r.audio.pitch) report.push({ code: 'export_skipped', track: t.name, detail: `pitch shift of ${r.name} (${r.audio.pitch > 0 ? '+' : ''}${r.audio.pitch} semitones)` });
          return x('Clip', { time: r.start, duration: r.length, playStart: 0, name: r.name }, [
            x('Warps', { contentTimeUnit: 'seconds', timeUnit: 'beats', id: `${xid(r.id)}_warps` }, [
              x('Audio', { algorithm: 'stretch', channels: s.channels, duration: s.duration, sampleRate: s.sampleRate, id: `${xid(r.id)}_audio` }, [x('File', { path })]),
              x('Warp', { time: 0, contentTime: startSec }),
              x('Warp', { time: r.length, contentTime: startSec + (r.length * spb) / factor }),
            ]),
          ]);
        }
        return x('Clip', { time: r.start, duration: r.length, playStart: 0, name: r.name }, [
          x(
            'Notes',
            { id: `${xid(r.id)}_notes` },
            [...r.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch).map((n) => x('Note', { time: n.start, duration: n.duration, channel: t.kind === 'drums' ? 9 : 0, key: n.pitch, vel: n.velocity, rel: n.velocity })),
          ),
        ]);
      });
    const auto = (param: 'volume' | 'pan', target: string) => {
      const pts = pointsOf(t, mix(param));
      if (!pts?.length) return null;
      return x('Points', { unit: param === 'volume' ? 'linear' : 'normalized', id: `${xid(t.id)}_${param}_pts` }, [
        x('Target', { parameter: target }),
        ...pts.map((pt) => x('RealPoint', { time: pt.beat, value: param === 'volume' ? faderToGain(pt.value) : (pt.value + 1) / 2, interpolation: 'linear' })),
      ]);
    };
    return x('Lanes', { track: xid(t.id), id: `${xid(t.id)}_lanes` }, [x('Clips', { id: `${xid(t.id)}_clips` }, clips), auto('volume', `${xid(t.id)}_vol`), auto('pan', `${xid(t.id)}_pan`)]);
  });

  const sections = [...(p.sections ?? [])].sort((a, b) => a.start - b.start);
  const xml = writeXml(
    x('Project', { version: '1.0' }, [
      x('Application', { name: app.name, version: app.version }),
      x('Transport', {}, [x('Tempo', { max: 240, min: 40, unit: 'bpm', value: p.bpm, id: 'tempo', name: 'Tempo' }), x('TimeSignature', { denominator: 4, numerator: 4, id: 'timesig' })]),
      x('Structure', {}, structure),
      x('Arrangement', { id: 'arrangement' }, [
        x('Lanes', { timeUnit: 'beats', id: 'arr_lanes' }, trackLanes),
        sections.length
          ? x(
              'Markers',
              { id: 'markers' },
              // Markers have no length: an "End" marker closes a section that the next one doesn't start right after.
              sections.flatMap((s, i) => {
                const end = s.start + s.length;
                const next = sections[i + 1];
                return [x('Marker', { time: s.start, name: s.name, color: s.color }), ...(!next || next.start > end + 1e-6 ? [x('Marker', { time: end, name: 'End' })] : [])];
              }),
            )
          : null,
      ]),
      x('Scenes'),
    ]),
  );
  const metadata = writeXml({ tag: 'MetaData', children: [{ tag: 'Title', text: p.name }, { tag: 'Comment', text: `${p.bpm} BPM, ${p.key} — made with OpenBand (${Math.ceil(Math.max(0, ...p.regions.map((r) => r.start + r.length)) / BEATS_PER_BAR)} bars)` }] });
  if (p.lyrics?.lines.length) report.push({ code: 'export_skipped', detail: 'lyrics' });
  if (p.regions.some((r) => (r.takes?.length ?? 0) > 1)) report.push({ code: 'export_skipped', detail: 'alternative takes (the active one is exported)' });
  if (p.annotations?.length) report.push({ code: 'export_skipped', detail: 'comments' });
  const ob = { format: 'openband', version: 1, projectXml: xmlHash(xml), project: p };
  const zip = zipSync({ 'project.xml': strToU8(xml), 'metadata.xml': strToU8(metadata), [OPENBAND_JSON]: strToU8(JSON.stringify(ob)), ...files }, { level: 6 });
  return { zip, report };
}

