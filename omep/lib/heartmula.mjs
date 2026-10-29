// omep-heartmula (SPEC v0.6 §10, E6): HeartMuLa (heartlib, Apache-2.0 code and weights) as an OMEP engine
// for music.song. heartlib has no server or package CLI: the engine runs its own example script,
// examples/run_music_generation.py, with the user's Python, in the user's clone — the documented way, so
// nothing of its Python API is guessed. Lyrics and tags go as files (the script reads a path as a file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { scopeTimes } from './acestep.mjs';

export const HEARTMULA_LICENSE = { code: 'Apache-2.0', weights: 'Apache-2.0', commercial: 'yes', attribution: null, conditions: null, url: 'https://github.com/HeartMuLa/heartlib' };

const SECTION = { intro: 'Intro', verse: 'Verse', prechorus: 'Prechorus', pre_chorus: 'Prechorus', chorus: 'Chorus', bridge: 'Bridge', outro: 'Outro', solo: 'Interlude', break: 'Interlude' };

/**
 * HeartMuLa's tags: lowercase, comma-separated without spaces after the commas ("piano,happy,wedding").
 * From the request, the intent, the soft style constraints, and the tempo and key in words.
 */
export function tagsFor(scp, request = {}) {
  const words = [request.text, request.style, scp.intent?.text, ...(scp.constraints?.soft?.style ?? [])]
    .filter(Boolean)
    .flatMap((t) => String(t).split(/[,;]/))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (scp.song?.bpm) words.push(`${Math.round(scp.song.bpm)} bpm`);
  const key = /^([A-G][#b]?)(m)?$/.exec(String(scp.song?.key ?? '').trim());
  if (key) words.push(`${key[1].toLowerCase()} ${key[2] ? 'minor' : 'major'}`);
  return [...new Set(words)].join(',').slice(0, 512);
}

/** The lyrics with HeartMuLa's section markers ([Verse], [Chorus]…), a blank line between sections. */
export function lyricsFor(scp, request = {}) {
  if (typeof request.lyrics === 'string' && request.lyrics.trim()) return request.lyrics;
  const lines = scp.lyrics?.lines ?? [];
  if (!lines.length) {
    // An instrumental: the sections in scope as empty markers.
    const kinds = (scp.sections ?? []).map((s) => SECTION[s.kind] ?? 'Verse');
    return (kinds.length ? kinds : ['Intro', 'Verse', 'Outro']).map((k) => `[${k}]`).join('\n\n');
  }
  const kindOf = new Map((scp.sections ?? []).map((s) => [s.id, SECTION[s.kind] ?? 'Verse']));
  const out = [];
  let current;
  for (const l of lines) {
    const id = l.section_id ?? current ?? '';
    if (id !== current) {
      if (out.length) out.push('');
      out.push(`[${kindOf.get(id) ?? 'Verse'}]`);
      current = id;
    }
    out.push(l.text);
  }
  return out.join('\n');
}

/** Run the user's heartlib: the WAV it wrote (48 kHz), as bytes. */
export function runHeartMuLa({ repo, python = 'python', modelPath, version = '3B', lazyLoad = false, scp, request, signal }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omep-heartmula-'));
  fs.writeFileSync(path.join(dir, 'lyrics.txt'), lyricsFor(scp, request));
  fs.writeFileSync(path.join(dir, 'tags.txt'), tagsFor(scp, request));
  const out = path.join(dir, 'song.wav');
  const ms = Math.round(Math.min(240, Math.max(10, scopeTimes(scp).seconds)) * 1000);
  const args = [
    path.join('examples', 'run_music_generation.py'),
    `--model_path=${modelPath ?? path.join(repo, 'ckpt')}`,
    `--version=${version}`,
    `--lyrics=${path.join(dir, 'lyrics.txt')}`,
    `--tags=${path.join(dir, 'tags.txt')}`,
    `--save_path=${out}`,
    `--max_audio_length_ms=${ms}`,
    ...(lazyLoad ? ['--lazy_load=true'] : []),
  ];
  return new Promise((resolve, reject) => {
    const p = spawn(python, args, { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.stdout.on('data', () => {});
    signal?.addEventListener('abort', () => p.kill(), { once: true });
    p.on('error', (e) => reject(new Error(`HeartMuLa could not start (${python} in ${repo}): ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(out)) return resolve({ bytes: fs.readFileSync(out), dir, ms, tags: fs.readFileSync(path.join(dir, 'tags.txt'), 'utf8') });
      const tail = err.trim().split('\n').slice(-3).join(' ');
      const hint = /out of memory/i.test(err) ? ' (set "lazy_load": true in engines.json)' : /No such file|not found|FileNotFound/i.test(err) ? ' (download the checkpoints into the clone\'s ckpt/ folder, see its README)' : '';
      reject(new Error(`HeartMuLa failed (exit ${code}): ${tail || 'no output'}${hint}`));
    });
  });
}
