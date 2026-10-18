// Offline bounce of the whole project to a 16-bit stereo WAV.
import * as Tone from 'tone';
import type { Project } from '../types';
import { faderToDb, sendToDb } from '../music';
import { projectEnd, projectSampleIds } from '../store';
import { ensureSamples, getBuffer } from './samples';
import { createInstrument, makeImpulse } from './instruments';
import { FxChain } from './fx';
import { effectiveValue, hasAutomation } from '../automation';

const dbToGain = (db: number) => (db === -Infinity ? 0 : Math.pow(10, db / 20));

export async function renderProject(p: Project): Promise<Blob> {
  const endBeats = Math.max(projectEnd(p), 4);
  const seconds = (endBeats * 60) / p.bpm + 3;
  const anySolo = p.tracks.some((t) => t.solo);
  await ensureSamples(projectSampleIds(p));

  const buffer = await Tone.Offline(({ transport }) => {
    transport.bpm.value = p.bpm;
    const PPQ = transport.PPQ;
    const master = new Tone.Gain(dbToGain(faderToDb(p.masterVolume))).toDestination();
    const reverb = new Tone.Convolver(makeImpulse(2.8, 3.2)).connect(master);
    const delay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.34, wet: 1 }).connect(master);

    for (const track of p.tracks) {
      if (track.mute || (anySolo && !track.solo)) continue;
      const inst = createInstrument(track.instrument, p.instruments?.find((c) => c.id === track.instrument));
      inst.setCutoff(track.cutoff);
      const ch = new Tone.Channel({ volume: faderToDb(track.volume), pan: track.pan }).connect(master);
      const fx = new FxChain();
      fx.update(track.fx);
      inst.output.connect(fx.input);
      fx.output.connect(ch);
      const revSend = new Tone.Gain(dbToGain(sendToDb(track.reverb))).connect(reverb);
      const delSend = new Tone.Gain(dbToGain(sendToDb(track.delay)) * 0.7).connect(delay);
      ch.connect(revSend);
      ch.connect(delSend);
      if (hasAutomation(track)) {
        const auto = track.automation!;
        transport.scheduleRepeat((time) => {
          const beat = transport.getTicksAtTime(time) / PPQ;
          const v = (p: 'volume' | 'pan' | 'tone' | 'reverb' | 'echo') => effectiveValue(track, p, beat);
          if (auto.volume?.length) ch.volume.rampTo(Math.max(-100, faderToDb(v('volume'))), 0.03, time);
          if (auto.pan?.length) ch.pan.rampTo(v('pan'), 0.03, time);
          if (auto.reverb?.length) revSend.gain.rampTo(dbToGain(sendToDb(v('reverb'))), 0.03, time);
          if (auto.echo?.length) delSend.gain.rampTo(dbToGain(sendToDb(v('echo'))) * 0.7, 0.03, time);
          if (auto.tone?.length) inst.setCutoff(v('tone'), time);
        }, '32n', 0);
      }

      for (const region of p.regions.filter((r) => r.trackId === track.id)) {
        if (region.audio) {
          const clip = region.audio;
          const buffer = getBuffer(clip.sampleId);
          const dur = buffer ? Math.min((region.length * 60) / p.bpm, buffer.duration - clip.offset) : 0;
          if (!buffer || dur <= 0) continue;
          const player = new Tone.Player({ url: new Tone.ToneAudioBuffer(buffer), fadeIn: 0.004, fadeOut: 0.01 }).connect(inst.output);
          player.volume.value = clip.gain > 0 ? 20 * Math.log10(clip.gain) : -Infinity;
          transport.schedule((time) => player.start(time, clip.offset, dur), `${Math.round(region.start * PPQ)}i`);
          continue;
        }
        for (const n of region.notes) {
          if (n.start < 0 || n.start >= region.length) continue;
          const dur = Math.min(n.duration, region.length - n.start);
          transport.schedule((time) => {
            inst.trigger(n.pitch, (dur * 60) / p.bpm, time, n.velocity);
          }, `${Math.round((region.start + n.start) * PPQ)}i`);
        }
      }
    }
    transport.start(0);
  }, seconds, 2, 44100);

  return encodeWav(buffer.get() as AudioBuffer);
}

export function encodeWav(buf: AudioBuffer): Blob {
  const chans = Math.min(2, buf.numberOfChannels);
  const len = buf.length;
  const data = new DataView(new ArrayBuffer(44 + len * chans * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  data.setUint32(4, 36 + len * chans * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, chans, true);
  data.setUint32(24, buf.sampleRate, true);
  data.setUint32(28, buf.sampleRate * chans * 2, true);
  data.setUint16(32, chans * 2, true);
  data.setUint16(34, 16, true);
  str(36, 'data');
  data.setUint32(40, len * chans * 2, true);
  const channels = Array.from({ length: chans }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < chans; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data], { type: 'audio/wav' });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
