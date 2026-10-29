// MP3 (Mixcloud takes MP3; SPEC v0.6 G6: 320 kbit/s). LAME through @breezystack/lamejs (LGPL-3.0), loaded
// only when an MP3 is made, as its own unmodified chunk.

/** Stereo (or mono) float samples at sampleRate → MP3 bytes at kbps (default 320). */
export async function encodeMp3(channels: Float32Array[], sampleRate: number, kbps = 320): Promise<Uint8Array> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const stereo = channels.length > 1;
  const enc = new Mp3Encoder(stereo ? 2 : 1, sampleRate, kbps);
  const toInt16 = (x: Float32Array, from: number, to: number) => {
    const out = new Int16Array(to - from);
    for (let i = from; i < to; i++) {
      const v = Math.max(-1, Math.min(1, x[i]));
      out[i - from] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  };
  const parts: Uint8Array[] = [];
  const n = channels[0].length;
  const BLOCK = 1152 * 32;
  for (let i = 0; i < n; i += BLOCK) {
    const to = Math.min(n, i + BLOCK);
    const l = toInt16(channels[0], i, to);
    const buf = stereo ? enc.encodeBuffer(l, toInt16(channels[1], i, to)) : enc.encodeBuffer(l);
    if (buf.length) parts.push(buf.slice());
    // A long song: let the page breathe between pieces.
    if ((i / BLOCK) % 64 === 63) await new Promise((ok) => setTimeout(ok, 0));
  }
  const end = enc.flush();
  if (end.length) parts.push(end.slice());
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}
