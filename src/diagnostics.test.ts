import { describe, expect, it } from 'vitest';
import { useStore } from './store';
import { commands } from './commands';
import { bugReportUrl, collectDiagnostics, logError, recentErrors } from './diagnostics';
import { saveKey, setKeyStore } from './ai/keys';

describe('diagnostics and bug report', () => {
  it('never include the song or the API key', async () => {
    const mem = { v: null as string | null };
    setKeyStore({ get: async () => mem.v, set: async (k) => void (mem.v = k), clear: async () => void (mem.v = null) });
    await saveKey('sk-ant-api03-TOPSECRETTOPSECRET');
    commands.new_project({ name: 'My Secret Song', bpm: 97 });
    const { track_id } = (await commands.add_track({ kind: 'instrument', name: 'Hidden Track Name' })) as { track_id: string };
    commands.add_region({ track_id, notes: [{ pitch: 61, start: 0 }] });
    commands.set_lyrics({ text: 'words nobody should see' });
    logError(new Error('Something broke'));
    const d = await collectDiagnostics();
    const { url, body } = bugReportUrl(d, 'Audio stops');
    const all = decodeURIComponent(url) + body + JSON.stringify(d);
    for (const secret of ['TOPSECRET', 'My Secret Song', 'Hidden Track Name', 'words nobody', useStore.getState().project.meta?.projectId ?? 'xx']) expect(all).not.toContain(secret);
    expect(body).toContain('<details>');
    expect(body).toContain('Error: Something broke');
    expect(url.startsWith('https://github.com/iltempe/openband/issues/new?')).toBe(true);
    expect(new URL(url).searchParams.get('template')).toBe('bug.yml');
  });

  it('keeps only the last 50 errors, one line each', () => {
    for (let i = 0; i < 60; i++) logError(`error ${i}\nstack line`);
    const e = recentErrors();
    expect(e).toHaveLength(50);
    expect(e.at(-1)!.message).toBe('error 59');
  });
});
