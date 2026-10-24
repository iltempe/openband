// A variable-order Markov model (PPM-style back-off) over string tokens, for the ghost notes (G3):
// "what usually comes after these last few", learned with a weight per source — the song itself counts
// most, then the user's other songs, then the bundled corpus. Pure and small; no network.

export class Ppm {
  /** context (tokens joined by space) → next token → weighted count */
  private table = new Map<string, Map<string, number>>();
  constructor(readonly order = 3) {}

  /** Learn every transition of a sequence, for contexts of length 0..order. */
  train(seq: string[], weight = 1) {
    for (let i = 0; i < seq.length; i++)
      for (let k = 0; k <= this.order && k <= i; k++) {
        const ctx = seq.slice(i - k, i).join(' ');
        let next = this.table.get(ctx);
        if (!next) this.table.set(ctx, (next = new Map()));
        next.set(seq[i], (next.get(seq[i]) ?? 0) + weight);
      }
  }

  /**
   * Probabilities of the next token after `history`: the longest context seen, blended with the shorter
   * ones (escape weight ∝ how many different tokens followed), so rare contexts still leave room.
   */
  predict(history: string[]): Map<string, number> {
    const out = new Map<string, number>();
    let remaining = 1;
    for (let k = Math.min(this.order, history.length); k >= 0 && remaining > 1e-6; k--) {
      const next = this.table.get(history.slice(history.length - k).join(' '));
      if (!next) continue;
      let total = 0;
      for (const v of next.values()) total += v;
      const escape = next.size / (total + next.size);
      const share = remaining * (1 - escape);
      for (const [tok, v] of next) out.set(tok, (out.get(tok) ?? 0) + (share * v) / total);
      remaining *= escape;
    }
    // Whatever is left goes to what was seen at all (uniform over the 0-order vocabulary).
    const vocab = this.table.get('');
    if (vocab && remaining > 1e-6) for (const tok of vocab.keys()) out.set(tok, (out.get(tok) ?? 0) + remaining / vocab.size);
    return out;
  }

  /** log-probability of a token after a history (floored, never −∞). */
  logp(history: string[], token: string) {
    return Math.log(this.predict(history).get(token) ?? 1e-4);
  }
}

/** A small deterministic random generator (mulberry32): the same seed gives the same suggestions. */
export function rng(seed: number) {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a key from a distribution (weights need not sum to 1), with an optional temperature. */
export function sample<T>(dist: Map<T, number>, rand: () => number, temperature = 1): T | undefined {
  const items = [...dist].map(([k, p]) => [k, Math.pow(Math.max(p, 0), 1 / temperature)] as const);
  const total = items.reduce((s, [, p]) => s + p, 0);
  if (!(total > 0)) return items[0]?.[0];
  let r = rand() * total;
  for (const [k, p] of items) if ((r -= p) <= 0) return k;
  return items[items.length - 1][0];
}
