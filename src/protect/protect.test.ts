import { describe, expect, it } from 'vitest';
import { canonicalManifest, sha256Hex, type Manifest } from './manifest';
import { certificatePdf } from './pdf';

const m = (o: Partial<Manifest> = {}): Manifest => ({
  format: 'openband-work/1',
  title: 'Fuori',
  authors: ['iltempe'],
  declared_date: '2026-10-29',
  license: 'CC BY 4.0',
  files: { project: { name: 'Fuori.openband.json', sha256: 'aa'.repeat(32), bytes: 10 }, master: { name: 'Fuori.wav', sha256: 'bb'.repeat(32), bytes: 20 } },
  project_version: 'cc'.repeat(32),
  made_with: 'OpenBand',
  ...o,
});

describe('the manifest', () => {
  it('canonical: the same work gives the same bytes and hash, whatever the order of its keys', async () => {
    const a = m();
    const b = JSON.parse(JSON.stringify({ made_with: a.made_with, files: { master: a.files.master, project: a.files.project }, title: a.title, project_version: a.project_version, license: a.license, format: a.format, declared_date: a.declared_date, authors: a.authors }));
    expect(canonicalManifest(a)).toBe(canonicalManifest(b));
    expect(await sha256Hex(canonicalManifest(a))).toBe(await sha256Hex(canonicalManifest(b)));
    expect(canonicalManifest(a)).not.toMatch(/\s{2}/);
  });
  it('any change to a file changes the hash', async () => {
    const other = m({ files: { ...m().files, master: { ...m().files.master, sha256: 'bd'.repeat(32) } } });
    expect(await sha256Hex(canonicalManifest(other))).not.toBe(await sha256Hex(canonicalManifest(m())));
  });
});

describe('the certificate', () => {
  it('a valid one-page PDF: header, objects at the offsets the xref says, trailer', () => {
    const pdf = certificatePdf([{ text: 'Proof of existence', size: 20, bold: true }, { text: 'Notte à Trastevere (ok) \\ ✓' }]);
    const s = Buffer.from(pdf).toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...s.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((x) => Number(x[1]));
    expect(offsets).toHaveLength(6);
    offsets.forEach((o, i) => expect(s.slice(o, o + 8)).toBe(`${i + 1} 0 obj\n`));
    expect(s).toContain('(Notte \xe0 Trastevere \\(ok\\) \\\\ ?)');
    expect(Buffer.from(certificatePdf([{ text: 'a — b' }])).toString('latin1')).toContain('(a \x97 b)');
  });
});

describe('the ledger in the manifest', () => {
  it('says how much is human, which engines made the rest and under which licence; deleted parts no longer count', async () => {
    const { contributionsOf } = await import('./contributions');
    const lic = { code: 'Apache-2.0', weights: 'CC-BY-4.0', commercial: 'yes' as const, attribution: 'Magenta RealTime 2 by Google (weights CC BY 4.0)' };
    const p = {
      tracks: [{ id: 't1', name: 'Piano' }, { id: 't2', name: 'Live' }],
      regions: [
        { id: 'r1', trackId: 't1', start: 0, length: 16, notes: [] },
        { id: 'r2', trackId: 't2', start: 0, length: 16, notes: [], contribution: 'c1' },
      ],
      ledger: [
        { id: 'c1', at: 1, source: 'engine', engine: 'mrt', engineName: 'Magenta RealTime 2', capability: 'stream.jam', requestedBy: 'user', conform: [], license: lic, trackId: 't2', regionIds: ['r2'] },
        { id: 'c0', at: 0, source: 'engine', engine: 'gone', capability: 'music.song', requestedBy: 'ai', conform: [], license: { code: 'MIT', weights: null, commercial: 'no' }, trackId: 't1', regionIds: ['deleted'] },
      ],
    } as unknown as import('../types').Project;
    const c = await contributionsOf(p);
    expect(c.ai_share).toBe(0.5);
    expect(c.tracks).toEqual([{ name: 'Piano', bars: 4, ai_share: 0, engines: [] }, { name: 'Live', bars: 4, ai_share: 1, engines: ['Magenta RealTime 2'] }]);
    expect(c.engines).toEqual([{ id: 'mrt', name: 'Magenta RealTime 2', capabilities: ['stream.jam'], license: 'Apache-2.0, weights CC-BY-4.0', commercial: 'yes' }]);
    expect(c.attributions).toContain(lic.attribution);
    expect(c.ledger_entries).toBe(2);
    expect(c.ledger_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The same ledger, the same hash: the manifest stays canonical.
    expect((await contributionsOf(structuredClone(p))).ledger_sha256).toBe(c.ledger_sha256);
    const human = await contributionsOf({ ...p, regions: [p.regions[0]], ledger: [] } as never);
    expect(human).toMatchObject({ ai_share: 0, engines: [], ledger_entries: 0 });
  });
});
