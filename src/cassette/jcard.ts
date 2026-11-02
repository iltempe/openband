// The J-card (D3.4): a printable PDF of an A4 sheet, cut and folded to the standard case. A small PDF writer: one
// page, Helvetica, one JPEG, rectangles. Pure.
import qrcode from 'qrcode-generator';

const MM = 72 / 25.4;
/** Standard J-card panels, mm: front, spine, flap, height. */
export const JCARD = { front: 65, spine: 12.5, flap: 15, height: 101.6 };
const LEFT = 25;
const TOP = 30;
const PAGE = { w: 210, h: 297 };

export const qrMatrix = (text: string) => {
  const q = qrcode(0, 'L');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => q.isDark(y, x)));
};

export interface JCardData {
  title: string;
  artist: string;
  sides: { name: string; tracks: string[] }[];
  notes?: string;
  link: string | null;
  cover: { jpeg: Uint8Array; width: number; height: number };
}

/** Text a PDF string can hold in its standard encoding. */
const pdfText = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&');

const y = (mm: number) => (PAGE.h - mm) * MM;
const x = (mm: number) => mm * MM;

export function jcardPdf(d: JCardData) {
  const ops: string[] = [];
  const text = (mmX: number, mmY: number, size: number, s: string) => ops.push(`BT /F1 ${size} Tf ${x(mmX).toFixed(2)} ${y(mmY).toFixed(2)} Td (${pdfText(s)}) Tj ET`);
  const { front, spine, flap, height } = JCARD;
  const R = LEFT + front;
  // Fold lines and the outline.
  ops.push('0.6 G 0.3 w');
  ops.push(`${x(LEFT)} ${y(TOP + height)} ${(front + spine + flap) * MM} ${height * MM} re S`);
  for (const f of [R, R + spine]) ops.push(`[2 2] 0 d ${x(f)} ${y(TOP)} m ${x(f)} ${y(TOP + height)} l S [] 0 d`);
  // Front: the cover.
  ops.push(`q ${front * MM} 0 0 ${front * MM} ${x(LEFT)} ${y(TOP + front)} cm /Im1 Do Q`);
  ops.push('0 g');
  text(LEFT + 3, TOP + front + 8, 12, d.title);
  text(LEFT + 3, TOP + front + 13, 9, d.artist);
  // Spine.
  ops.push(`q 0 1 -1 0 ${x(R + spine - 4.5)} ${y(TOP + height - 3)} cm BT /F1 8 Tf 0 0 Td (${pdfText(`${d.title} - ${d.artist}`)}) Tj ET Q`);
  // The back of the sheet stays free: side lists below the card, to cut out for the inside.
  let at = TOP + height + 14;
  text(LEFT, at - 5, 8, 'Inside');
  for (const side of d.sides) {
    text(LEFT, at, 10, `Side ${side.name}`);
    at += 5;
    for (const [i, t] of side.tracks.entries()) {
      text(LEFT + 2, at, 9, `${i + 1}. ${t}`);
      at += 4.5;
    }
    at += 3;
  }
  if (d.notes) text(LEFT, at, 8, d.notes.slice(0, 110));
  // The QR, or a line to write the password by hand.
  const qx = LEFT + front + spine + flap + 12;
  if (d.link) {
    const m = qrMatrix(d.link);
    const cell = 34 / m.length;
    ops.push('0 g');
    m.forEach((row, r) => row.forEach((on, c) => on && ops.push(`${(x(qx) + c * cell * MM).toFixed(2)} ${(y(TOP + (r + 1) * cell)).toFixed(2)} ${(cell * MM).toFixed(2)} ${(cell * MM).toFixed(2)} re f`)));
    text(qx, TOP + 39, 7, 'Point your phone here');
  } else text(qx, TOP + 8, 8, 'Password: ______________');
  const content = new TextEncoder().encode(ops.join('\n'));
  const obj = (n: number, body: string) => `${n} 0 obj\n${body}\nendobj\n`;
  const chunks: Uint8Array[] = [];
  const enc = (s: string) => new TextEncoder().encode(s);
  let pos = 0;
  const offsets: number[] = [];
  const push = (b: Uint8Array) => (chunks.push(b), (pos += b.length));
  push(enc('%PDF-1.4\n'));
  const add = (n: number, parts: (string | Uint8Array)[]) => {
    offsets[n] = pos;
    for (const p of parts) push(typeof p === 'string' ? enc(p) : p);
  };
  add(1, [obj(1, '<< /Type /Catalog /Pages 2 0 R >>')]);
  add(2, [obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')]);
  add(3, [obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${(PAGE.w * MM).toFixed(2)} ${(PAGE.h * MM).toFixed(2)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>`)]);
  add(4, [`4 0 obj\n<< /Length ${content.length} >>\nstream\n`, content, '\nendstream\nendobj\n']);
  add(5, [obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')]);
  add(6, [`6 0 obj\n<< /Type /XObject /Subtype /Image /Width ${d.cover.width} /Height ${d.cover.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${d.cover.jpeg.length} >>\nstream\n`, d.cover.jpeg, '\nendstream\nendobj\n']);
  const xref = pos;
  push(enc(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  const out = new Uint8Array(pos);
  let i = 0;
  for (const c of chunks) (out.set(c, i), (i += c.length));
  return out;
}

export const MM_PER_PT = 1 / MM;
