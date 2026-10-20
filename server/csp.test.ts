import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain ESM module
import { contentSecurityPolicy } from './csp.mjs';

describe('CSP', () => {
  it('is the same on every host', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
    const header = vercel.headers[0].headers.find((h: { key: string }) => h.key === 'Content-Security-Policy');
    expect(header.value).toBe(contentSecurityPolicy());
  });

  it('lets in only the bridge, the Anthropic API, the plugin catalog and collaboration', () => {
    const connect = contentSecurityPolicy().split('; ').find((d: string) => d.startsWith('connect-src'));
    expect(connect).toContain('ws://127.0.0.1:*');
    expect(connect).toContain('https://api.anthropic.com');
    expect(connect).toContain('https://www.webaudiomodules.com');
    expect(connect).not.toMatch(/\shttps:(\s|$)/); // no blanket https:
    expect(contentSecurityPolicy({ collab: ['wss://rooms.example'] })).toContain('wss://rooms.example');
  });
});
