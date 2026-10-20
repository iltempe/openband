#!/usr/bin/env node
// Builds the DAWproject test fixtures (src/__fixtures__/dawproject/*.dawproject) from the hand-written
// project.xml files next to them, adding metadata.xml and short generated WAV files for the audio clips.
//   node scripts/build-dawproject-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', '__fixtures__', 'dawproject');

/** A mono/stereo 16-bit WAV: a short decaying tone, then silence (stands in for the real recording, and zips small). */
function wav(seconds, rate, channels, freq) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * channels * 2);
  for (let i = 0; i < n; i++) {
    const v = i < rate * 0.05 ? Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * Math.exp((-60 * i) / rate) * 12000) : 0;
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([h, data]));
}

const fixtures = {
  'bitwig-5': { title: 'Bitwig demo', audio: { 'audio/Drumfunk3 170bpm.wav': wav(2.8235, 48000, 2, 110) } },
  'studio-one-6': { title: 'Studio One demo', audio: { 'Media/lead vocal.wav': wav(3, 44100, 1, 220) } },
};
for (const [name, f] of Object.entries(fixtures)) {
  const xml = fs.readFileSync(path.join(dir, `${name}.project.xml`));
  const meta = `<?xml version="1.0" encoding="UTF-8"?>\n<MetaData>\n  <Title>${f.title}</Title>\n</MetaData>\n`;
  const zip = zipSync({ 'project.xml': new Uint8Array(xml), 'metadata.xml': strToU8(meta), ...f.audio }, { level: 9, mtime: new Date('2026-10-20T00:00:00Z') });
  fs.writeFileSync(path.join(dir, `${name}.dawproject`), zip);
  console.log(`${name}.dawproject: ${zip.length} bytes`);
}
