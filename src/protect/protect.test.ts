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
