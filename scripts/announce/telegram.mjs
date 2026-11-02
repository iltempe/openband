// Telegram's Bot API, with nothing but fetch. The token never reaches a log, an error message or the repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG = path.join(os.homedir(), '.openband', 'telegram.json');

export function readConfig(env = process.env, file = CONFIG) {
  if (env.OPENBAND_TELEGRAM_TOKEN && env.OPENBAND_TELEGRAM_CHAT) return { token: env.OPENBAND_TELEGRAM_TOKEN, chat: env.OPENBAND_TELEGRAM_CHAT };
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return c.token && c.chat_id ? { token: c.token, chat: String(c.chat_id) } : null;
  } catch {
    return null;
  }
}

async function call(cfg, method, body, fetcher) {
  const r = await fetcher(`https://api.telegram.org/bot${cfg.token}/${method}`, { method: 'POST', ...body });
  const j = await r.json().catch(() => ({}));
  // Telegram's description, never the URL: the URL holds the token.
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? r.status}`);
  return j.result;
}

export const sendMessage = (cfg, html, fetcher = fetch) => call(cfg, 'sendMessage', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: cfg.chat, text: html, parse_mode: 'HTML', disable_web_page_preview: false }) }, fetcher);

export function sendVideo(cfg, file, caption, fetcher = fetch) {
  const form = new FormData();
  form.set('chat_id', cfg.chat);
  form.set('caption', caption.slice(0, 1024));
  form.set('parse_mode', 'HTML');
  form.set('width', '1080');
  form.set('height', '1920');
  form.set('supports_streaming', 'true');
  form.set('video', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), path.basename(file));
  return call(cfg, 'sendVideo', { body: form }, fetcher);
}
