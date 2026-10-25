#!/usr/bin/env node
// G4 acceptance, locally (macOS): how many spoken commands Vosk + OpenBand's grammar get right.
//   node scripts/voice-accuracy/run.mjs <folder with it.zip and en.zip — the official Vosk small models>
// It speaks every command of the spec with several macOS voices (say), runs the studio's own grammar and
// model loader (repacking the zips, checking their SHA-256) with vosk-browser in Chrome, and counts a
// phrase as right when what was heard means the same command as what was said.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const models = process.argv[2];
if (!models) {
  console.error('usage: node scripts/voice-accuracy/run.mjs <folder with it.zip and en.zip>');
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-voice-acc-'));
const PHRASES = {
  it: ['registra', 'stop', 'ancora', 'riascolta', 'dal ritornello', 'dalla battuta nove', 'loop sul ritornello', 'punch dalla nove alla dodici', 'segna errore', 'buona questa', 'tieni questa', "cancella l'ultima take", 'metronomo più forte', 'metronomo via', 'più lento', 'tempo novanta', 'più me in cuffia', 'meno basi', 'annulla', 'basta così'],
  en: ['record', 'stop', 'again', 'play back', 'from the chorus', 'from bar nine', 'loop the chorus', 'punch from nine to twelve', 'mark error', 'good one', 'keep this one', 'delete the last take', 'metronome louder', 'metronome off', 'slower', 'tempo ninety', 'more me', 'less track', 'undo', "that's enough"],
};
const VOICES = { it: ['Alice', 'Eddy (Italiano (Italia))', 'Flo (Italiano (Italia))'], en: ['Samantha', 'Daniel', 'Eddy (Inglese (USA))'] };
const list = [];
for (const lang of ['it', 'en'])
  VOICES[lang].forEach((v, vi) =>
    PHRASES[lang].forEach((p, i) => {
      const file = `${lang}-${vi}-${i}.wav`;
      execFileSync('say', ['-v', v, '-o', path.join(work, file), '--data-format=LEI16@16000', p]);
      list.push({ file, lang, text: p, voice: v });
    }),
  );
fs.writeFileSync(path.join(work, 'list.json'), JSON.stringify(list));
// The studio's own grammar and model loader, bundled for the page.
execFileSync(process.execPath, [path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), path.join(root, 'src/voice/grammar.ts'), path.join(root, 'src/voice/models.ts'), '--bundle', '--format=esm', `--outdir=${work}`, '--log-level=warning']);
fs.copyFileSync(path.join(root, 'node_modules/vosk-browser/dist/vosk.js'), path.join(work, 'vosk.js'));
for (const l of ['it', 'en']) fs.copyFileSync(path.join(models, `${l}.zip`), path.join(work, `${l}.zip`));
fs.copyFileSync(path.join(here, 'page.html'), path.join(work, 'index.html'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wav': 'audio/wav', '.zip': 'application/zip' };
const srv = http.createServer((q, r) => {
  const f = path.join(work, decodeURIComponent(q.url.split('?')[0]));
  if (!fs.existsSync(f)) return r.writeHead(404).end();
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const b = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, protocolTimeout: 900000 });
let right = 0;
try {
  const p = await b.newPage();
  await p.goto(`${base}/index.html`);
  for (const lang of ['it', 'en']) {
    const zip = fs.readFileSync(path.join(work, `${lang}.zip`));
    const src = { name: lang, url: `${base}/${lang}.zip`, sha256: crypto.createHash('sha256').update(zip).digest('hex'), bytes: zip.length };
    const r = await p.evaluate((l, s) => window.run(l, s), lang, src);
    const ok = r.filter((x) => x.ok).length;
    right += ok;
    console.log(`${lang}: ${ok}/${r.length} (${Math.round((100 * ok) / r.length)} %)`);
    for (const x of r.filter((x) => !x.ok)) console.log(`   ✗ "${x.text}" (${x.voice}) → "${x.heard}"`);
  }
} finally {
  await b.close();
  srv.close();
}
console.log(`total: ${right}/${list.length} (${Math.round((100 * right) / list.length)} %; the spec asks ≥ 95 %)`);
process.exit(right / list.length >= 0.95 ? 0 : 1);
