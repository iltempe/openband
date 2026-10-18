// Sample-based instruments: imported samples, custom drum kits and SoundFont presets all play
// through SampleInstrument. Built only from Tone nodes, so it also works inside Tone.Offline().
import * as Tone from 'tone';
import type { CustomInstrument, SampleZone } from '../types';
import { cutoffToHz } from '../music';
import { getBuffer } from './samples';
import type { Instrument } from './instruments';

interface Voice {
  src: Tone.ToneBufferSource;
  gain: Tone.Gain;
  pitch: number;
  released: boolean;
}

const MAX_VOICES = 64;

export class SampleInstrument implements Instrument {
  output: Tone.Filter;
  private voices: Voice[] = [];
  private drums: boolean;

  constructor(private def: CustomInstrument) {
    this.drums = def.kind === 'drums';
    this.output = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -12, Q: 0.5 });
  }

  private zoneFor(pitch: number): SampleZone | undefined {
    const zones = this.def.zones;
    const hit = zones.filter((z) => pitch >= z.lo && pitch <= z.hi);
    if (hit.length) return hit.reduce((a, b) => (Math.abs(b.root - pitch) < Math.abs(a.root - pitch) ? b : a));
    if (this.drums) return undefined;
    return zones.reduce<SampleZone | undefined>((a, b) => (!a || Math.abs(b.root - pitch) < Math.abs(a.root - pitch) ? b : a), undefined);
  }

  private start(pitch: number, velocity: number, time: number): Voice | undefined {
    const zone = this.zoneFor(pitch);
    const buffer = zone && getBuffer(zone.sampleId);
    if (!zone || !buffer) return undefined;
    const cents = (pitch - zone.root) * 100 + (zone.tune ?? 0);
    // Voices are created at play time, which during an offline bounce happens after Tone has switched
    // back to the live context: always build them in the instrument's own context.
    const context = this.output.context;
    const src = new Tone.ToneBufferSource({ context, url: new Tone.ToneAudioBuffer(buffer), playbackRate: Math.pow(2, cents / 1200) });
    const looped = zone.loopEnd !== undefined && zone.loopStart !== undefined && zone.loopEnd > zone.loopStart;
    if (looped) {
      src.loop = true;
      src.loopStart = zone.loopStart!;
      src.loopEnd = zone.loopEnd!;
    }
    const gain = new Tone.Gain({ context, gain: 0 }).connect(this.output);
    src.connect(gain);
    const peak = Math.pow(velocity, 1.6) * (zone.gain ?? 1);
    const attack = Math.max(0.001, this.def.attack);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + attack);
    src.start(time);
    const voice: Voice = { src, gain, pitch, released: false };
    // Offline, Tone runs every scheduled callback (onended included) before rendering any audio,
    // so freeing voices there would silence them. The whole offline graph is dropped afterwards.
    if (!(context instanceof Tone.OfflineContext)) {
      src.onended = () => {
        src.dispose();
        gain.dispose();
        this.voices = this.voices.filter((v) => v !== voice);
      };
    }
    this.voices.push(voice);
    if (this.voices.length > MAX_VOICES) this.release(this.voices.find((v) => !v.released) ?? this.voices[0], time, 0.02);
    // One-shot drum hits that don't loop just play to the end of the sample.
    if (this.drums && !looped) voice.released = true;
    return voice;
  }

  private release(v: Voice, time: number, seconds = this.def.release) {
    if (v.released && !(this.drums && seconds < 0.05)) return;
    v.released = true;
    const r = Math.max(0.01, seconds);
    v.gain.gain.cancelAndHoldAtTime(time);
    v.gain.gain.setTargetAtTime(0, time, r / 4);
    v.src.stop(time + r + 0.05);
  }

  trigger(pitch: number, duration: number, time: number, velocity: number) {
    const v = this.start(pitch, velocity, time);
    if (v && !v.released) this.release(v, time + Math.max(0.02, duration));
  }
  noteOn(pitch: number, velocity: number, time?: number) {
    this.start(pitch, velocity, time ?? Tone.now());
  }
  noteOff(pitch: number, time?: number) {
    const t = time ?? Tone.now();
    this.voices.filter((v) => v.pitch === pitch && !v.released).forEach((v) => this.release(v, t));
  }
  setCutoff(v: number, time?: number) {
    this.output.frequency.rampTo(cutoffToHz(v), 0.05, time);
  }
  releaseAll() {
    const t = Tone.now();
    this.voices.filter((v) => !v.released).forEach((v) => this.release(v, t, 0.08));
  }
  dispose() {
    this.voices.forEach((v) => {
      v.src.onended = () => {};
      v.src.dispose();
      v.gain.dispose();
    });
    this.voices = [];
    this.output.dispose();
  }
}

/** Audio tracks have no instrument: their clips play straight into this tone filter. */
export class AudioTrackInput implements Instrument {
  output = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -12, Q: 0.5 });
  trigger() {}
  noteOn() {}
  noteOff() {}
  setCutoff(v: number, time?: number) {
    this.output.frequency.rampTo(cutoffToHz(v), 0.05, time);
  }
  releaseAll() {}
  dispose() {
    this.output.dispose();
  }
}
