import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectClients, desktopEntry } from './desktop.mjs';

const exe = '/Applications/OpenBand.app/Contents/MacOS/OpenBand';
const root = '/Applications/OpenBand.app/Contents/Resources/app';

describe('desktop app as an MCP server', () => {
  it('runs the bundled server with the app itself in Node mode, and opens the studio in the app', () => {
    expect(desktopEntry({ exe, root })).toEqual({
      command: exe,
      args: [path.join(root, 'server', 'mcp-server.mjs')],
      env: { ELECTRON_RUN_AS_NODE: '1', OPENBAND_APP: exe },
    });
  });

  it('adds itself to the clients found, keeps a backup, and adds Claude Code through its CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-desk-'));
    const desk = { id: 'claude-desktop', name: 'Claude Desktop', dir, file: path.join(dir, 'claude_desktop_config.json'), key: 'mcpServers' };
    const code = { id: 'vscode', name: 'VS Code', dir, file: path.join(dir, 'mcp.json'), key: 'servers' };
    const absent = { id: 'cursor', name: 'Cursor', dir: path.join(dir, 'nope'), file: path.join(dir, 'nope', 'mcp.json'), key: 'mcpServers' };
    fs.writeFileSync(desk.file, JSON.stringify({ mcpServers: { other: { command: 'x' }, openband: { command: 'npx', args: ['-y', 'openband', 'mcp'] } } }));
    const calls: string[][] = [];
    const run = (_cmd: string, args: string[]) => (calls.push(args), { status: 0 });
    const entry = desktopEntry({ exe, root });
    const codex = { id: 'codex', name: 'Codex (OpenAI)', dir, file: path.join(dir, 'config.toml') };
    fs.writeFileSync(codex.file, 'model = "gpt-6.1-sol"\n\n[mcp_servers.other]\ncommand = "x"\n');
    const r = connectClients(entry, { clients: [desk, code, absent], codex, claude: '/usr/local/bin/claude', run: run as never });
    expect(r.map((x) => `${x.name}:${x.status}`)).toEqual(['Claude Desktop:added', 'VS Code:added', 'Cursor:missing', 'Codex (OpenAI):added', 'Claude Code:added']);
    const toml = fs.readFileSync(codex.file, 'utf8');
    expect(toml).toContain('model = "gpt-6.1-sol"');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml).toContain(`[mcp_servers.openband]\ncommand = ${JSON.stringify(exe)}`);
    const cfg = JSON.parse(fs.readFileSync(desk.file, 'utf8'));
    expect(cfg.mcpServers.openband).toEqual(entry);
    expect(cfg.mcpServers.other).toEqual({ command: 'x' });
    expect(fs.existsSync(`${desk.file}.bak`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(code.file, 'utf8')).servers.openband).toEqual({ type: 'stdio', ...entry });
    expect(calls[0]).toEqual(['mcp', 'remove', 'openband', '-s', 'user']);
    expect(calls[1]).toEqual(['mcp', 'add', 'openband', '-s', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1', '-e', `OPENBAND_APP=${exe}`, '--', exe, path.join(root, 'server', 'mcp-server.mjs')]);
    // A second time nothing changes.
    expect(connectClients(entry, { clients: [desk], codex, claude: null }).map((x) => x.status)).toEqual(['already', 'already', 'missing']);
    expect(connectClients(entry, { clients: [], codex: null, claude: null }).map((x) => x.status)).toEqual(['missing', 'missing']);
  });
});
