import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain ESM module
import { SERVER_ENTRY, writeEntry, readConfig } from './clients.mjs';
// @ts-expect-error plain ESM module
import { portInUse, runChecks } from './doctor.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openband-cli-'));
const servers: net.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

describe('setup', () => {
  it('adds OpenBand next to the existing servers and keeps a backup', () => {
    const dir = tmp();
    const file = path.join(dir, 'claude_desktop_config.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
    const r = writeEntry({ id: 'claude-desktop', name: 'Claude Desktop', file, key: 'mcpServers', dir });
    expect(r.changed).toBe(true);
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
    const cfg = readConfig(file);
    expect(cfg.mcpServers.other).toEqual({ command: 'x' });
    expect(cfg.mcpServers.openband).toEqual(SERVER_ENTRY);
    expect(cfg.theme).toBe('dark');
    // Again: nothing to do.
    expect(writeEntry({ id: 'claude-desktop', name: 'Claude Desktop', file, key: 'mcpServers', dir }).changed).toBe(false);
  });

  it('creates the file when the client has none, VS Code style', () => {
    const dir = tmp();
    const file = path.join(dir, 'mcp.json');
    writeEntry({ id: 'vscode', name: 'VS Code', file, key: 'servers', dir });
    expect(readConfig(file).servers.openband).toEqual({ type: 'stdio', ...SERVER_ENTRY });
  });
});

describe('doctor', () => {
  it('reports a port taken by another program and a client without OpenBand', async () => {
    const s = net.createServer((c) => {
      c.on('error', () => {});
      c.end('HTTP/1.1 404 Not Found\r\n\r\n');
    });
    servers.push(s);
    const port: number = await new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));
    expect(await portInUse(port)).toBe(true);
    const dir = tmp();
    const checks = await runChecks({ port, clients: [{ id: 'cursor', name: 'Cursor', file: path.join(dir, 'mcp.json'), key: 'mcpServers', dir }] });
    const portCheck = checks.find((c: { label: string }) => c.label.startsWith(`Port ${port}`));
    expect(portCheck.ok).toBe(false);
    expect(portCheck.fix).toMatch(/next free port/);
    const cursor = checks.find((c: { label: string }) => c.label.startsWith('Cursor'));
    expect(cursor).toMatchObject({ ok: false, fix: expect.stringMatching(/openband setup/) });
  });

  it('flags a config pointing to a missing checkout and a broken JSON file', async () => {
    const dir = tmp();
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { openband: { command: 'node', args: ['/nope/server/mcp-server.mjs'] } } }));
    const dir2 = tmp();
    fs.writeFileSync(path.join(dir2, 'bad.json'), '{ nope');
    const checks = await runChecks({ port: 1, clients: [{ id: 'cursor', name: 'Cursor', file, key: 'mcpServers', dir }, { id: 'x', name: 'Other', file: path.join(dir2, 'bad.json'), key: 'mcpServers', dir: dir2 }] });
    expect(checks.find((c: { label: string }) => c.label.startsWith('Cursor')).label).toMatch(/does not exist/);
    expect(checks.find((c: { label: string }) => c.label.startsWith('Other')).label).toMatch(/not valid JSON/);
  });
});
