// Hands-free studio (SPEC v0.6 G4): voice control's settings, push-to-talk, and what each command does.
// The user's own voice is the user's command: it runs as the user's action (one undo step each), and the
// microphone listens only while push-to-talk is held. A phrase outside the grammar goes to the AI when
// one is connected (an "ask" event), or gets the list of commands back.
import { create } from 'zustand';
import { useStore } from '../store';
import { runCommand } from '../commands';
import { engine } from '../audio/engine';
import { BEATS_PER_BAR } from '../music';
import { recordFromMic, spokenSpans, stopMicRecording, useMic, useRecSetup } from '../recording';
import { emitStudioEvent } from '../events';
import { COMMANDS_HELP, parseCommand, type Lang, type VoiceCommand } from './grammar';
import { listen, closeMic, setOnLevel, type Engine, type Heard, type Listening } from './recognizer';
import { NeedsVoiceModel } from './models';
import type { SectionKind } from '../types';

const KEY = 'openband.voice';
interface Settings {
  enabled: boolean;
  engine: Engine;
  lang: Lang;
  /** Spoken answers ("Take 3 recorded"), never while recording. */
  feedback: boolean;
  /** A MIDI CC (a pedal) held to talk; the keyboard: hold the back-quote key (`). */
  pushToTalkCc: number | null;
}
const DEFAULTS: Settings = { enabled: false, engine: 'vosk', lang: (typeof navigator !== 'undefined' && /^it/.test(navigator.language) ? 'it' : 'en') as Lang, feedback: true, pushToTalkCc: null };
function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

export const useVoice = create<Settings & { listening: boolean; heard: string; answer: string; error: string | null; learning: boolean; level: number; chunks: number }>(() => ({ ...load(), listening: false, heard: '', answer: '', error: null, learning: false, level: 0, chunks: 0 }));
setOnLevel((level) => useVoice.setState((s) => ({ level, chunks: s.chunks + 1 })));

export function setVoiceControl(s: Partial<Settings>) {
  useVoice.setState(s);
  const { enabled, engine: e, lang, feedback, pushToTalkCc } = useVoice.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ enabled, engine: e, lang, feedback, pushToTalkCc }));
  } catch {
    // not kept
  }
  if (s.enabled === false) closeMic();
}

const st = () => useStore.getState();
const run = (method: string, params: Record<string, unknown> = {}) => runCommand(method, params, 'ui');
const say = (it: string, en: string) => (useVoice.getState().lang === 'it' ? it : en);

/** Spoken feedback (speechSynthesis), short, in the command's language; silent while recording. */
function speak(text: string) {
  const v = useVoice.getState();
  if (!v.feedback || typeof speechSynthesis === 'undefined' || useMic.getState().state !== 'idle') return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = v.lang === 'it' ? 'it-IT' : 'en-US';
  u.rate = 1.1;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/** Where the last playback or recording started (for "again" and "play back"), and what it was. */
let last: { beat: number; recorded: boolean; regionId?: string; takeId?: string } = { beat: 0, recorded: false };
/** Spans when a command was said while recording: G4's take silencing reads them. */
export const spokenDuringRecording: Heard[] = [];

const KIND: Record<string, SectionKind> = { break: 'breakdown' };
function sectionStart(kind: string, ordinal?: number) {
  const k = KIND[kind] ?? kind;
  const secs = [...(st().project.sections ?? [])].filter((s) => s.kind === k).sort((a, b) => a.start - b.start);
  const s = secs[(ordinal ?? 1) - 1];
  if (!s) throw new Error(say(`Non c'è ${ordinal ? `una ${ordinal}ª ` : ''}${kind} in questa canzone`, `There is no ${ordinal ? `#${ordinal} ` : ''}${kind} in this song`));
  return s;
}

async function startRecording(beat: number) {
  last = { beat, recorded: true };
  const r = await recordFromMic({ mode: 'audio', startBeat: beat });
  const take = (r as { take_id?: string }).take_id;
  last = { beat, recorded: true, regionId: r.region_id, takeId: take };
  return r;
}

/** Do what a command says; answers what to say back. */
export async function execute(c: VoiceCommand): Promise<string> {
  const playing = st().isPlaying;
  const recording = useMic.getState().state !== 'idle';
  switch (c.action) {
    case 'record': {
      const beat = Math.max(0, Math.floor(engine.position / BEATS_PER_BAR) * BEATS_PER_BAR);
      void startRecording(beat)
        .then(() => speak(say('Take registrata', 'Take recorded')))
        .catch((e) => useVoice.setState({ error: (e as Error).message }));
      return say('Registro', 'Recording');
    }
    case 'stop':
      if (recording) stopMicRecording();
      await run('transport', { action: 'stop' });
      return say('Stop', 'Stopped');
    case 'again':
      if (last.recorded) {
        if (recording) stopMicRecording();
        void startRecording(last.beat).catch((e) => useVoice.setState({ error: (e as Error).message }));
        return say('Ancora, registro', 'Again, recording');
      }
      await run('transport', { action: 'play', from_bar: last.beat / BEATS_PER_BAR + 1 });
      return say('Da capo', 'From the top');
    case 'playback':
      if (recording) stopMicRecording();
      await run('transport', { action: 'play', from_bar: last.beat / BEATS_PER_BAR + 1 });
      return say('Riascolto', 'Playing back');
    case 'from_section': {
      const s = sectionStart(c.kind, c.ordinal);
      last = { ...last, beat: s.start, recorded: false };
      await run('transport', { action: playing ? 'play' : 'stop', from_bar: s.start / BEATS_PER_BAR + 1 });
      return say(`Da ${s.name}`, `From ${s.name}`);
    }
    case 'from_bar':
      last = { ...last, beat: (c.bar - 1) * BEATS_PER_BAR, recorded: false };
      await run('transport', { action: playing ? 'play' : 'stop', from_bar: c.bar });
      return say(`Dalla battuta ${c.bar}`, `From bar ${c.bar}`);
    case 'loop_section': {
      const s = sectionStart(c.kind, c.ordinal);
      await run('set_loop', { enabled: true, start_bar: s.start / BEATS_PER_BAR + 1, end_bar: (s.start + s.length) / BEATS_PER_BAR + 1 });
      return say(`Loop su ${s.name}`, `Looping ${s.name}`);
    }
    case 'loop_off':
      await run('set_loop', { enabled: false });
      return say('Loop via', 'Loop off');
    case 'punch':
      // Said inclusively ("from nine to twelve"): out is the bar after.
      await run('set_punch', { enabled: true, in_bar: Math.min(c.from, c.to), out_bar: Math.max(c.from, c.to) + 1 });
      return say(`Punch dalla ${c.from} alla ${c.to}`, `Punch from ${c.from} to ${c.to}`);
    case 'flub':
      await run('add_flub', { kind: 'flub' });
      return say('Errore segnato', 'Mistake marked');
    case 'good':
      await run('add_flub', { kind: 'good' });
      return say('Segnata come buona', 'Marked as good');
    case 'keep_take':
    case 'delete_last_take': {
      const region = last.regionId ? st().project.regions.find((r) => r.id === last.regionId) : undefined;
      const takes = region?.takes ?? [];
      const take = takes.find((t) => t.id === last.takeId) ?? takes.at(-1);
      if (!region || !take) return say('Non ci sono take registrate adesso', 'There is no take recorded just now');
      if (c.action === 'keep_take') {
        await run('set_active_take', { region_id: region.id, take_id: take.id });
        await run('add_flub', { kind: 'good', bar: region.start / BEATS_PER_BAR + 1, text: take.name });
        return say(`Tengo ${take.name}`, `Keeping ${take.name}`);
      }
      await run('delete_take', { region_id: region.id, take_id: take.id });
      last = { ...last, takeId: undefined };
      return say(`${take.name} cancellata`, `${take.name} deleted`);
    }
    case 'metronome':
      if (c.change === 'off' || c.change === 'on') await run('set_metronome', { enabled: c.change === 'on' });
      else {
        engine.setClickLevel(engine.clickDb + (c.change === 'louder' ? 3 : -3));
        if (!st().project.metronome) await run('set_metronome', { enabled: true });
      }
      return say({ off: 'Metronomo via', on: 'Metronomo', louder: 'Metronomo più forte', softer: 'Metronomo più piano' }[c.change], { off: 'Click off', on: 'Click on', louder: 'Click louder', softer: 'Click softer' }[c.change]);
    case 'tempo': {
      const bpm = Math.max(40, Math.min(240, c.bpm ?? Math.round(st().project.bpm + (c.delta ?? 0))));
      await run('set_tempo', { bpm });
      return say(`Tempo ${bpm}`, `Tempo ${bpm}`);
    }
    case 'monitor':
      if (c.target === 'input') {
        useRecSetup.setState((s) => ({ monitorDb: Math.max(-24, Math.min(12, (s.monitorDb ?? 0) + c.delta)) }));
        return say(c.delta > 0 ? 'Più te in cuffia' : 'Meno te in cuffia', c.delta > 0 ? 'More you' : 'Less you');
      }
      engine.setMonitoring({ trimDb: Math.max(-24, Math.min(6, engine.monitoring.trimDb + c.delta)) });
      return say(c.delta > 0 ? 'Più basi' : 'Meno basi', c.delta > 0 ? 'More track' : 'Less track');
    case 'undo':
      await run('undo');
      return say('Annullato', 'Undone');
    case 'session': {
      const s = c.kind ? sectionStart(c.kind, c.ordinal) : (st().project.sections ?? []).find((x) => engine.position >= x.start && engine.position < x.start + x.length);
      if (!s) return say('Su quale sezione? Per esempio: sessione sul ritornello, cinque passaggi', 'Which section? For example: session on the chorus, five passes');
      const { startSession } = await import('../session/session');
      const passes = c.passes ?? 5;
      void startSession({ section_id: s.id, passes })
        .then((r) => speak(say(`Fatto: ${r.takes.length} take, ${r.comp_take_id ? 'comp pronto' : 'una take migliore'}`, `Done: ${r.takes.length} takes, ${r.comp_take_id ? 'comp ready' : 'one best take'}`)))
        .catch((e) => useVoice.setState({ error: (e as Error).message }));
      return say(`Sessione su ${s.name}, ${passes} passaggi`, `Session on ${s.name}, ${passes} passes`);
    }
    case 'session_stop': {
      const { stopSession } = await import('../session/session');
      stopSession();
      return say('Basta così', "That's enough");
    }
  }
}

/** One phrase, heard: run it, or hand it to the AI, or say what the commands are. */
export async function handleHeard(h: Heard): Promise<{ command: VoiceCommand | null; answer: string }> {
  const v = useVoice.getState();
  if (useMic.getState().state === 'recording') {
    spokenSpans.push({ from: h.from, to: h.to });
    spokenDuringRecording.push(h);
  }
  const command = parseCommand(h.text, v.lang);
  let answer: string;
  if (!h.text) answer = say('Non ho sentito niente', "I didn't hear anything");
  else if (command) {
    try {
      answer = await execute(command);
    } catch (e) {
      answer = (e as Error).message;
    }
    emitStudioEvent({ kind: 'voice_command', heard: h.text, action: command.action });
  } else {
    // Not a command: an AI listening for "ask" events gets it (the page can't know if one is).
    emitStudioEvent({ kind: 'ask', text: h.text, context: { voice: true } });
    answer = say(`Non è un comando (se un'AI è in ascolto, gliel'ho passato). I comandi sono: ${COMMANDS_HELP.it}`, `That's not a command (if an AI is listening, it got it). The commands are: ${COMMANDS_HELP.en}`);
  }
  useVoice.setState({ heard: h.text, answer });
  speak(answer.split(':')[0]);
  return { command, answer };
}

let active: Listening | null = null;
/** Push-to-talk pressed. */
export async function pressToTalk(confirmDownload = false) {
  const v = useVoice.getState();
  if (!v.enabled || active || v.listening) return;
  useVoice.setState({ listening: true, error: null });
  try {
    active = await listen({ engine: v.engine, lang: v.lang, confirmDownload, deviceId: useRecSetup.getState().deviceId, extraWords: (st().project.sections ?? []).map((s) => s.name) });
  } catch (e) {
    useVoice.setState({ listening: false, error: e instanceof NeedsVoiceModel ? e.message : (e as Error).message });
    throw e;
  }
}
/** Push-to-talk released. */
export async function releaseToTalk() {
  const a = active;
  active = null;
  if (!a) return useVoice.setState({ listening: false });
  const h = await a.done();
  useVoice.setState({ listening: false });
  return handleHeard(h);
}

/** A MIDI controller: learn it as the push-to-talk pedal, or press/release to talk. True when it was ours. */
export function voiceCC(cc: number, value: number): boolean {
  const v = useVoice.getState();
  if (v.learning) {
    if (value <= 0) return true;
    setVoiceControl({ pushToTalkCc: cc });
    useVoice.setState({ learning: false });
    return true;
  }
  if (!v.enabled || v.pushToTalkCc !== cc) return false;
  if (value >= 64) void pressToTalk().catch(() => {});
  else void releaseToTalk();
  return true;
}
