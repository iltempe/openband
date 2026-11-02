// The Box's settings, in <data>/box.json, and what the command line adds to them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BOX_DEFAULTS = { device: 'default', channels: 2, names: [], project: 'Sala prove', projectId: null, threshold: -42, endMs: 90000, port: 7777, keep: { sessions: 50 }, pin: null, armed: true, gpio: null, midi: null };

export const dataDir = (env = process.env) => env.OPENBAND_DATA || (process.platform === 'linux' && fs.existsSync('/var/lib/openband') ? '/var/lib/openband' : path.join(os.homedir(), '.openband', 'box'));

export function readBox(dir) {
  try {
    return { ...BOX_DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(dir, 'box.json'), 'utf8')) };
  } catch {
    return { ...BOX_DEFAULTS };
  }
}

export function writeBox(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'box.json'), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

export const newPin = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** --device hw:1 --channels 1-8 --names "Voce,Chitarra" --project "…" --threshold -42 --data <dir> --port 7777 --pin 123456 */
export function parseArgs(args) {
  const out = { sub: null, flags: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      out.sub ??= a;
      continue;
    }
    const [k, inline] = a.slice(2).split('=');
    const next = inline ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
    out.flags[k] = next;
  }
  return out;
}

export function applyFlags(cfg, f) {
  const next = { ...cfg };
  if (f.device) next.device = String(f.device);
  if (f.channels) {
    const c = Number(String(f.channels).split('-').pop());
    if (!(c >= 1 && c <= 32)) throw new Error('--channels: a number from 1 to 32');
    next.channels = c;
  }
  if (f.names) next.names = String(f.names).split(',').map((s) => s.trim());
  if (f.project) next.project = String(f.project);
  if (f.threshold !== undefined) next.threshold = Number(f.threshold);
  if (f.port) next.port = Number(f.port);
  if (f.tunnel) next.tunnel = String(f.tunnel);
  if (typeof f.pin === 'string') next.pin = f.pin.replace(/\D/g, '').padStart(6, '0').slice(-6);
  return next;
}

/** The oldest sessions go first; ⭐ never. `sessions`: [{ id, at, bytes, starred }]. */
export function toForget(sessions, keep) {
  const old = [...sessions].sort((a, b) => a.at - b.at);
  const out = [];
  if (keep?.sessions) {
    let extra = sessions.length - keep.sessions;
    for (const s of old) if (extra > 0 && !s.starred) (out.push(s), extra--);
  }
  if (keep?.gb) {
    let total = sessions.reduce((n, s) => n + s.bytes, 0);
    const limit = keep.gb * 1e9;
    for (const s of old) if (total > limit && !s.starred && !out.includes(s)) (out.push(s), (total -= s.bytes));
  }
  return out;
}
