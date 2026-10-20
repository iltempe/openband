#!/usr/bin/env node
// Builds OpenBand's CC0 loop library (public/loops/*.wav + index.json): each loop is a small song made
// with OpenBand's own instruments (the recipe below), rendered offline in headless Chrome by the
// built app, folded so it repeats seamlessly, and written as 22.05 kHz mono WAV. The audio is
// dedicated to the public domain (CC0) by the OpenBand contributors.
//   npm run build && node scripts/build-loops.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public', 'loops');
const PORT = 7788;
const SR = 22050;
const chrome = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));

// name, bpm, key, bars, tags, then the commands that make it (track 0 is the one created first).
const LOOPS = [
  ['drums-rock-120', 'Rock beat', 120, null, 2, ['drums', 'rock'], [['drums', 'kit-studio'], ['drummer', 'rock', 0.6, 0.8, 0, 7]]],
  ['drums-pop-110', 'Pop beat', 110, null, 2, ['drums', 'pop'], [['drums', 'kit-studio'], ['drummer', 'pop', 0.5, 0.7, 0, 3]]],
  ['drums-funk-100', 'Funk groove', 100, null, 2, ['drums', 'funk'], [['drums', 'kit-studio'], ['drummer', 'funk', 0.8, 0.75, 0.2, 11]]],
  ['drums-boombap-90', 'Boom-bap beat', 90, null, 2, ['drums', 'boom-bap', 'hip-hop'], [['drums', 'kit-lofi'], ['drummer', 'boom-bap', 0.6, 0.8, 0.55, 5]]],
  ['drums-trap-140', 'Trap hats and 808 kick', 140, null, 2, ['drums', 'trap'], [['drums', 'kit-808'], ['drummer', 'trap', 0.7, 0.85, 0, 9]]],
  ['drums-lofi-82', 'Lo-fi dusty beat', 82, null, 2, ['drums', 'lo-fi', 'chill'], [['drums', 'kit-lofi'], ['drummer', 'lo-fi', 0.5, 0.6, 0.6, 2]]],
  ['drums-house-124', 'House four on the floor', 124, null, 2, ['drums', 'house', 'dance'], [['drums', 'kit-studio'], ['drummer', 'house', 0.6, 0.85, 0, 4]]],
  ['drums-bossa-130', 'Bossa nova groove', 130, null, 2, ['drums', 'bossa', 'latin'], [['drums', 'kit-studio'], ['drummer', 'bossa', 0.5, 0.55, 0, 8]]],
  ['bass-lofi-cm-82', 'Lo-fi bass line', 82, 'Cm', 2, ['bass', 'lo-fi'], [['instrument', 'finger-bass'], ['notes', [['C2', 0, 1.5], ['G2', 1.5, 0.5], ['Bb2', 2, 1], ['G2', 3, 1], ['Ab1', 4, 1.5], ['Eb2', 5.5, 0.5], ['F2', 6, 1], ['G2', 7, 1]]]]],
  ['bass-house-am-124', 'Acid house bass', 124, 'Am', 2, ['bass', 'house', 'acid'], [['instrument', 'acid-bass'], ['notes', Array.from({ length: 16 }, (_, i) => [['A1', 'A2', 'A1', 'C2', 'A1', 'E2', 'A1', 'G1'][i % 8], i * 0.5, 0.4])]]],
  ['bass-funk-em-100', 'Funk slap-style bass', 100, 'Em', 2, ['bass', 'funk'], [['instrument', 'finger-bass'], ['notes', [['E2', 0, 0.25], ['E2', 0.75, 0.25], ['G2', 1.5, 0.25], ['A2', 2, 0.5], ['E2', 3, 0.25], ['D3', 3.5, 0.25], ['E2', 4, 0.25], ['B2', 4.75, 0.25], ['A2', 5.5, 0.25], ['G2', 6, 0.5], ['E2', 7, 0.25], ['G2', 7.5, 0.5]]]]],
  ['keys-lofi-cm-82', 'Lo-fi electric piano chords', 82, 'Cm', 2, ['keys', 'lo-fi', 'chords'], [['instrument', 'velvet-keys'], ['chords', ['Cm9', 'Abmaj7'], 4]]],
  ['keys-pop-c-110', 'Pop piano chords', 110, 'C', 2, ['keys', 'pop', 'piano', 'chords'], [['instrument', 'felt-piano'], ['chords', ['C', 'G', 'Am', 'F'], 2]]],
  ['keys-ballad-g-72', 'Ballad piano', 72, 'G', 2, ['keys', 'ballad', 'piano', 'chords'], [['instrument', 'felt-piano'], ['chords', ['G', 'Em7', 'Cmaj7', 'D'], 2]]],
  ['pad-ambient-dm-90', 'Ambient pad', 90, 'Dm', 2, ['pad', 'ambient', 'chords'], [['instrument', 'aurora-pad'], ['chords', ['Dm9', 'Bbmaj7'], 4]]],
  ['lead-chip-am-120', '8-bit arpeggio', 120, 'Am', 2, ['lead', 'chiptune', 'arpeggio'], [['instrument', 'chip'], ['notes', Array.from({ length: 16 }, (_, i) => [['A4', 'C5', 'E5', 'A5', 'F4', 'A4', 'C5', 'F5'][i % 8], i * 0.5, 0.45])]]],
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn(process.execPath, [path.join(root, 'bin', 'openband.mjs'), 'start'], { env: { ...process.env, OPENBAND_PORT: String(PORT), OPENBAND_OPEN_BROWSER: '0', OPENBAND_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise((r) => srv.stderr.on('data', (d) => String(d).includes('bridge on') && r()));
const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
fs.mkdirSync(dir, { recursive: true });
const manifest = { version: 1, loops: [] };
try {
  const p = await b.newPage();
  await p.goto(`http://127.0.0.1:${PORT}/?debug&mcp=1`, { waitUntil: 'networkidle0' });
  await p.evaluate(() => document.querySelector('.welcome-choice')?.click());
  await wait(1500);
  for (const [id, name, bpm, key, bars, tags, recipe] of LOOPS) {
    const pcm = await p.evaluate(async (bpm, key, bars, recipe, SR) => {
      const { commands, useStore, renderBuffer } = window.openband;
      commands.new_project({ name: 'loop', bpm, key: key ?? 'C' });
      let track;
      for (const step of recipe) {
        if (step[0] === 'drums' || step[0] === 'instrument') track = (await commands.add_track({ kind: step[0] === 'drums' ? 'drums' : 'instrument', instrument: step[1] })).track_id;
        else if (step[0] === 'drummer') await commands.add_drummer({ track_id: track, from_bar: 1, to_bar: bars, style: step[1], complexity: step[2], loudness: step[3], swing: step[4], fills: 'none', seed: step[5] });
        else if (step[0] === 'notes') await commands.add_region({ track_id: track, start_bar: 1, length_bars: bars, notes: step[1].map(([pitch, start, duration]) => ({ pitch, start, duration, velocity: 0.8 })) });
        else if (step[0] === 'chords') await commands.add_chord_progression({ track_id: track, start_bar: 1, chords: step[1], beats_per_chord: step[2] });
      }
      await commands.update_track({ track_id: track, reverb: 0.12, delay: 0, volume: 0.8 });
      const buf = await renderBuffer(useStore.getState().project, { fromBeat: 0, toBeat: bars * 4, tailSeconds: 2, sampleRate: SR });
      // Mono, and the tail (reverb, releases) folded back onto the start: the loop repeats seamlessly.
      const len = Math.round(((bars * 4 * 60) / bpm) * SR);
      const out = new Float32Array(len);
      const L = buf.getChannelData(0);
      const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
      for (let i = 0; i < buf.length; i++) out[i % len] += (L[i] + R[i]) / 2;
      let peak = 0;
      for (const v of out) peak = Math.max(peak, Math.abs(v));
      const g = peak > 0 ? 0.9 / peak : 1;
      return Array.from(out, (v) => Math.round(v * g * 32767));
    }, bpm, key, bars, recipe, SR);
    const data = Buffer.alloc(pcm.length * 2);
    pcm.forEach((v, i) => data.writeInt16LE(Math.max(-32767, Math.min(32767, v)), i * 2));
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    fs.writeFileSync(path.join(dir, `${id}.wav`), Buffer.concat([h, data]));
    manifest.loops.push({ id, name, bpm, ...(key ? { key } : {}), bars, tags, license: 'CC0', author: 'OpenBand contributors', url: `loops/${id}.wav`, source: `Made with OpenBand's own instruments by scripts/build-loops.mjs (recipe "${id}")` });
    console.log(`${id}.wav  ${(data.length / 1024).toFixed(0)} kB`);
  }
} finally {
  await b.close();
  srv.kill();
}
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'LICENSE.txt'), 'The audio files in this folder were made by the OpenBand contributors with OpenBand (scripts/build-loops.mjs)\nand are dedicated to the public domain under CC0 1.0 Universal:\nhttps://creativecommons.org/publicdomain/zero/1.0/\n\nYou can copy, modify and use them, also commercially, without asking permission or giving credit.\n');
console.log(`index.json: ${manifest.loops.length} loops`);
