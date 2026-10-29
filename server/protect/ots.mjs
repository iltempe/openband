// OpenTimestamps (SPEC v0.6 G7), a small client of our own: the .ots format (a detached timestamp: the
// file's SHA-256, then a tree of operations ending in attestations), stamping a digest on public calendar
// servers, upgrading a pending stamp once Bitcoin has confirmed it, and verifying it against a block header.
// Only a 32-byte digest ever leaves the computer: the calendars see neither the song nor its manifest.
import crypto from 'node:crypto';

export const HEADER = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
export const MAJOR = 1;
const TAG_BITCOIN = Buffer.from('0588960d73d71901', 'hex');
const TAG_PENDING = Buffer.from('83dfe30d2ef90c8e', 'hex');
const OP = { sha256: 0x08, ripemd160: 0x03, sha1: 0x02, append: 0xf0, prepend: 0xf1, reverse: 0xf2, hexlify: 0xf3 };
const NAME = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

export const DEFAULT_CALENDARS = ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org', 'https://a.pool.eternitywall.com'];

// ---------------------------------------------------------------- bytes in and out
export class Writer {
  parts = [];
  byte(b) {
    this.parts.push(Buffer.from([b]));
  }
  bytes(b) {
    this.parts.push(Buffer.from(b));
  }
  varuint(n) {
    const out = [];
    do {
      let b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    this.parts.push(Buffer.from(out));
  }
  varbytes(b) {
    this.varuint(b.length);
    this.bytes(b);
  }
  done() {
    return Buffer.concat(this.parts);
  }
}
class Reader {
  constructor(buf) {
    this.buf = Buffer.from(buf);
    this.at = 0;
  }
  byte() {
    if (this.at >= this.buf.length) throw new Error('Truncated timestamp');
    return this.buf[this.at++];
  }
  bytes(n) {
    if (this.at + n > this.buf.length) throw new Error('Truncated timestamp');
    const b = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return Buffer.from(b);
  }
  varuint() {
    let n = 0;
    let shift = 1;
    for (;;) {
      const b = this.byte();
      n += (b & 0x7f) * shift;
      if (!(b & 0x80)) return n;
      shift *= 128;
    }
  }
  varbytes(max = 8192) {
    const n = this.varuint();
    if (n > max) throw new Error('Too long a value in the timestamp');
    return this.bytes(n);
  }
}

// ---------------------------------------------------------------- operations and the tree
export function applyOp(op, msg) {
  switch (op.op) {
    case 'sha256':
      return crypto.createHash('sha256').update(msg).digest();
    case 'sha1':
      return crypto.createHash('sha1').update(msg).digest();
    case 'ripemd160':
      return crypto.createHash('ripemd160').update(msg).digest();
    case 'append':
      return Buffer.concat([msg, op.arg]);
    case 'prepend':
      return Buffer.concat([op.arg, msg]);
    case 'reverse':
      return Buffer.from(msg).reverse();
    case 'hexlify':
      return Buffer.from(msg.toString('hex'));
    default:
      throw new Error(`Unknown operation ${op.op}`);
  }
}

/** A timestamp node: a message, its attestations, and operations leading to further nodes. */
export const node = (msg) => ({ msg: Buffer.from(msg), attestations: [], ops: [] });

const opKey = (op) => `${OP[op.op].toString(16).padStart(2, '0')}${op.arg ? op.arg.toString('hex') : ''}`;
const attKey = (a) => (a.kind === 'bitcoin' ? `${TAG_BITCOIN.toString('hex')}${String(a.height).padStart(12, '0')}` : a.kind === 'pending' ? `${TAG_PENDING.toString('hex')}${Buffer.from(a.uri).toString('hex')}` : `${a.tag}${a.payload}`);

function writeAttestation(w, a) {
  const payload = new Writer();
  if (a.kind === 'bitcoin') {
    w.bytes(TAG_BITCOIN);
    payload.varuint(a.height);
  } else if (a.kind === 'pending') {
    w.bytes(TAG_PENDING);
    payload.varbytes(Buffer.from(a.uri, 'utf8'));
  } else {
    w.bytes(Buffer.from(a.tag, 'hex'));
    payload.bytes(Buffer.from(a.payload, 'hex'));
  }
  w.varbytes(payload.done());
}
function readAttestation(r) {
  const tag = r.bytes(8);
  const payload = new Reader(r.varbytes());
  if (tag.equals(TAG_BITCOIN)) return { kind: 'bitcoin', height: payload.varuint() };
  if (tag.equals(TAG_PENDING)) return { kind: 'pending', uri: payload.varbytes(1000).toString('utf8') };
  return { kind: 'unknown', tag: tag.toString('hex'), payload: payload.buf.toString('hex') };
}

function writeOp(w, op) {
  w.byte(OP[op.op]);
  if (op.op === 'append' || op.op === 'prepend') w.varbytes(op.arg);
}

export function writeTimestamp(w, t) {
  const atts = [...t.attestations].sort((a, b) => attKey(a).localeCompare(attKey(b)));
  const ops = [...t.ops].sort((a, b) => opKey(a.op).localeCompare(opKey(b.op)));
  if (!atts.length && !ops.length) throw new Error('An empty timestamp');
  for (const [i, a] of atts.entries()) {
    if (i < atts.length - 1 || ops.length) w.byte(0xff);
    w.byte(0x00);
    writeAttestation(w, a);
  }
  for (const [i, { op, next }] of ops.entries()) {
    if (i < ops.length - 1) w.byte(0xff);
    writeOp(w, op);
    writeTimestamp(w, next);
  }
}

export function readTimestamp(r, msg, depth = 0) {
  if (depth > 256) throw new Error('Too deep a timestamp');
  const t = node(msg);
  const item = (tag) => {
    if (tag === 0x00) return void t.attestations.push(readAttestation(r));
    const name = NAME[tag];
    if (!name) throw new Error(`Unknown operation 0x${tag.toString(16)}`);
    const op = { op: name, ...(name === 'append' || name === 'prepend' ? { arg: r.varbytes() } : {}) };
    t.ops.push({ op, next: readTimestamp(r, applyOp(op, t.msg), depth + 1) });
  };
  for (;;) {
    const tag = r.byte();
    if (tag === 0xff) item(r.byte());
    else {
      item(tag);
      return t;
    }
  }
}

/** A detached .ots file: the file's SHA-256 and its timestamp. */
export function serializeOts(t) {
  const w = new Writer();
  w.bytes(HEADER);
  w.varuint(MAJOR);
  w.byte(OP.sha256);
  w.bytes(t.msg);
  writeTimestamp(w, t);
  return w.done();
}
export function parseOts(buf) {
  if (buf.length < HEADER.length || !Buffer.from(buf).subarray(0, HEADER.length).equals(HEADER)) throw new Error('Not an OpenTimestamps proof (.ots)');
  const r = new Reader(buf);
  r.bytes(HEADER.length);
  if (r.varuint() !== MAJOR) throw new Error('An .ots of another version');
  if (r.byte() !== OP.sha256) throw new Error('Only SHA-256 file hashes are supported');
  return readTimestamp(r, r.bytes(32));
}
export const timestampFrom = (buf, msg) => readTimestamp(new Reader(buf), msg);

/** Every attestation, with the message it attests. */
export function attestations(t, out = []) {
  for (const a of t.attestations) out.push({ ...a, msg: t.msg });
  for (const { next } of t.ops) attestations(next, out);
  return out;
}

/** Merge another timestamp of the same message into t (what a calendar answered). */
export function merge(t, other) {
  if (!t.msg.equals(other.msg)) throw new Error('Merging timestamps of different messages');
  for (const a of other.attestations) if (!t.attestations.some((x) => attKey(x) === attKey(a))) t.attestations.push(a);
  for (const o of other.ops) {
    const mine = t.ops.find((x) => opKey(x.op) === opKey(o.op));
    if (mine) merge(mine.next, o.next);
    else t.ops.push(o);
  }
  return t;
}

// ---------------------------------------------------------------- stamping, upgrading, verifying
const ACCEPT = { accept: 'application/vnd.opentimestamps.v1', 'user-agent': 'OpenBand' };

/**
 * Stamp a SHA-256 digest on calendars (at least `min` must answer). A random nonce is appended first, so the
 * calendars see a digest that can't be linked to the file. Returns the timestamp (pending).
 */
export async function stamp(digest, { calendars = DEFAULT_CALENDARS, min = 2, fetchImpl = fetch, nonce = crypto.randomBytes(16) } = {}) {
  if (digest.length !== 32) throw new Error('A SHA-256 digest is 32 bytes');
  const root = node(digest);
  const n = { op: { op: 'append', arg: Buffer.from(nonce) }, next: node(applyOp({ op: 'append', arg: Buffer.from(nonce) }, digest)) };
  const h = { op: { op: 'sha256' }, next: node(applyOp({ op: 'sha256' }, n.next.msg)) };
  n.next.ops.push(h);
  root.ops.push(n);
  const commitment = h.next.msg;
  const answers = await Promise.allSettled(
    calendars.map(async (cal) => {
      const res = await fetchImpl(`${cal.replace(/\/+$/, '')}/digest`, { method: 'POST', headers: { ...ACCEPT, 'content-type': 'application/x-www-form-urlencoded' }, body: commitment, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`${cal}: ${res.status}`);
      return timestampFrom(Buffer.from(await res.arrayBuffer()), commitment);
    }),
  );
  const ok = answers.filter((a) => a.status === 'fulfilled').map((a) => a.value);
  if (ok.length < Math.min(min, calendars.length)) throw new Error(`Only ${ok.length} of ${calendars.length} calendars answered: try again later (${answers.filter((a) => a.status === 'rejected').map((a) => a.reason.message).join('; ')})`);
  for (const t of ok) merge(h.next, t);
  return { timestamp: root, commitment, calendars: ok.length };
}

/** Ask each pending calendar for its finished branch; returns whether anything changed. */
export async function upgrade(t, { fetchImpl = fetch } = {}) {
  let changed = false;
  const walk = async (n) => {
    for (const a of [...n.attestations]) {
      if (a.kind !== 'pending') continue;
      const res = await fetchImpl(`${a.uri.replace(/\/+$/, '')}/timestamp/${n.msg.toString('hex')}`, { headers: ACCEPT, signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!res || !res.ok) continue;
      const got = timestampFrom(Buffer.from(await res.arrayBuffer()), n.msg);
      if (!attestations(got).some((x) => x.kind === 'bitcoin')) continue;
      merge(n, got);
      // The calendar's promise is kept: its pending attestation is no longer needed.
      n.attestations = n.attestations.filter((x) => x !== a);
      changed = true;
    }
    for (const { next } of n.ops) await walk(next);
  };
  await walk(t);
  return changed;
}

/** The state of a timestamp: confirmed (with the lowest block) or pending (with its calendars). */
export function summarize(t) {
  const all = attestations(t);
  const btc = all.filter((a) => a.kind === 'bitcoin').sort((a, b) => a.height - b.height);
  return btc.length ? { state: 'confirmed', height: btc[0].height, merkleRoot: Buffer.from(btc[0].msg).reverse().toString('hex') } : { state: 'pending', calendars: all.filter((a) => a.kind === 'pending').map((a) => a.uri) };
}

/**
 * Verify a confirmed timestamp against Bitcoin: the block at its height, read from a block explorer
 * (Esplora API: /block-height/:h and /block/:hash), must have the merkle root the timestamp arrives at.
 * Returns the block's time (seconds) and hash.
 */
export async function verifyBitcoin(t, { explorer = 'https://blockstream.info/api', fetchImpl = fetch } = {}) {
  const s = summarize(t);
  if (s.state !== 'confirmed') return { verified: false, state: 'pending', calendars: s.calendars };
  const hashRes = await fetchImpl(`${explorer}/block-height/${s.height}`, { signal: AbortSignal.timeout(15000) });
  if (!hashRes.ok) throw new Error(`The block explorer has no block ${s.height} (${hashRes.status})`);
  const hash = (await hashRes.text()).trim();
  const blockRes = await fetchImpl(`${explorer}/block/${hash}`, { signal: AbortSignal.timeout(15000) });
  if (!blockRes.ok) throw new Error(`The block explorer has no block ${hash}`);
  const block = await blockRes.json();
  const verified = String(block.merkle_root).toLowerCase() === s.merkleRoot;
  return { verified, state: 'confirmed', height: s.height, block: hash, time: block.timestamp, ...(verified ? {} : { reason: 'The merkle root does not match: this proof is not for this file, or it was altered' }) };
}
