import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fetchPublic, isPrivateAddress } from './remote.mjs';

const server = path.join(__dirname, 'mcp-server.mjs');
const PORT = 7801;
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;

beforeAll(async () => {
  proc = spawn(process.execPath, [server], {
    env: { ...process.env, OPENBAND_STDIO: '0', OPENBAND_OPEN_BROWSER: '0', OPENBAND_PORT: String(PORT), OPENBAND_REMOTE_MCP: '1', OPENBAND_REMOTE_TOKEN: 'sesame', OPENBAND_HOST: '127.0.0.1', OPENBAND_NO_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stderr!.on('data', (d) => String(d).includes('bridge on') && (clearTimeout(t), resolve()));
  });
});
afterAll(() => proc?.kill());

/** A fake studio tab: asks for remote pairing, answers get_project with its own song. */
function studio(song: string) {
  return new Promise<{ ws: WebSocket; code: () => Promise<string>; paired: Promise<void> }>((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/bridge`, { origin: BASE });
    let gotCode: (c: string) => void;
    const code = new Promise<string>((r) => (gotCode = r));
    let gotPaired: () => void;
    const paired = new Promise<void>((r) => (gotPaired = r));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'remote_code') gotCode(m.code);
      if (m.type === 'remote_paired') gotPaired();
      if (m.type === 'call') {
        const result = m.method === 'get_project' ? { name: song } : m.method === 'get_status' ? { project: song } : { ok: true };
        ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
      }
    });
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'hello', app: 'openband', protocol: 1, remote: true }));
      resolve({ ws, code: () => code, paired });
    });
    ws.once('error', reject);
  });
}

async function mcp(query = '?token=sesame') {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp${query}`)));
  return client;
}
const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text);

describe('remote MCP over Streamable HTTP (real server)', () => {
  it('needs the token', async () => {
    expect((await fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
    await expect(mcp('?token=wrong')).rejects.toBeTruthy();
  });

  it('initialize → no tools before pairing → pair → the right tab; two tabs stay isolated', async () => {
    const a = await studio('Song A');
    const b = await studio('Song B');
    const [codeA, codeB] = [await a.code(), await b.code()];
    expect(codeA).toMatch(/^\d{6}$/);
    expect(codeB).not.toBe(codeA);

    const c1 = await mcp();
    const c2 = await mcp();
    const tools = (await c1.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('pair_studio');
    expect(names).not.toContain('open_studio');
    // No disk on the server side: no save_to; imports only from URLs.
    expect(Object.keys((tools.find((t) => t.name === 'export_wav')!.inputSchema as { properties?: object }).properties ?? {})).not.toContain('save_to');
    expect(c1.getInstructions()).toMatch(/pair_studio/);

    const before = await c1.callTool({ name: 'get_project', arguments: {} });
    expect(before.isError).toBe(true);
    expect(textOf(before)).toMatch(/Not paired/);

    const wrong = await c1.callTool({ name: 'pair_studio', arguments: { code: '000000' === codeA ? '111111' : '000000' } });
    expect(wrong.isError).toBe(true);

    expect((await c1.callTool({ name: 'pair_studio', arguments: { code: codeA } })).isError).toBeFalsy();
    await a.paired;
    expect((await c2.callTool({ name: 'pair_studio', arguments: { code: `${codeB.slice(0, 3)}-${codeB.slice(3)}` } })).isError).toBeFalsy();
    await b.paired;

    expect(JSON.parse(textOf(await c1.callTool({ name: 'get_project', arguments: {} })))).toEqual({ name: 'Song A' });
    expect(JSON.parse(textOf(await c2.callTool({ name: 'get_project', arguments: {} })))).toEqual({ name: 'Song B' });
    // A code is spent once used: another session can't take tab A.
    const c3 = await mcp();
    expect((await c3.callTool({ name: 'pair_studio', arguments: { code: codeA } })).isError).toBe(true);
    expect((await c3.callTool({ name: 'get_project', arguments: {} })).isError).toBe(true);

    // Closing tab A ends its pairing; B is untouched.
    a.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect((await c1.callTool({ name: 'get_project', arguments: {} })).isError).toBe(true);
    expect(JSON.parse(textOf(await c2.callTool({ name: 'get_project', arguments: {} })))).toEqual({ name: 'Song B' });

    await Promise.all([c1.close(), c2.close(), c3.close()]);
    b.ws.close();
  });

  it('pairs from the connector URL (?pair=)', async () => {
    const s = await studio('Song C');
    const c = await mcp(`?token=sesame&pair=${await s.code()}`);
    await s.paired;
    expect(JSON.parse(textOf(await c.callTool({ name: 'get_project', arguments: {} })))).toEqual({ name: 'Song C' });
    await c.close();
    s.ws.close();
  });

  it('accepts tabs of this site behind a reverse proxy (same Host), not other sites', async () => {
    const open = (origin: string, host: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const ws = new WebSocket(`${BASE.replace('http', 'ws')}/bridge`, { origin, headers: { host } });
        ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', remote: true })));
        ws.once('message', (d) => (resolve(JSON.parse(String(d))), ws.close()));
        ws.once('error', reject);
      });
    expect(await open('https://music.example', 'music.example')).toMatchObject({ type: 'remote_code' });
    await expect(open('https://evil.example', 'music.example')).rejects.toBeTruthy();
  });

  it('tells the studio it can show the remote tab', async () => {
    expect(await (await fetch(`${BASE}/config.json`)).json()).toMatchObject({ remoteMcp: true });
  });
});

describe('remote URL imports', () => {
  it('refuse local paths and private networks', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '0.0.0.0']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '151.101.1.69', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
    await expect(fetchPublic('/etc/passwd')).rejects.toThrow(/http\(s\) URL/);
    await expect(fetchPublic('file:///etc/passwd')).rejects.toThrow(/http\(s\) URL/);
    await expect(fetchPublic('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private or local/);
    const lookup = async () => [{ address: '10.0.0.5' }];
    await expect(fetchPublic('https://sneaky.example/a.wav', 1000, lookup as never)).rejects.toThrow(/private or local/);
  });
});
