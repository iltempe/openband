// The desktop app as an MCP server: AI clients launch the app's own executable in Node mode
// (ELECTRON_RUN_AS_NODE) on the server bundled inside it, so nothing else has to be installed, and
// OPENBAND_APP tells that server to open the studio in the app instead of a browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codexClient, hermesClient, jsonClients, openbandEntry, readCodexEntry, readConfig, readHermesEntry, writeCodexEntry, writeEntry, writeHermesEntry } from './clients.mjs';

/** The MCP entry for the app at `exe`, whose files (server/, dist/) are in `root`. */
export function desktopEntry({ exe, root }) {
  return { command: exe, args: [path.join(root, 'server', 'mcp-server.mjs')], env: { ELECTRON_RUN_AS_NODE: '1', OPENBAND_APP: exe } };
}

/** Where `claude` may be when the app was started from the Dock / Start menu (a GUI app has a short PATH). */
export function findClaudeCli(env = process.env) {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = [...String(env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.npm-global', 'bin'), env.APPDATA ? path.join(env.APPDATA, 'npm') : ''];
  for (const d of dirs.filter(Boolean)) {
    for (const name of process.platform === 'win32' ? [exe, 'claude.cmd'] : [exe]) {
      const p = path.join(d, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Add the app to every MCP client found on this computer (the user asked, by clicking): Claude Desktop,
 * Cursor and VS Code through their JSON files (a .bak of each is kept), Claude Code through its CLI.
 * Returns one line per client.
 */
export function connectClients(entry, { clients = jsonClients(), codex = codexClient(), hermes = hermesClient(), claude = findClaudeCli(), run = spawnSync } = {}) {
  const out = [];
  for (const c of clients) {
    if (!fs.existsSync(c.dir)) {
      out.push({ name: c.name, status: 'missing' });
      continue;
    }
    try {
      const want = c.id === 'vscode' ? { type: 'stdio', ...entry } : entry;
      if (JSON.stringify(openbandEntry(readConfig(c.file), c.key)) === JSON.stringify(want)) {
        out.push({ name: c.name, status: 'already' });
        continue;
      }
      const r = writeEntry(c, entry);
      out.push({ name: c.name, status: 'added', detail: c.id === 'claude-desktop' ? 'restart' : r.backup ? `backup: ${r.backup}` : undefined });
    } catch (e) {
      out.push({ name: c.name, status: 'failed', detail: e instanceof SyntaxError ? `${c.file} is not valid JSON` : e.message });
    }
  }
  if (!codex || !fs.existsSync(codex.dir)) out.push({ name: codex?.name ?? 'Codex (OpenAI)', status: 'missing' });
  else {
    try {
      if (JSON.stringify(readCodexEntry(codex.file)) === JSON.stringify(entry)) out.push({ name: codex.name, status: 'already' });
      else {
        const r = writeCodexEntry(codex, entry);
        out.push({ name: codex.name, status: 'added', detail: r.backup ? `backup: ${r.backup}` : undefined });
      }
    } catch (e) {
      out.push({ name: codex.name, status: 'failed', detail: e.message });
    }
  }
  // Hermes Agent (issue #7): its config.yaml.
  if (!hermes || !fs.existsSync(hermes.dir)) out.push({ name: hermes?.name ?? 'Hermes Agent', status: 'missing' });
  else {
    try {
      if (JSON.stringify(readHermesEntry(hermes.file)) === JSON.stringify(entry)) out.push({ name: hermes.name, status: 'already' });
      else {
        const r = writeHermesEntry(hermes, entry);
        out.push({ name: hermes.name, status: 'added', detail: r.backup ? `backup: ${r.backup}; /reload-mcp in Hermes` : '/reload-mcp in Hermes' });
      }
    } catch (e) {
      out.push({ name: hermes.name, status: 'failed', detail: e.message });
    }
  }
  if (!claude) out.push({ name: 'Claude Code', status: 'missing' });
  else {
    const opts = { stdio: 'ignore', shell: process.platform === 'win32', timeout: 20000 };
    // Replace whatever "openband" was there (an npx install, an older app path) in the user scope.
    run(claude, ['mcp', 'remove', 'openband', '-s', 'user'], opts);
    const envArgs = Object.entries(entry.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const r = run(claude, ['mcp', 'add', 'openband', '-s', 'user', ...envArgs, '--', entry.command, ...entry.args], opts);
    out.push(r.status === 0 ? { name: 'Claude Code', status: 'added' } : { name: 'Claude Code', status: 'failed', detail: '"claude mcp add" failed' });
  }
  return out;
}
