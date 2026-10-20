// openband setup: add OpenBand to the MCP clients installed on this computer, after asking.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { SERVER_ENTRY, codexClient, hasCommand, jsonClients, openbandEntry, readCodexEntry, readConfig, writeCodexEntry, writeEntry } from './clients.mjs';

export async function setup(args = []) {
  const yes = args.includes('--yes') || args.includes('-y');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (q) => (yes ? true : /^(y|yes|s|si|sì|)$/i.test((await rl.question(`${q} [Y/n] `)).trim()));
  const found = [];
  try {
    for (const c of jsonClients()) {
      if (!fs.existsSync(c.dir)) continue;
      found.push(c.name);
      let config;
      try {
        config = readConfig(c.file);
      } catch {
        console.error(`✗ ${c.name}: ${c.file} is not valid JSON — fix it first, nothing was changed.`);
        continue;
      }
      if (JSON.stringify(openbandEntry(config, c.key)) === JSON.stringify(c.id === 'vscode' ? { type: 'stdio', ...SERVER_ENTRY } : SERVER_ENTRY)) {
        console.error(`✓ ${c.name}: already set up.`);
        continue;
      }
      if (!(await ask(`Add OpenBand to ${c.name} (${c.file})?`))) continue;
      const r = writeEntry(c);
      console.error(`✓ ${c.name}: added${r.backup ? ` (backup: ${r.backup})` : ''}.${c.id === 'claude-desktop' ? ' Restart Claude Desktop.' : ''}`);
    }
    const codex = codexClient();
    if (fs.existsSync(codex.dir)) {
      found.push(codex.name);
      if (JSON.stringify(readCodexEntry(codex.file)) === JSON.stringify(SERVER_ENTRY)) console.error(`✓ ${codex.name}: already set up.`);
      else if (await ask(`Add OpenBand to ${codex.name} (${codex.file})?`)) {
        const r = writeCodexEntry(codex);
        console.error(`✓ ${codex.name}: added${r.backup ? ` (backup: ${r.backup})` : ''}.`);
      }
    }
    if (hasCommand('claude')) {
      found.push('Claude Code');
      if (await ask('Add OpenBand to Claude Code (claude mcp add)?')) {
        const r = spawnSync('claude', ['mcp', 'add', 'openband', '--', SERVER_ENTRY.command, ...SERVER_ENTRY.args], { stdio: 'inherit', shell: process.platform === 'win32' });
        console.error(r.status === 0 ? '✓ Claude Code: added.' : '✗ Claude Code: "claude mcp add" failed (is it already added? see "claude mcp list").');
      }
    }
  } finally {
    rl.close();
  }
  if (!found.length) {
    console.error('No MCP client found. Add this to your client\'s MCP configuration:\n');
    console.error(JSON.stringify({ mcpServers: { openband: SERVER_ENTRY } }, null, 2));
  }
}
