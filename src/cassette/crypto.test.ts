import { describe, expect, it } from 'vitest';
import { canonical, fingerprint, fromB64u, lockKey, newIdentity, newSeriesKey, open, openFrom, seal, sealFor, sha256, signText, toB64u, unlockKey, verifyText } from './crypto';

const text = (s: string) => new TextEncoder().encode(s);
const FAST = 1000;

describe('cassette cryptography', () => {
  it('matches the published test vectors', async () => {
    expect(await sha256(text('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // AES-256-GCM, NIST SP 800-38D test case 14: all-zero key, IV and one block.
    const key = toB64u(new Uint8Array(32));
    const sealedFixture = new Uint8Array(12 + 32);
    sealedFixture.set(Uint8Array.from(Buffer.from('cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919', 'hex')), 12);
    expect([...(await open(key, sealedFixture))]).toEqual(new Array(16).fill(0));
    // PBKDF2-HMAC-SHA256, RFC 7914 §11: P="passwd", S="salt", c=1.
    const raw = await crypto.subtle.importKey('raw', text('passwd'), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: text('salt'), iterations: 1 }, raw, 512));
    expect(Buffer.from(bits).toString('hex').slice(0, 32)).toBe('55ac046e56e3089fec1691c22544b605');
  });
  it('seals and opens; a touched byte or the wrong key is refused', async () => {
    const k = newSeriesKey();
    const s = await seal(k, text('lato A'));
    expect(new TextDecoder().decode(await open(k, s))).toBe('lato A');
    s[20] ^= 1;
    await expect(open(k, s)).rejects.toThrow();
    await expect(open(newSeriesKey(), await seal(k, text('x')))).rejects.toThrow();
  });
  it('never reuses an IV', async () => {
    const k = newSeriesKey();
    const a = await seal(k, text('same'));
    const b = await seal(k, text('same'));
    expect(toB64u(a.subarray(0, 12))).not.toBe(toB64u(b.subarray(0, 12)));
  });
  it('signs one canonical form, whatever the key order', async () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
    const id = await newIdentity();
    const sig = await signText(id.sign.privateKey, canonical({ a: 1, b: 2 }));
    expect(await verifyText(id.sign.publicKey, canonical({ b: 2, a: 1 }), sig)).toBe(true);
    expect(await verifyText(id.sign.publicKey, canonical({ b: 3, a: 1 }), sig)).toBe(false);
    expect(await verifyText((await newIdentity()).sign.publicKey, canonical({ a: 1, b: 2 }), sig)).toBe(false);
  });
  it('gives the same four signs for the same key', async () => {
    const id = await newIdentity();
    expect(await fingerprint(id.sign.publicKey)).toBe(await fingerprint(id.sign.publicKey));
    expect(await fingerprint(id.sign.publicKey)).not.toBe(await fingerprint((await newIdentity()).sign.publicKey));
  });
  it('locks the key with a password', async () => {
    const k = newSeriesKey();
    const l = await lockKey(k, 'nastro', FAST);
    expect(JSON.stringify(l)).not.toContain(k);
    expect(await unlockKey(l, 'nastro')).toBe(k);
    await expect(unlockKey(l, 'sbagliata')).rejects.toThrow();
  });
  it('a return opens only with the musician\'s key, and each has a new one-off key', async () => {
    const id = await newIdentity();
    const a = await sealFor(id.box.publicKey, text('brividi'));
    const b = await sealFor(id.box.publicKey, text('brividi'));
    expect(a.epk.x).not.toBe(b.epk.x);
    expect(new TextDecoder().decode(await openFrom(id.box.privateKey, a))).toBe('brividi');
    await expect(openFrom((await newIdentity()).box.privateKey, a)).rejects.toThrow();
  });
  it('base64url round-trips', () => {
    const b = crypto.getRandomValues(new Uint8Array(1000));
    expect([...fromB64u(toB64u(b))]).toEqual([...b]);
  });
});
