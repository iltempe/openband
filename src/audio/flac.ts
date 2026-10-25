// A FLAC encoder (SPEC v0.6 G6: masters for SoundCloud, Audius, the Internet Archive, Wikimedia Commons):
// lossless, fixed linear predictors (order 0–4, the best per block and channel) with Rice-coded residuals,
// Vorbis comments for the metadata the release carries (title, artist, licence, copyright, contact…) and
// the cover as a PICTURE block. Small and pure, so the master is made in the page.

class Bits {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private acc = 0;
  private n = 0;
  private grow(need: number) {
    if (this.len + need <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + need + 1024));
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  write(value: number, bits: number) {
    // Up to 32 bits, most significant first.
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | (Math.floor(value / 2 ** i) & 1);
      if (++this.n === 8) {
        this.grow(1);
        this.buf[this.len++] = this.acc & 0xff;
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  /** A unary run of `zeros` zeros then a one (Rice quotients). */
  unary(zeros: number) {
    for (let i = 0; i < zeros; i++) this.write(0, 1);
    this.write(1, 1);
  }
  align() {
    if (this.n) this.write(0, 8 - this.n);
  }
  bytes(b: Uint8Array) {
    this.align();
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  get length() {
    return this.len;
  }
  out() {
    this.align();
    return this.buf.slice(0, this.len);
  }
}

const CRC8 = Uint8Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  return c;
});
const CRC16 = Uint16Array.from({ length: 256 }, (_, i) => {
  let c = i << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
  return c;
});
const crc8 = (b: Uint8Array) => b.reduce((c, x) => CRC8[c ^ x], 0);
const crc16 = (b: Uint8Array) => b.reduce((c, x) => ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ x], 0);

/** FLAC's "UTF-8" coding of the frame number. */
function utf8Number(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  let bytes = n < 0x800 ? 2 : n < 0x10000 ? 3 : n < 0x200000 ? 4 : n < 0x4000000 ? 5 : 6;
  for (let i = 0; i < bytes - 1; i++) {
    out.unshift(0x80 | (n & 0x3f));
    n = Math.floor(n / 64);
  }
  out.unshift(((0xff << (8 - bytes)) & 0xff) | n);
  return out;
}

/** The residual of a fixed predictor of `order` (FLAC's 0–4), for the samples after the warm-up. */
function residual(x: Int32Array, order: number): Int32Array {
  const r = new Int32Array(x.length - order);
  for (let i = order; i < x.length; i++) {
    const p = order === 0 ? 0 : order === 1 ? x[i - 1] : order === 2 ? 2 * x[i - 1] - x[i - 2] : order === 3 ? 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3] : 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
    r[i - order] = x[i] - p;
  }
  return r;
}

const zig = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);

/** The best Rice parameter for a residual, and its cost in bits. */
function riceParam(r: Int32Array): { k: number; bits: number } {
  let sum = 0;
  for (const v of r) sum += zig(v);
  const mean = sum / Math.max(1, r.length);
  let best = { k: 0, bits: Infinity };
  const k0 = Math.max(0, Math.floor(Math.log2(mean + 1)) - 1);
  for (let k = Math.max(0, k0 - 1); k <= Math.min(14, k0 + 2); k++) {
    let bits = 0;
    for (const v of r) bits += Math.floor(zig(v) / 2 ** k) + 1 + k;
    if (bits < best.bits) best = { k, bits };
  }
  return best;
}

export interface FlacOptions {
  bitsPerSample?: 16 | 24;
  /** Vorbis comments: TITLE, ARTIST, LICENSE, COPYRIGHT, CONTACT, DATE, GENRE, DESCRIPTION… */
  tags?: Record<string, string>;
  /** A front cover (PNG or JPEG bytes). */
  picture?: { mime: string; data: Uint8Array; width: number; height: number };
}

/** Float PCM channels → a FLAC file. */
export function encodeFlac(channels: Float32Array[], sampleRate: number, o: FlacOptions = {}): Uint8Array {
  const bps = o.bitsPerSample ?? 16;
  const nch = channels.length;
  const total = channels[0].length;
  const block = 4096;
  const scale = 2 ** (bps - 1) - 1;
  // Integer samples, with triangular dither when going to 16 bits.
  let seed = 22222;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  const ints = channels.map((c) => Int32Array.from(c, (v) => Math.max(-scale - 1, Math.min(scale, Math.round(v * scale + (bps === 16 ? rnd() + rnd() : 0))))));

  const out = new Bits();
  out.bytes(new TextEncoder().encode('fLaC'));
  // Metadata blocks: STREAMINFO, VORBIS_COMMENT, PICTURE?
  const blocks: { type: number; data: Uint8Array }[] = [];
  const si = new Bits();
  si.write(block, 16);
  si.write(block, 16);
  si.write(0, 24);
  si.write(0, 24);
  si.write(sampleRate, 20);
  si.write(nch - 1, 3);
  si.write(bps - 1, 5);
  si.write(Math.floor(total / 2 ** 32), 4);
  si.write(total % 2 ** 32, 32);
  for (let i = 0; i < 16; i++) si.write(0, 8); // MD5 unknown (allowed)
  blocks.push({ type: 0, data: si.out() });
  const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  const enc = new TextEncoder();
  const vendor = enc.encode('OpenBand');
  const comments = Object.entries(o.tags ?? {}).filter(([, v]) => v).map(([k, v]) => enc.encode(`${k.toUpperCase()}=${v}`));
  const vc = [...le32(vendor.length), ...vendor, ...le32(comments.length), ...comments.flatMap((c) => [...le32(c.length), ...c])];
  blocks.push({ type: 4, data: Uint8Array.from(vc) });
  if (o.picture) {
    const pb = new Bits();
    const mime = enc.encode(o.picture.mime);
    pb.write(3, 32);
    pb.write(mime.length, 32);
    pb.bytes(mime);
    pb.write(0, 32);
    pb.write(o.picture.width, 32);
    pb.write(o.picture.height, 32);
    pb.write(24, 32);
    pb.write(0, 32);
    pb.write(o.picture.data.length, 32);
    pb.bytes(o.picture.data);
    blocks.push({ type: 6, data: pb.out() });
  }
  blocks.forEach((b, i) => {
    out.write(i === blocks.length - 1 ? 1 : 0, 1);
    out.write(b.type, 7);
    out.write(b.data.length, 24);
    out.bytes(b.data);
  });

  const SR_CODE: Record<number, number> = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };
  for (let f = 0, at = 0; at < total; f++, at += block) {
    const n = Math.min(block, total - at);
    const fr = new Bits();
    fr.write(0x3ffe, 14); // sync
    fr.write(0, 1);
    fr.write(0, 1); // fixed block size
    fr.write(7, 4); // block size: 16 bits at the end of the header
    fr.write(SR_CODE[sampleRate] ?? 0, 4);
    fr.write(nch - 1, 4); // independent channels
    fr.write(bps === 16 ? 4 : 6, 3);
    fr.write(0, 1);
    for (const b of utf8Number(f)) fr.write(b, 8);
    fr.write(n - 1, 16);
    const head = fr.out();
    const frame = new Bits();
    frame.bytes(head);
    frame.write(crc8(head), 8);
    for (let c = 0; c < nch; c++) {
      const x = ints[c].subarray(at, at + n);
      // The predictor order with the cheapest residual (orders need at least order+1 samples).
      let best = { order: -1, k: 0, bits: n * bps, r: new Int32Array() };
      for (let order = 0; order <= Math.min(4, n - 1); order++) {
        const r = residual(x, order);
        const { k, bits } = riceParam(r);
        const cost = bits + order * bps + 10;
        if (cost < best.bits) best = { order, k, bits: cost, r };
      }
      if (best.order < 0) {
        frame.write(0, 1);
        frame.write(1, 6); // VERBATIM
        frame.write(0, 1);
        for (const v of x) frame.write(v < 0 ? v + 2 ** bps : v, bps);
        continue;
      }
      frame.write(0, 1);
      frame.write(8 + best.order, 6); // FIXED, order
      frame.write(0, 1);
      for (let i = 0; i < best.order; i++) frame.write(x[i] < 0 ? x[i] + 2 ** bps : x[i], bps);
      frame.write(0, 2); // Rice, 4-bit parameters
      frame.write(0, 4); // partition order 0
      frame.write(best.k, 4);
      for (const v of best.r) {
        const u = zig(v);
        const q = Math.floor(u / 2 ** best.k);
        frame.unary(q);
        if (best.k) frame.write(u % 2 ** best.k, best.k);
      }
    }
    const body = frame.out();
    out.bytes(body);
    out.write(crc16(body), 16);
  }
  return out.out();
}
