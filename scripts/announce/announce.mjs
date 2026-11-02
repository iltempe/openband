#!/usr/bin/env node
// After a release: a Telegram message with the link and what's new, and a 9:16 video of it.
//   node scripts/announce/announce.mjs <version> [--notes file.json] [--dry-run]
// notes: { "title": "...", "points": ["..."] }, written for people. Default: the CHANGELOG's section.
// Telegram: ~/.openband/telegram.json { "token": "...", "chat_id": "..." }, or OPENBAND_TELEGRAM_TOKEN and _CHAT.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromChangelog, releaseUrl, telegramMessage } from './notes.mjs';
import { CONFIG, readConfig, sendMessage, sendVideo } from './telegram.mjs';
import { renderVideo } from './video.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--') && /^\d/.test(a));
if (!version) {
  console.error('usage: announce.mjs <version> [--notes file.json] [--dry-run]');
  process.exit(2);
}
const notesAt = args.indexOf('--notes');
const notes = notesAt >= 0 ? JSON.parse(fs.readFileSync(args[notesAt + 1], 'utf8')) : fromChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
const dry = args.includes('--dry-run');
const out = path.join(root, 'build', 'announce', `openband-v${version}-9x16.mp4`);

const html = telegramMessage({ version, ...notes });
const video = await renderVideo({ version, title: notes.title, points: notes.points, out });
console.log(`✓ video ${video.size}, ${video.seconds} s, ${(video.bytes / 1e6).toFixed(1)} MB: ${video.file}`);
console.log(`✓ link ${releaseUrl(version)}`);
if (dry) {
  console.log(`--- message\n${html}`);
  process.exit(0);
}
const cfg = readConfig();
if (!cfg) {
  console.error(`✗ Telegram is not set up: nothing was sent. Create ${CONFIG} with { "token": "...", "chat_id": "..." }.`);
  process.exit(3);
}
await sendMessage(cfg, html);
await sendVideo(cfg, video.file, `<b>OpenBand v${version}</b> · ${notes.title}`);
console.log('✓ sent on Telegram: the message and the video');
