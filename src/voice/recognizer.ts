// Hearing voice commands (SPEC v0.6 G4): Vosk in WebAssembly (Apache-2.0), offline and private, with the
// command grammar — or, as a fallback, the browser's Web Speech API (on some browsers the audio goes to an
// online service: the studio says so). Push-to-talk: listening runs while the key or pedal is held, and
// what was said in that window comes back with its words' timing.
import { voskModelUrl } from './models';
import { vocabulary, type Lang } from './grammar';

export type Engine = 'vosk' | 'webspeech';

export interface Heard {
  text: string;
  /** When listening started and ended (performance.now(), ms): the span to silence in a take. */
  from: number;
  to: number;
}

type VoskModel = { KaldiRecognizer: new (sr: number, grammar?: string) => VoskRec; terminate(): void };
type VoskRec = { on(ev: string, fn: (m: { result: { text?: string } }) => void): void; acceptWaveformFloat(b: Float32Array, sr: number): void; retrieveFinalResult(): void; remove(): void };

let models: Partial<Record<Lang, Promise<VoskModel>>> = {};
let mic: { stream: MediaStream; ctx: AudioContext; node: ScriptProcessorNode; source: MediaStreamAudioSourceNode } | null = null;
let feed: ((b: Float32Array, sr: number) => void) | null = null;
/** The input level while listening (0..1 RMS), for the meter in the voice button. */
export let onLevel: ((rms: number) => void) | null = null;
export const setOnLevel = (fn: ((rms: number) => void) | null) => void (onLevel = fn);

async function voskModel(lang: Lang, confirm: boolean): Promise<VoskModel> {
  models[lang] ??= (async () => {
    const url = await voskModelUrl(lang, confirm);
    const { createModel } = (await import('vosk-browser')) as unknown as { createModel(url: string, logLevel?: number): Promise<VoskModel> };
    return createModel(url, -1);
  })().catch((e) => {
    delete models[lang];
    throw e;
  });
  return models[lang]!;
}

/** The microphone, opened once and kept while voice control is on (it only listens while you hold the key). */
async function openMic(deviceId?: string | null) {
  if (mic) return mic;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => {
    if (!feed) return;
    const b = new Float32Array(e.inputBuffer.getChannelData(0));
    let s = 0;
    for (const v of b) s += v * v;
    onLevel?.(Math.sqrt(s / b.length));
    feed(b, ctx.sampleRate);
  };
  source.connect(node);
  node.connect(ctx.destination);
  mic = { stream, ctx, node, source };
  return mic;
}

export function closeMic() {
  if (!mic) return;
  mic.node.disconnect();
  mic.source.disconnect();
  mic.stream.getTracks().forEach((t) => t.stop());
  void mic.ctx.close();
  mic = null;
}

export function forgetModels() {
  for (const m of Object.values(models)) void m?.then((x) => x.terminate()).catch(() => {});
  models = {};
}

export interface Listening {
  /** Stop listening and say what was heard. */
  done(): Promise<Heard>;
}

/** Start listening (push-to-talk pressed). extraWords: the song's own (section names). */
export async function listen(o: { engine: Engine; lang: Lang; extraWords?: string[]; confirmDownload?: boolean; deviceId?: string | null }): Promise<Listening> {
  const from = performance.now();
  if (o.engine === 'webspeech') {
    const SR = (window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;
    if (!SR) throw new Error('This browser has no speech recognition: use Vosk (offline) instead');
    const r = new SR();
    r.lang = o.lang === 'it' ? 'it-IT' : 'en-US';
    r.interimResults = false;
    r.continuous = true;
    const texts: string[] = [];
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) texts.push(e.results[i][0].transcript);
    };
    const ended = new Promise<void>((res) => (r.onend = () => res()));
    r.start();
    return {
      async done() {
        const to = performance.now();
        r.stop();
        await Promise.race([ended, new Promise((res) => setTimeout(res, 2500))]);
        return { text: texts.join(' ').trim(), from, to };
      },
    };
  }
  const model = await voskModel(o.lang, !!o.confirmDownload);
  const m = await openMic(o.deviceId);
  if (m.ctx.state === 'suspended') await m.ctx.resume();
  const rec = new model.KaldiRecognizer(m.ctx.sampleRate, JSON.stringify([...vocabulary(o.lang, o.extraWords), '[unk]']));
  const texts: string[] = [];
  let final: () => void = () => {};
  const got = new Promise<void>((res) => (final = res));
  rec.on('result', (msg) => {
    if (msg.result.text) texts.push(msg.result.text);
    if (stopping) final();
  });
  let stopping = false;
  feed = (b, sr) => rec.acceptWaveformFloat(b, sr);
  return {
    async done() {
      const to = performance.now();
      // A little more audio: the last word is often still in the buffer.
      await new Promise((res) => setTimeout(res, 250));
      feed = null;
      stopping = true;
      rec.retrieveFinalResult();
      await Promise.race([got, new Promise((res) => setTimeout(res, 2500))]);
      rec.remove();
      return { text: texts.join(' ').replace(/\[unk\]/g, '').replace(/\s+/g, ' ').trim(), from, to };
    },
  };
}

interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void;
  onend: () => void;
  start(): void;
  stop(): void;
}
