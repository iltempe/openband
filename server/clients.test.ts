import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexClient, codexTable, jsonClients, readCodexEntry, writeCodexEntry } from './clients.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ob-clients-'));

describe('MCP clients beyond Claude', () => {
  it('knows Gemini CLI (JSON) and Codex (TOML, honouring CODEX_HOME)', () => {
    expect(jsonClients().find((c) => c.id === 'gemini-cli')).toMatchObject({ key: 'mcpServers', file: path.join(os.homedir(), '.gemini', 'settings.json') });
    expect(codexClient({ CODEX_HOME: '/x/codex' }).file).toBe(path.join('/x/codex', 'config.toml'));
  });

  it('writes its own Codex table, keeps the rest of config.toml, replaces an older OpenBand table', () => {
    const dir = tmp();
    const c = { id: 'codex', name: 'Codex', dir, file: path.join(dir, 'config.toml') };
    const original = '# my settings\nmodel = "gpt-6.1-sol"\n\n[mcp_servers.openband]\ncommand = "npx"\nargs = ["-y", "openband", "mcp"]\n\n[mcp_servers.openband.env]\nX = "1"\n\n[mcp_servers.other]\ncommand = "other"\n';
    fs.writeFileSync(c.file, original);
    expect(readCodexEntry(c.file)).toEqual({ command: 'npx', args: ['-y', 'openband', 'mcp'], env: { X: '1' } });
    const entry = { command: 'C:\\Program Files\\OpenBand\\OpenBand.exe', args: ['C:\\Program Files\\OpenBand\\resources\\app\\server\\mcp-server.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', OPENBAND_APP: 'C:\\Program Files\\OpenBand\\OpenBand.exe' } };
    expect(writeCodexEntry(c, entry)).toEqual({ changed: true, backup: `${c.file}.bak` });
    const after = fs.readFileSync(c.file, 'utf8');
    expect(after).toContain('# my settings\nmodel = "gpt-6.1-sol"');
    expect(after).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(after.match(/\[mcp_servers\.openband/g)).toHaveLength(1);
    expect(after.endsWith(`${codexTable(entry)}\n`)).toBe(true);
    expect(readCodexEntry(c.file)).toEqual(entry); // Windows backslashes survive
    expect(fs.readFileSync(`${c.file}.bak`, 'utf8')).toBe(original);
    expect(writeCodexEntry(c, entry)).toEqual({ changed: false });
  });

  it('creates config.toml when Codex has none yet', () => {
    const dir = tmp();
    const c = { id: 'codex', name: 'Codex', dir: path.join(dir, '.codex'), file: path.join(dir, '.codex', 'config.toml') };
    expect(readCodexEntry(c.file)).toBeNull();
    writeCodexEntry(c, { command: 'npx', args: ['-y', 'x', 'mcp'] });
    expect(fs.readFileSync(c.file, 'utf8')).toBe('[mcp_servers.openband]\ncommand = "npx"\nargs = ["-y", "x", "mcp"]\n');
  });
});
