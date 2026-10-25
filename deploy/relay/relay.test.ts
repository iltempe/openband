// The relay template (SPEC v0.6 §9-bis): it forwards to fal with the key it keeps, answers only its own
// token and origins, never sends the key back, and logs nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handle } from './relay.mjs';

const ENV = { FAL_KEY: 'fal-secret-key', RELAY_TOKEN: 'my-token', ALLOWED_ORIGINS: 'https://www.openband.it' };
const req = (path: string, init: RequestInit & { token?: string; origin?: string } = {}) =>
  new Request(`https://relay.example${path}`, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: { ...(init.token !== undefined ? { 'x-relay-token': init.token } : { 'x-relay-token': 'my-token' }), origin: init.origin ?? 'https://www.openband.it', 'content-type': 'application/json' },
  });

function upstream() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ request_id: 'r1', status_url: 'https://queue.fal.run/fal-ai/ace-step/requests/r1/status' }), { headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } });
  });
  return { fn, calls };
}

describe('the relay for online engines', () => {
  afterEach(() => vi.restoreAllMocks());

  it('forwards a submission to fal with the key it keeps; the answer carries neither key nor cookies', async () => {
    const up = upstream();
    const res = await handle(req('/fal/fal-ai/ace-step', { method: 'POST', body: JSON.stringify({ tags: 'lofi' }) }), ENV, up.fn);
    expect(res.status).toBe(200);
    expect(up.calls[0].url).toBe('https://queue.fal.run/fal-ai/ace-step');
    expect((up.calls[0].init.headers as Record<string, string>).authorization).toBe('Key fal-secret-key');
    expect(new TextDecoder().decode(up.calls[0].init.body as ArrayBuffer)).toBe('{"tags":"lofi"}');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.openband.it');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).not.toContain('fal-secret-key');
  });

  it('status and cancel go through too (GET, PUT)', async () => {
    const up = upstream();
    await handle(req('/fal/fal-ai/ace-step/requests/r1/status?logs=1'), ENV, up.fn);
    await handle(req('/fal/fal-ai/ace-step/requests/r1/cancel', { method: 'PUT' }), ENV, up.fn);
    expect(up.calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', 'https://queue.fal.run/fal-ai/ace-step/requests/r1/status?logs=1'],
      ['PUT', 'https://queue.fal.run/fal-ai/ace-step/requests/r1/cancel'],
    ]);
  });

  it('answers only its own token and origins', async () => {
    const up = upstream();
    expect((await handle(req('/fal/x', { method: 'POST', token: 'nope' }), ENV, up.fn)).status).toBe(401);
    expect((await handle(req('/fal/x', { method: 'POST', token: '' }), ENV, up.fn)).status).toBe(401);
    expect((await handle(req('/fal/x', { method: 'POST', origin: 'https://evil.example' }), ENV, up.fn)).status).toBe(403);
    expect((await handle(req('/fal/x', { method: 'DELETE' }), ENV, up.fn)).status).toBe(405);
    expect((await handle(req('/elsewhere'), ENV, up.fn)).status).toBe(404);
    expect(up.calls).toHaveLength(0);
    const pre = await handle(req('/fal/x', { method: 'OPTIONS' }), ENV, up.fn);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-relay-token');
  });

  it('downloads fal media without the key, and nothing else', async () => {
    const up = upstream();
    const ok = await handle(req(`/media?url=${encodeURIComponent('https://v3b.fal.media/files/b/abc/out.wav')}`), ENV, up.fn);
    expect(ok.status).toBe(200);
    expect((up.calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    expect((await handle(req(`/media?url=${encodeURIComponent('https://example.com/x.wav')}`), ENV, up.fn)).status).toBe(400);
    expect((await handle(req(`/media?url=${encodeURIComponent('https://fal.media.evil.example/x.wav')}`), ENV, up.fn)).status).toBe(400);
  });

  it('logs nothing: no console call while relaying', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const up = upstream();
    await handle(req('/fal/fal-ai/ace-step', { method: 'POST', body: JSON.stringify({ lyrics: 'private words' }) }), ENV, up.fn);
    await handle(req('/fal/x', { method: 'POST', token: 'nope' }), ENV, up.fn);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('says what is missing when deployed without its secrets', async () => {
    expect((await handle(req('/fal/x', { method: 'POST' }), { RELAY_TOKEN: 'my-token' }, upstream().fn)).status).toBe(500);
  });
});
