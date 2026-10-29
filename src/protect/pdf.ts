// A one-page PDF certificate (SPEC v0.6 G7), written by hand: a few lines of text in Helvetica, no library.
// Text is kept to what the standard PDF fonts can show (WinAnsi: Latin-1 and the usual typographic marks);
// anything else becomes "?".

// WinAnsi's typographic characters, beyond Latin-1.
const WIN: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
const esc = (s: string) =>
  [...s.normalize('NFC')]
    .map((ch) => (WIN[ch] ? String.fromCharCode(WIN[ch]) : ch.charCodeAt(0) < 256 ? ch : '?'))
    .join('')
    .replace(/[\\()]/g, (m) => `\\${m}`);

export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  gap?: number;
}

/** A4, lines from the top; long lines are wrapped by characters. */
export function certificatePdf(lines: PdfLine[]): Uint8Array {
  const W = 595;
  const H = 842;
  let y = H - 70;
  const ops: string[] = [];
  for (const l of lines) {
    const size = l.size ?? 11;
    const max = Math.floor((W - 120) / (size * 0.52));
    const parts = l.text.length > max ? l.text.match(new RegExp(`.{1,${max}}(\\s|$)|.{1,${max}}`, 'g'))! : [l.text];
    y -= l.gap ?? 0;
    for (const part of parts) {
      ops.push(`BT /${l.bold ? 'F2' : 'F1'} ${size} Tf 60 ${y.toFixed(1)} Td (${esc(part.trimEnd())}) Tj ET`);
      y -= size * 1.45;
    }
  }
  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${latin1(content).length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(latin1(out).length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = latin1(out).length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(out);
}

function latin1(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}
