import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM module
import { Pairing, classifyOrigin, parseAllowedOrigins } from './pairing.mjs';

describe('origins', () => {
  it('lets local pages in, asks a code from allowed sites, rejects the rest', () => {
    expect(classifyOrigin('http://localhost:5173')).toBe('local');
    expect(classifyOrigin('http://127.0.0.1:7777')).toBe('local');
    expect(classifyOrigin(undefined)).toBe('local');
    expect(classifyOrigin('https://iltempe.github.io')).toBe('pair');
    expect(classifyOrigin('https://evil.example')).toBe('reject');
    expect(classifyOrigin('https://iltempe.github.io.evil.example')).toBe('reject');
    expect(classifyOrigin('https://my.school', parseAllowedOrigins('https://my.school/, https://other.org'))).toBe('pair');
    expect(parseAllowedOrigins(undefined)).toEqual(['https://iltempe.github.io']);
  });
});

describe('pairing', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  };

  it('gives a token for the right code, and the token survives reconnections but not a restart', () => {
    const c = clock();
    const p = new Pairing({ now: c.now, code: '482913' });
    expect(p.pretty()).toBe('482-913');
    expect(p.attempt('')).toMatchObject({ ok: false, reason: 'missing' });
    const r = p.attempt('482-913');
    expect(r.ok).toBe(true);
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    expect(p.valid(r.token)).toBe(true);
    expect(p.valid(r.token)).toBe(true); // reconnection
    const restarted = new Pairing({ now: c.now, code: '482913' });
    expect(restarted.valid(r.token)).toBe(false);
  });

  it('locks for 5 minutes after 5 wrong codes in a minute', () => {
    const c = clock();
    const p = new Pairing({ now: c.now, code: '111111' });
    for (let i = 0; i < 4; i++) expect(p.attempt('000000')).toMatchObject({ ok: false, reason: 'wrong' });
    expect(p.attempt('000000')).toMatchObject({ ok: false, reason: 'locked' });
    expect(p.attempt('111111')).toMatchObject({ ok: false, reason: 'locked' }); // even the right one
    c.advance(5 * 60 * 1000 + 1);
    expect(p.attempt('111111').ok).toBe(true);
  });

  it('forgets old failures after a minute', () => {
    const c = clock();
    const p = new Pairing({ now: c.now, code: '111111' });
    for (let i = 0; i < 4; i++) p.attempt('000000');
    c.advance(61_000);
    expect(p.attempt('000000')).toMatchObject({ reason: 'wrong', attemptsLeft: 4 });
  });

  it('expires codes after 10 minutes', () => {
    const c = clock();
    const p = new Pairing({ now: c.now });
    const code = p.code();
    c.advance(10 * 60 * 1000);
    expect(p.attempt(code)).toMatchObject({ ok: false, reason: 'expired' });
    expect(p.attempt(p.code()).ok).toBe(true);
  });
});
