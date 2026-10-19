import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { WebSocket } from 'ws';

const server = path.join(__dirname, 'mcp-server.mjs');
const PORT = 7796;
const procs: ChildProcess[] = [];
afterEach(() => procs.splice(0).forEach((p) => p.kill()));

async function start() {
  const p = spawn(process.execPath, [server], { env: { ...process.env, OPENBAND_STDIO: '0', OPENBAND_OPEN_BROWSER: '0', OPENBAND_PORT: String(PORT), OPENBAND_PAIR_CODE: '123456' }, stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(p);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    p.stderr!.on('data', (d) => String(d).includes('bridge on') && (clearTimeout(t), resolve()));
  });
  return p;
}
async function stop(p: ChildProcess) {
  p.kill();
  await new Promise((r) => p.once('exit', r));
}

/** Connect with an Origin; resolves with the socket and a queue of messages, or rejects if refused. */
function connect(origin: string) {
  return new Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>> }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge`, { origin });
    const queue: Record<string, unknown>[] = [];
    const waiters: ((m: Record<string, unknown>) => void)[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      const w = waiters.shift();
      w ? w(m) : queue.push(m);
    });
    ws.once('open', () => resolve({ ws, next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((r) => waiters.push(r))) }));
    ws.once('error', reject);
  });
}

const DEMO = 'https://iltempe.github.io';

describe('bridge pairing (real server)', () => {
  it('rejects unknown sites, pairs the demo with the code, locks after 5 wrong codes, forgets tokens on restart', async () => {
    let p = await start();
    await expect(connect('https://evil.example')).rejects.toBeTruthy();

    const local = await connect('http://localhost:5173');
    expect((await local.next()).type).toBe('hello');
    local.ws.close();

    const a = await connect(DEMO);
    expect(await a.next()).toMatchObject({ type: 'pair_required' });
    a.ws.send(JSON.stringify({ type: 'hello' }));
    expect(await a.next()).toMatchObject({ type: 'pair_required' });
    a.ws.send(JSON.stringify({ type: 'hello', pair: '123-456' }));
    const paired = await a.next();
    expect(paired).toMatchObject({ type: 'paired' });
    expect(await a.next()).toMatchObject({ type: 'hello', protocol: 1 });
    a.ws.close();

    // Reconnection with the token: no code needed.
    const b = await connect(DEMO);
    await b.next();
    b.ws.send(JSON.stringify({ type: 'hello', token: paired.token }));
    expect(await b.next()).toMatchObject({ type: 'paired' });
    b.ws.close();

    // Five wrong codes → locked, even for the right one.
    const c = await connect(DEMO);
    await c.next();
    const results = [];
    for (let i = 0; i < 5; i++) {
      c.ws.send(JSON.stringify({ type: 'hello', pair: '000000' }));
      results.push(((await c.next()) as { reason: string }).reason);
    }
    expect(results).toEqual(['wrong', 'wrong', 'wrong', 'wrong', 'locked']);
    c.ws.send(JSON.stringify({ type: 'hello', pair: '123456' }));
    expect(await c.next()).toMatchObject({ type: 'pair_failed', reason: 'locked' });
    c.ws.close();

    // Restart: the old token is no longer valid.
    await stop(p);
    p = await start();
    const d = await connect(DEMO);
    await d.next();
    d.ws.send(JSON.stringify({ type: 'hello', token: paired.token }));
    expect(await d.next()).toMatchObject({ type: 'pair_required' });
    d.ws.close();
  }, 30000);
});
