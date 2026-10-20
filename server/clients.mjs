// Where MCP clients keep their configuration, and how OpenBand is added to it. Shared by setup and doctor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { SERVER_ENTRY } from './package.mjs';

/** The entry every client gets (no absolute paths): see server/package.mjs. */
export { SERVER_ENTRY };

function appData() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** JSON-file clients: { name, file, key } where key is the object holding the servers. */
export function jsonClients() {
  return [
    { id: 'claude-desktop', name: 'Claude Desktop', file: path.join(appData(), 'Claude', 'claude_desktop_config.json'), key: 'mcpServers', dir: path.join(appData(), 'Claude') },
    { id: 'cursor', name: 'Cursor', file: path.join(os.homedir(), '.cursor', 'mcp.json'), key: 'mcpServers', dir: path.join(os.homedir(), '.cursor') },
    { id: 'vscode', name: 'VS Code', file: path.join(appData(), 'Code', 'User', 'mcp.json'), key: 'servers', dir: path.join(appData(), 'Code', 'User') },
    { id: 'gemini-cli', name: 'Gemini CLI', file: path.join(os.homedir(), '.gemini', 'settings.json'), key: 'mcpServers', dir: path.join(os.homedir(), '.gemini') },
  ];
}

/** OpenAI's Codex (CLI and IDE extension) keeps its MCP servers in TOML. */
export function codexClient(env = process.env) {
  const dir = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return { id: 'codex', name: 'Codex (OpenAI)', file: path.join(dir, 'config.toml'), dir };
}

const TABLE = 'mcp_servers.openband';
const tomlString = (v) => JSON.stringify(String(v)); // a JSON string is a valid TOML basic string
const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

/** Our table, as TOML lines. */
export function codexTable(entry) {
  const lines = [`[${TABLE}]`, `command = ${tomlString(entry.command)}`, `args = [${(entry.args ?? []).map(tomlString).join(', ')}]`];
  const env = Object.entries(entry.env ?? {});
  if (env.length) lines.push(`env = { ${env.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(', ')} }`);
  return lines.join('\n');
}

/** Split a config.toml into the lines of our table (and its sub-tables) and everything else. */
function splitToml(text) {
  const mine = [];
  const rest = [];
  let inMine = false;
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (h) inMine = h[1].trim() === TABLE || h[1].trim().startsWith(`${TABLE}.`);
    (inMine ? mine : rest).push(line);
  }
  return { mine, rest };
}

/** OpenBand's entry in Codex's config.toml, if any (only the shapes this code writes are understood). */
export function readCodexEntry(file) {
  if (!fs.existsSync(file)) return null;
  const { mine } = splitToml(fs.readFileSync(file, 'utf8'));
  if (!mine.length) return null;
  const entry = {};
  let sub = null;
  for (const line of mine) {
    const h = /^\s*\[([^\]]+)\]/.exec(line);
    if (h) {
      sub = h[1].trim() === `${TABLE}.env` ? 'env' : null;
      continue;
    }
    const kv = /^\s*([A-Za-z0-9_"-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, '');
    try {
      if (sub === 'env') (entry.env ??= {})[key] = JSON.parse(kv[2]);
      else if (key === 'env') entry.env = Object.fromEntries([...kv[2].matchAll(/([A-Za-z0-9_-]+|"[^"]+")\s*=\s*("(?:[^"\\]|\\.)*")/g)].map((m) => [m[1].replace(/"/g, ''), JSON.parse(m[2])]));
      else entry[key] = JSON.parse(kv[2]);
    } catch {
      entry[key] = kv[2];
    }
  }
  return entry;
}

/** Put OpenBand in Codex's config.toml (replacing an older OpenBand table), keeping a .bak. */
export function writeCodexEntry(client, entry = SERVER_ENTRY) {
  const before = fs.existsSync(client.file) ? fs.readFileSync(client.file, 'utf8') : '';
  const { rest } = splitToml(before);
  while (rest.length && rest[rest.length - 1].trim() === '') rest.pop();
  const after = `${rest.length ? `${rest.join('\n')}\n\n` : ''}${codexTable(entry)}\n`;
  if (after === before) return { changed: false };
  fs.mkdirSync(path.dirname(client.file), { recursive: true });
  let backup = null;
  if (before) {
    backup = `${client.file}.bak`;
    fs.writeFileSync(backup, before);
  }
  fs.writeFileSync(client.file, after);
  return { changed: true, backup };
}

export const hasCommand = (bin) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
  return r.status === 0;
};

/** Read a client's config (missing file = empty config). Throws on invalid JSON. */
export function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

/** The OpenBand entry of a config, if any. */
export const openbandEntry = (config, key) => config?.[key]?.openband ?? null;

/** Add OpenBand to a client config, keeping a .bak of the original. Returns what changed. */
export function writeEntry(client, entry = SERVER_ENTRY) {
  const config = readConfig(client.file);
  const before = JSON.stringify(openbandEntry(config, client.key));
  config[client.key] = { ...(config[client.key] ?? {}), openband: client.id === 'vscode' ? { type: 'stdio', ...entry } : entry };
  if (before === JSON.stringify(config[client.key].openband)) return { changed: false };
  fs.mkdirSync(path.dirname(client.file), { recursive: true });
  let backup = null;
  if (fs.existsSync(client.file)) {
    backup = `${client.file}.bak`;
    fs.copyFileSync(client.file, backup);
  }
  fs.writeFileSync(client.file, JSON.stringify(config, null, 2) + '\n');
  return { changed: true, backup };
}
