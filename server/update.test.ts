import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain ESM module
import { checkForUpdate, newer } from './update.mjs';

const fakeFetch = (version: string, calls: string[]) => (async (url: string) => (calls.push(url), { ok: true, json: async () => ({ tag_name: `v${version}` }) })) as unknown as typeof fetch;

describe('update check', () => {
  it('compares versions', () => {
    expect(newer('0.3.0', '0.2.9')).toBe(true);
    expect(newer('0.2.0', '0.2.0')).toBe(false);
    expect(newer('1.0.0', '1.0.0-beta.1')).toBe(true);
    expect(newer('0.10.0', '0.9.9')).toBe(true);
  });

  it('asks the registry at most once a day and can be turned off', async () => {
    const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ob-upd-')), 'u.json');
    const calls: string[] = [];
    const r1 = await checkForUpdate({ current: '0.2.0', now: 1000, cacheFile, fetchImpl: fakeFetch('0.3.0', calls), env: {} });
    expect(r1).toMatchObject({ latest: '0.3.0', update_available: true });
    await checkForUpdate({ current: '0.2.0', now: 1000 + 3600_000, cacheFile, fetchImpl: fakeFetch('0.3.1', calls), env: {} });
    expect(calls).toHaveLength(1); // cached
    const r3 = await checkForUpdate({ current: '0.2.0', now: 1000 + 25 * 3600_000, cacheFile, fetchImpl: fakeFetch('0.3.1', calls), env: {} });
    expect(calls).toHaveLength(2);
    expect(r3.latest).toBe('0.3.1');
    expect(await checkForUpdate({ current: '0.2.0', cacheFile, fetchImpl: fakeFetch('9.9.9', calls), env: { OPENBAND_NO_UPDATE_CHECK: '1' } })).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('stays silent when the registry is unreachable', async () => {
    const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ob-upd-')), 'u.json');
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await checkForUpdate({ current: '0.2.0', cacheFile, fetchImpl: failing, env: {} })).toBeNull();
  });
});
