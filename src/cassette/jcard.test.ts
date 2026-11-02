import { describe, expect, it } from 'vitest';
import { jcardPdf, qrMatrix } from './jcard';
import { assembleSide, sideLayout } from './tape';

const pdf = (link: string | null) => new TextDecoder('latin1').decode(jcardPdf({ title: 'Più forte (live)', artist: 'Matteo', sides: [{ name: 'A', tracks: ['Febbraio'] }], link, cover: { jpeg: new Uint8Array([255, 216, 255, 217]), width: 1, height: 1 } }));

describe('the J-card', () => {
  it('is a PDF with a valid cross-reference', () => {
    const s = pdf('https://x.example/#k=abc');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s).toContain('/Filter /DCTDecode');
    const at = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(at, at + 4)).toBe('xref');
    for (const [, off, n] of [...s.slice(at).matchAll(/(\d{10}) 00000 n/g)].map((m, i) => [m, Number(m[1]), i + 1] as const)) expect(s.slice(off, off + 8)).toBe(`${n} 0 obj\n`);
  });
  it('escapes and simplifies text', () => expect(pdf(null)).toContain('(Piu forte \\(live\\))'));
  it('leaves a line for the password when the link has no key', () => expect(pdf(null)).toContain('Password:'));
  it('draws a QR with its finder patterns', () => {
    const m = qrMatrix('https://x.example/c/tape/1/#k=abcdefghijklmnopqrstuvwxyz&s=tape_123');
    expect(m.length).toBeGreaterThan(20);
    expect(m[0].slice(0, 7).every(Boolean)).toBe(true);
    expect(m[1].slice(1, 6).some(Boolean)).toBe(false);
  });
});

describe('a side for a real tape', () => {
  it('warns when a side runs over', () => {
    expect(sideLayout([600, 600], 4, 'C60')).toMatchObject({ totalS: 1208, over: 0 });
    expect(sideLayout([1000, 900], 4, 'C60').over).toBeCloseTo(108);
  });
  it('starts after the leader, with gaps', () => {
    const one = [new Float32Array([1, 1])];
    const [L] = assembleSide([one, one], 1, 2);
    expect([...L]).toEqual([0, 0, 0, 0, 1, 1, 0, 0, 1, 1]);
  });
});
