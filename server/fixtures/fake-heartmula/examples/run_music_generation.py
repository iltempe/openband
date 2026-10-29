// A stand-in for heartlib's examples/run_music_generation.py, in JavaScript (the tests' "python" is node).
// It parses the same arguments, reads lyrics and tags from their files, keeps a copy of what it got
// (FAKE_HM_LOG) and writes a 48 kHz WAV as long as --max_audio_length_ms, at the "<n> bpm" and in the "<key> major|minor" of the tags.
// "oom" in the tags fails like CUDA running out of memory.
const fs = require('node:fs');
const path = require('node:path');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
for (const k of ['model_path', 'lyrics', 'tags', 'save_path']) if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
const lyrics = fs.existsSync(args.lyrics) ? fs.readFileSync(args.lyrics, 'utf8') : args.lyrics;
const tags = fs.existsSync(args.tags) ? fs.readFileSync(args.tags, 'utf8') : args.tags;
if (process.env.FAKE_HM_LOG) fs.writeFileSync(process.env.FAKE_HM_LOG, JSON.stringify({ args, lyrics, tags, cwd: process.cwd() }));
if (/oom/.test(tags)) { console.error('torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB'); process.exit(1); }
const sr = 48000;
const n = Math.round((Number(args.max_audio_length_ms ?? 120000) / 1000) * sr);
const bpm = Number(/(\d+) bpm/.exec(tags)?.[1] ?? 120);
const beat = Math.round((60 / bpm) * sr);
const NAMES = { c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, f: 5, 'f#': 6, gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11 };
const key = /\b([a-g][#b]?) (major|minor)\b/.exec(tags);
const root = key ? NAMES[key[1]] : 0;
const freqs = [0, key && key[2] === 'minor' ? 3 : 4, 7].map((st) => 440 * 2 ** ((60 + root + st - 69) / 12));
const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) {
  const t = (i % beat) / sr;
  const v = 0.3 * Math.exp(-t * 6) * freqs.reduce((a, f) => a + Math.sin((2 * Math.PI * f * i) / sr), 0) / 3;
  buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
}
fs.mkdirSync(path.dirname(args.save_path), { recursive: true });
fs.writeFileSync(args.save_path, buf);
console.log(`Generated music saved to ${args.save_path}`);
