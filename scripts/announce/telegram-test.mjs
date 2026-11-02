#!/usr/bin/env node
// Try the Telegram setup: node scripts/announce/telegram-test.mjs
// With only a token in ~/.openband/telegram.json it finds your chat_id (send the bot a message first) and saves it.
// With both, it sends a test message and the newest video in build/announce/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, readConfig, sendMessage, sendVideo } from './telegram.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stop = (m) => (console.error(`✗ ${m}`), process.exit(1));

let raw;
try {
  raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
} catch {
  stop(`${CONFIG} is missing or not valid JSON. It needs { "token": "..." }.`);
}
if (!raw.token) stop(`${CONFIG} has no token.`);
if (raw.chat_id && String(raw.chat_id) === raw.token.split(':')[0]) stop('chat_id is the bot\'s own id, the first part of the token. It must be yours: ask @userinfobot on Telegram.');
fs.chmodSync(CONFIG, 0o600);

if (!raw.chat_id) {
  const r = await fetch(`https://api.telegram.org/bot${raw.token}/getUpdates`);
  const j = await r.json().catch(() => ({}));
  if (!j.ok) stop(`Telegram refused the token: ${j.description ?? r.status}`);
  const chat = j.result?.map((u) => u.message?.chat ?? u.my_chat_member?.chat).filter(Boolean).at(-1);
  if (!chat) stop('The bot has no messages yet: open it in Telegram, send it anything, and run this again.');
  fs.writeFileSync(CONFIG, `${JSON.stringify({ ...raw, chat_id: chat.id }, null, 2)}\n`, { mode: 0o600 });
  console.log(`✓ chat found (${chat.title ?? chat.first_name ?? chat.id}) and saved`);
}

const cfg = readConfig();
await sendMessage(cfg, '<b>OpenBand</b>\nProva: il bot funziona. ✓');
console.log('✓ message sent');
const dir = path.join(root, 'build', 'announce');
const video = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] : null;
if (!video) {
  console.log('No video to send yet.');
  process.exit(0);
}
await sendVideo(cfg, video, '<b>OpenBand</b> · video di prova');
console.log(`✓ video sent (${path.basename(video)})`);
