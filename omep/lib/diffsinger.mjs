// DiffSinger (openvpi, Apache-2.0) as a singing engine (voice.sing, SPEC v0.6 §10): the Song Context
// Package's melody and syllables — with the phonemes OpenBand already computed — become a DiffSinger
// .ds file (phrases with offset, ph_seq, ph_dur, ph_num, note_seq, note_dur, note_slur, f0_seq,
// f0_timestep), sung by the user's own install and voicebank with
//   python scripts/infer.py acoustic song.ds --exp <voicebank> --out <dir> --title <name> [--spk] [--lang]
// (the acoustic model with OpenBand's durations and pitch curve; no variance model needed). Pure,
// apart from running that command (engine process: omep/diffsinger-engine.mjs).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIFFSINGER_LICENSE_CODE = 'Apache-2.0';
const VOWELS = new Set(['a', 'e', 'E', 'i', 'o', 'O', 'u']);
/** How long a consonant takes before the note it leads into (s). */
const CONSONANT_S = { s: 0.09, z: 0.08, S: 0.1, f: 0.08, v: 0.06, ts: 0.09, dz: 0.08, tS: 0.1, dZ: 0.09, p: 0.07, t: 0.065, k: 0.075, b: 0.06, d: 0.055, g: 0.065, r: 0.045, l: 0.06, L: 0.07, m: 0.07, n: 0.065, J: 0.07, j: 0.05, w: 0.05 };
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (midi) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const r4 = (x) => Math.round(x * 1e4) / 1e4;
/** A gap shorter than this between two notes is articulation, sung legato (no rest). */
const LEGATO = 0.12;

/** What gets sung: notes of the scope with their syllable's phonemes (the vowel held on a melisma). */
export function sungNotes(scp) {
  const spb = 60 / (scp.song?.bpm || 120);
  const from = scp.scope?.from_bar ?? 1;
  const to = scp.scope?.to_bar ?? from + (scp.song?.length_bars ?? 8);
  const span = (to - from) * (Number(String(scp.song?.meter ?? '4/4').split('/')[0]) || 4);
  const notes = (scp.melody?.notes ?? []).filter((n) => n.start >= -1e-6 && n.start < span).sort((a, b) => a.start - b.start);
  const syl = (scp.lyrics?.lines ?? []).flatMap((l) => l.syllables ?? []);
  const timed = syl.filter((s) => typeof s.start_beat === 'number');
  const queue = timed.length ? [] : syl.slice();
  let held = 'a';
  return notes.map((n) => {
    const sy = timed.find((s) => Math.abs(s.start_beat - n.start) < 0.13) ?? (queue.length ? queue.shift() : null);
    let ph;
    let slur = false;
    if (sy && sy.phonemes?.length) {
      ph = sy.phonemes;
      held = ph.find((p) => VOWELS.has(p)) ?? held;
    } else if (sy) {
      ph = [held];
    } else {
      ph = [held];
      slur = true;
    }
    return { text: sy?.text ?? '', start: n.start * spb, end: (n.start + n.duration) * spb, midi: n.pitch, ph, slur };
  });
}

/** The .ds segments (phrases split at rests of `gap` seconds or more), times from the scope's start. */
export function toDs(notes, o = {}) {
  const map = o.phonemes ?? {};
  const prefix = o.langPrefix ?? '';
  const sym = (p) => (p === 'SP' || p === 'AP' ? p : `${prefix}${map[p] ?? p}`);
  const gap = o.gap ?? 0.35;
  const lead = o.lead ?? 0.3;
  const phrases = [];
  for (const n of notes) {
    const last = phrases.at(-1)?.at(-1);
    if (!last || n.start - last.end >= gap) phrases.push([n]);
    else phrases.push(phrases.pop().concat([n]));
  }
  return phrases.map((ph) => {
    // Each note: its vowel and coda, then the onset consonants of the next syllable (DiffSinger puts the
    // vowel on the note's start, so consonants borrow time from the note before).
    const parts = ph.map((n) => {
      const v = Math.max(0, n.ph.findIndex((p) => VOWELS.has(p)));
      return { n, onset: n.ph.slice(0, v), rest: n.ph.slice(v) };
    });
    const offset = Math.max(0, ph[0].start - lead);
    const seq = [];
    const dur = [];
    const num = [];
    const noteSeq = [];
    const noteDur = [];
    const slur = [];
    const fit = (cons, room) => {
      const want = cons.map((c) => CONSONANT_S[c] ?? 0.06);
      const total = want.reduce((a, b) => a + b, 0);
      const k = total > room * 0.6 ? (room * 0.6) / total : 1;
      return want.map((w) => w * k);
    };
    // The opening rest, which carries the first syllable's onset.
    const firstRoom = ph[0].start - offset;
    const firstCons = fit(parts[0].onset, firstRoom);
    seq.push('SP', ...parts[0].onset.map(sym));
    dur.push(firstRoom - firstCons.reduce((a, b) => a + b, 0), ...firstCons);
    num.push(1 + parts[0].onset.length);
    noteSeq.push('rest');
    noteDur.push(firstRoom);
    slur.push(0);
    parts.forEach((p, i) => {
      const next = parts[i + 1];
      const end = next ? next.n.start : p.n.end;
      const room = end - p.n.start;
      // A rest inside the phrase (short gap): the note ends, a rest note takes the gap.
      const gapAfter = next ? next.n.start - p.n.end : 0;
      const sung = gapAfter > LEGATO ? p.n.end - p.n.start : room;
      const cons = next && gapAfter <= LEGATO ? fit(next.onset, sung) : [];
      const consSum = cons.reduce((a, b) => a + b, 0);
      const restPh = p.rest.length ? p.rest : ['a'];
      // The vowel gets most of the note, a coda the end of it.
      const vowelLen = (sung - consSum) * (restPh.length > 1 ? 0.8 : 1);
      seq.push(...restPh.map(sym), ...(cons.length ? next.onset.map(sym) : []));
      dur.push(vowelLen, ...restPh.slice(1).map(() => ((sung - consSum) * 0.2) / (restPh.length - 1)), ...cons);
      num.push(restPh.length + cons.length);
      noteSeq.push(noteName(p.n.midi));
      noteDur.push(sung);
      slur.push(p.n.slur ? 1 : 0);
      if (gapAfter > LEGATO) {
        const restCons = next ? fit(next.onset, gapAfter) : [];
        seq.push('SP', ...(next ? next.onset.map(sym) : []));
        dur.push(gapAfter - restCons.reduce((a, b) => a + b, 0), ...restCons);
        num.push(1 + restCons.length);
        noteSeq.push('rest');
        noteDur.push(gapAfter);
        slur.push(0);
      }
    });
    // A short closing rest so the last note can end.
    seq.push('SP');
    dur.push(0.1);
    num.push(1);
    noteSeq.push('rest');
    noteDur.push(0.1);
    slur.push(0);
    // The pitch curve: each note's pitch, gliding into the next over 40 ms; rests hold the neighbour.
    const step = 0.005;
    const total = dur.reduce((a, b) => a + b, 0);
    const f0 = [];
    for (let t = 0; t < total; t += step) {
      const abs = offset + t;
      const at = ph.findIndex((n) => abs < n.end);
      const n = ph[at < 0 ? ph.length - 1 : at];
      const prev = ph[(at < 0 ? ph.length : at) - 1];
      let midi = n.midi;
      if (prev && abs < n.start + 0.04 && abs >= n.start - 0.04) midi = prev.midi + ((n.midi - prev.midi) * (abs - (n.start - 0.04))) / 0.08;
      f0.push(Math.round(hz(midi) * 10) / 10);
    }
    return {
      offset: r4(offset),
      text: ['SP', ...ph.map((n) => n.text || '-'), 'SP'].join(' '),
      ph_seq: seq.join(' '),
      ph_dur: dur.map((d) => r4(Math.max(0.001, d))).join(' '),
      ph_num: num.join(' '),
      note_seq: noteSeq.join(' '),
      note_dur: noteDur.map(r4).join(' '),
      note_slur: slur.join(' '),
      f0_seq: f0.join(' '),
      f0_timestep: String(step),
    };
  });
}

/** Run the user's DiffSinger: the WAV it wrote (44.1 kHz), as bytes. */
export function runDiffSinger(ds, o) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omep-diffsinger-'));
  const file = path.join(dir, 'song.ds');
  fs.writeFileSync(file, JSON.stringify(ds, null, 1));
  const args = [path.join('scripts', 'infer.py'), 'acoustic', file, '--exp', o.exp, '--out', dir, '--title', 'sung', '--seed', String(o.seed ?? 1), ...(o.spk ? ['--spk', o.spk] : []), ...(o.lang ? ['--lang', o.lang] : []), ...(o.steps ? ['--steps', String(o.steps)] : [])];
  return new Promise((resolve, reject) => {
    const p = spawn(o.python ?? 'python', args, { cwd: o.repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.stdout.on('data', () => {});
    o.signal?.addEventListener('abort', () => p.kill(), { once: true });
    p.on('error', (e) => reject(new Error(`DiffSinger could not start (${o.python ?? 'python'} in ${o.repo}): ${e.message}`)));
    p.on('close', (code) => {
      const out = path.join(dir, 'sung.wav');
      if (code === 0 && fs.existsSync(out)) return resolve({ bytes: fs.readFileSync(out), dir });
      reject(new Error(`DiffSinger failed (exit ${code}): ${err.trim().split('\n').slice(-3).join(' ') || 'no output'}`));
    });
  });
}
