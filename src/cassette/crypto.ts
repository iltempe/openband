// The cassette's cryptography (D1.2, D2.2): standard WebCrypto only, nothing home-made. Runs the same in the
// studio, in the player and in Node. AES-256-GCM for content, ECDSA P-256 to sign, ECDH P-256 + HKDF-SHA256 for
// returns, PBKDF2-SHA256 for passwords.
const subtle = () => globalThis.crypto.subtle;
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const IV = 12;
export const PBKDF2_ITERATIONS = 600_000;

export function toB64u(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);
const buf = (b: Uint8Array) => b as unknown as BufferSource;

export const newSeriesKey = () => toB64u(rand(32));
const aesKey = (raw: string | Uint8Array) => subtle().importKey('raw', buf(typeof raw === 'string' ? fromB64u(raw) : raw), 'AES-GCM', false, ['encrypt', 'decrypt']);

/** iv + ciphertext (with its tag). */
export async function seal(key: string, plain: Uint8Array) {
  const iv = rand(IV);
  const c = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv) }, await aesKey(key), buf(plain)));
  const out = new Uint8Array(IV + c.length);
  out.set(iv);
  out.set(c, IV);
  return out;
}

export async function open(key: string, sealed: Uint8Array) {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(sealed.subarray(0, IV)) }, await aesKey(key), buf(sealed.subarray(IV))));
}

export const sha256 = async (b: Uint8Array) => [...new Uint8Array(await subtle().digest('SHA-256', buf(b)))].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Keys sorted at every level: what is signed is one string, whoever wrote the object. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

// ---- the musician's identity ----

const SIGN = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const DH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const SIG = { name: 'ECDSA', hash: 'SHA-256' } as const;

export interface Identity {
  sign: { publicKey: JsonWebKey; privateKey: JsonWebKey };
  box: { publicKey: JsonWebKey; privateKey: JsonWebKey };
}

const pair = async (algo: EcKeyGenParams, use: KeyUsage[]) => {
  const k = await subtle().generateKey(algo, true, use);
  return { publicKey: await subtle().exportKey('jwk', k.publicKey), privateKey: await subtle().exportKey('jwk', k.privateKey) };
};
export const newIdentity = async (): Promise<Identity> => ({ sign: await pair(SIGN, ['sign', 'verify']), box: await pair(DH, ['deriveBits']) });
export const newSigner = () => pair(SIGN, ['sign', 'verify']);

export async function signText(privateKey: JsonWebKey, text: string) {
  const k = await subtle().importKey('jwk', privateKey, SIGN, false, ['sign']);
  return toB64u(new Uint8Array(await subtle().sign(SIG, k, utf8(text))));
}

export async function verifyText(publicKey: JsonWebKey, text: string, signature: string) {
  const k = await subtle().importKey('jwk', publicKey, SIGN, false, ['verify']);
  return subtle().verify(SIG, k, buf(fromB64u(signature)), utf8(text));
}

const EMOJI = ['🎸', '🌙', '🚲', '🍋', '🎹', '🌵', '🦊', '🍉', '🥁', '🌊', '🦉', '🍄', '🎺', '🔥', '🐢', '🍇', '🎻', '⭐', '🐝', '🌻', '🎷', '🌈', '🐙', '🍒', '🪕', '❄️', '🦋', '🥝', '🪘', '⚡', '🐳', '🍓'];

/** Four emoji anyone can compare: the same key always gives the same four. */
export async function fingerprint(publicKey: JsonWebKey) {
  const h = await sha256(utf8(canonical({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y })));
  return [0, 2, 4, 6].map((i) => EMOJI[parseInt(h.slice(i, i + 2), 16) % EMOJI.length]).join('');
}

// ---- passwords ----

/** The series key, locked by a password. The link then holds no key. */
export async function lockKey(seriesKey: string, password: string, iterations = PBKDF2_ITERATIONS) {
  const salt = rand(16);
  const wrap = await passwordKey(password, salt, iterations);
  return { salt: toB64u(salt), iterations, sealed: toB64u(await seal(wrap, fromB64u(seriesKey))) };
}

async function passwordKey(password: string, salt: Uint8Array, iterations: number) {
  const base = await subtle().importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  return toB64u(new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations }, base, 256)));
}

export async function unlockKey(l: { salt: string; iterations: number; sealed: string }, password: string) {
  return toB64u(await open(await passwordKey(password, fromB64u(l.salt), l.iterations), fromB64u(l.sealed)));
}

// ---- returns: only the musician can read them ----

async function shared(privateKey: CryptoKey, publicKey: CryptoKey, salt: Uint8Array) {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hk = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveBits']);
  return toB64u(new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: utf8('openband-reply/1') }, hk, 256)));
}

/** A one-off key on the listener's side, so past returns stay closed if the listener's device is lost. */
export async function sealFor(boxKey: JsonWebKey, plain: Uint8Array) {
  const eph = await subtle().generateKey(DH, true, ['deriveBits']);
  const salt = rand(16);
  const pub = await subtle().importKey('jwk', boxKey, DH, false, []);
  const body = await seal(await shared(eph.privateKey, pub, salt), plain);
  return { epk: await subtle().exportKey('jwk', eph.publicKey), salt: toB64u(salt), body: toB64u(body) };
}

export async function openFrom(privateKey: JsonWebKey, box: { epk: JsonWebKey; salt: string; body: string }) {
  const mine = await subtle().importKey('jwk', privateKey, DH, false, ['deriveBits']);
  const pub = await subtle().importKey('jwk', box.epk, DH, false, []);
  return open(await shared(mine, pub, fromB64u(box.salt)), fromB64u(box.body));
}
