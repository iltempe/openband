// Pairing for studios served from a public site (the online demo): the bridge drives the studio, so a
// page from the internet only gets commands after the user typed the code this server shows.
// Pure (time and randomness can be injected), tested in pairing.test.ts.
import crypto from 'node:crypto';

export const DEFAULT_ALLOWED_ORIGINS = ['https://iltempe.github.io'];
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** 'local' (no pairing), 'pair' (allowed with a code) or 'reject'. A missing Origin is a non-browser client. */
export function classifyOrigin(origin, allowed = DEFAULT_ALLOWED_ORIGINS) {
  if (!origin || LOCAL.test(origin)) return 'local';
  return allowed.includes(origin.replace(/\/+$/, '')) ? 'pair' : 'reject';
}

export function parseAllowedOrigins(env) {
  if (env === undefined || env === null || env === '') return DEFAULT_ALLOWED_ORIGINS;
  return env
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export class Pairing {
  /**
   * @param {{ now?: () => number, ttlMs?: number, maxAttempts?: number, windowMs?: number, lockMs?: number, code?: string }} [o]
   */
  constructor(o = {}) {
    this.now = o.now ?? (() => Date.now());
    this.ttlMs = o.ttlMs ?? 10 * 60 * 1000;
    this.maxAttempts = o.maxAttempts ?? 5;
    this.windowMs = o.windowMs ?? 60 * 1000;
    this.lockMs = o.lockMs ?? 5 * 60 * 1000;
    this.fixedCode = o.code;
    this.tokens = new Set();
    this.failures = [];
    this.lockedUntil = 0;
    this.renew();
  }

  renew() {
    this.value = this.fixedCode ?? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.expires = this.now() + this.ttlMs;
    return this.value;
  }

  /** The current code (a new one when the old expired). */
  code() {
    if (this.now() >= this.expires) this.renew();
    return this.value;
  }

  /** "482913" → "482-913", easier to read aloud. */
  pretty() {
    const c = this.code();
    return `${c.slice(0, 3)}-${c.slice(3)}`;
  }

  /** Try a code. → { ok: true, token } or { ok: false, reason: 'locked'|'expired'|'wrong'|'missing', retryInMs? } */
  attempt(input) {
    const t = this.now();
    if (t < this.lockedUntil) return { ok: false, reason: 'locked', retryInMs: this.lockedUntil - t };
    const given = String(input ?? '').replace(/\D/g, '');
    if (!given) return { ok: false, reason: 'missing' };
    this.failures = this.failures.filter((f) => t - f < this.windowMs);
    if (t >= this.expires) {
      this.renew();
      this.failures.push(t);
      return this.afterFailure(t, 'expired');
    }
    if (given.length === this.value.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.value))) {
      const token = crypto.randomBytes(32).toString('hex');
      this.tokens.add(token);
      this.failures = [];
      // A used code is spent: the next device needs a fresh one.
      this.renew();
      return { ok: true, token };
    }
    this.failures.push(t);
    return this.afterFailure(t, 'wrong');
  }

  afterFailure(t, reason) {
    if (this.failures.length >= this.maxAttempts) {
      this.lockedUntil = t + this.lockMs;
      this.failures = [];
      return { ok: false, reason: 'locked', retryInMs: this.lockMs };
    }
    return { ok: false, reason, attemptsLeft: this.maxAttempts - this.failures.length };
  }

  /** Tokens live in memory only: a restarted server revokes them all. */
  valid(token) {
    return typeof token === 'string' && this.tokens.has(token);
  }
}
