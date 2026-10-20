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
  ];
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
export function writeEntry(client) {
  const config = readConfig(client.file);
  const before = JSON.stringify(openbandEntry(config, client.key));
  config[client.key] = { ...(config[client.key] ?? {}), openband: client.id === 'vscode' ? { type: 'stdio', ...SERVER_ENTRY } : SERVER_ENTRY };
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
