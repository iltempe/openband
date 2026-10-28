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

// ---------------------------------------------------------------- Hermes Agent (issue #7)

/** Nous Research's Hermes Agent keeps its MCP servers in ~/.hermes/config.yaml, under mcp_servers. */
export function hermesClient(env = process.env) {
  const dir = env.HERMES_HOME || path.join(os.homedir(), '.hermes');
  return { id: 'hermes', name: 'Hermes Agent', file: path.join(dir, 'config.yaml'), dir };
}

// JSON strings, arrays and objects are valid YAML flow scalars: no YAML library needed for what we write.
const indentOf = (line) => /^ */.exec(line)[0].length;

/** Our entry under mcp_servers, at the given indent. */
export function hermesBlock(entry, indent = 2) {
  const pad = ' '.repeat(indent);
  const lines = [`${pad}openband:`, `${pad}${pad}command: ${JSON.stringify(String(entry.command))}`, `${pad}${pad}args: ${JSON.stringify((entry.args ?? []).map(String))}`];
  if (entry.env && Object.keys(entry.env).length) lines.push(`${pad}${pad}env: ${JSON.stringify(entry.env)}`);
  return lines;
}

/** Where mcp_servers' children sit in a config.yaml: its line, their indent, and our block's lines. */
function locate(lines) {
  const at = lines.findIndex((l) => /^mcp_servers:\s*(#.*)?$/.test(l) || /^mcp_servers:\s*\{\s*\}\s*$/.test(l));
  if (at < 0) return { at: -1 };
  let end = at + 1;
  while (end < lines.length && (lines[end].trim() === '' || lines[end].trimStart().startsWith('#') || indentOf(lines[end]) > 0)) end++;
  const children = lines.slice(at + 1, end).filter((l) => l.trim() && !l.trimStart().startsWith('#'));
  const indent = children.length ? indentOf(children[0]) : 2;
  const start = lines.findIndex((l, i) => i > at && i < end && l === `${' '.repeat(indent)}openband:`);
  let stop = start;
  if (start >= 0) {
    stop = start + 1;
    while (stop < end && (lines[stop].trim() === '' || indentOf(lines[stop]) > indent)) stop++;
    // Don't swallow blank lines that separate the next entry.
    while (stop > start + 1 && lines[stop - 1].trim() === '') stop--;
  }
  return { at, end, indent, start, stop };
}

/** OpenBand's entry in Hermes's config.yaml, if any (only the shapes this code writes are understood). */
export function readHermesEntry(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const { at, start, stop } = locate(lines);
  if (at < 0 || start < 0) return null;
  const entry = {};
  for (const l of lines.slice(start + 1, stop)) {
    const kv = /^\s+(command|args|env):\s*(.+?)\s*$/.exec(l);
    if (!kv) continue;
    try {
      entry[kv[1]] = JSON.parse(kv[2]);
    } catch {
      entry[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  return entry;
}

/** Put OpenBand in Hermes's config.yaml (replacing an older OpenBand entry), keeping a .bak. */
export function writeHermesEntry(client, entry = SERVER_ENTRY) {
  const before = fs.existsSync(client.file) ? fs.readFileSync(client.file, 'utf8') : '';
  const lines = before ? before.replace(/\n$/, '').split(/\r?\n/) : [];
  if (lines.some((l) => /^mcp_servers:\s*\{.*\S.*\}\s*$/.test(l) || /^mcp_servers:\s*\[/.test(l))) throw new Error(`${client.file}: mcp_servers is written inline; add OpenBand by hand (see docs/CONNECT.md)`);
  const loc = locate(lines);
  let out;
  if (loc.at < 0) out = [...lines, ...(lines.length && lines.at(-1).trim() ? [''] : []), 'mcp_servers:', ...hermesBlock(entry)];
  else {
    const block = hermesBlock(entry, loc.indent);
    const head = lines.slice(0, loc.at).concat(['mcp_servers:']);
    out = loc.start >= 0 ? [...head, ...lines.slice(loc.at + 1, loc.start), ...block, ...lines.slice(loc.stop)] : [...head, ...block, ...lines.slice(loc.at + 1)];
  }
  const after = `${out.join('\n')}\n`;
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
