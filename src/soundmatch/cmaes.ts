// CMA-ES (Hansen's covariance matrix adaptation evolution strategy), small and self-contained, for the
// sound-alike search (SPEC v0.6 G5): (μ/μ_w, λ) with rank-one and rank-μ updates and cumulative step
// size adaptation, over parameters normalised to 0..1 (samples are clamped into the box). Ask / tell.
// Pure, seeded.

export interface CmaOptions {
  sigma?: number;
  lambda?: number;
  seed?: number;
}

function rng(seed: number) {
  let a = seed | 0 || 1;
  const u = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    // Box–Muller
    const r = Math.sqrt(-2 * Math.log(u() + 1e-12));
    return r * Math.cos(2 * Math.PI * u());
  };
}

/** Eigen-decomposition of a symmetric matrix (Jacobi rotations): C = B diag(d) Bᵀ. */
export function eigenSym(C: number[][]): { values: number[]; vectors: number[][] } {
  const n = C.length;
  const a = C.map((r) => r.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  return { values: a.map((r, i) => Math.max(1e-20, r[i])), vectors: v };
}

export class Cma {
  readonly n: number;
  readonly lambda: number;
  private mu: number;
  private w: number[];
  private mueff: number;
  private cc: number;
  private cs: number;
  private c1: number;
  private cmu: number;
  private damps: number;
  private chiN: number;
  mean: number[];
  sigma: number;
  private C: number[][];
  private pc: number[];
  private ps: number[];
  private B: number[][];
  private D: number[];
  private gauss: () => number;
  private gen = 0;
  private last: { x: number[]; z: number[] }[] = [];
  best: { x: number[]; f: number } = { x: [], f: Infinity };

  constructor(start: number[], o: CmaOptions = {}) {
    const n = (this.n = start.length);
    this.lambda = o.lambda ?? 4 + Math.floor(3 * Math.log(n));
    this.mu = Math.floor(this.lambda / 2);
    const raw = Array.from({ length: this.mu }, (_, i) => Math.log(this.mu + 0.5) - Math.log(i + 1));
    const sum = raw.reduce((a, b) => a + b, 0);
    this.w = raw.map((x) => x / sum);
    this.mueff = 1 / this.w.reduce((a, b) => a + b * b, 0);
    this.cc = (4 + this.mueff / n) / (n + 4 + (2 * this.mueff) / n);
    this.cs = (this.mueff + 2) / (n + this.mueff + 5);
    this.c1 = 2 / ((n + 1.3) ** 2 + this.mueff);
    this.cmu = Math.min(1 - this.c1, (2 * (this.mueff - 2 + 1 / this.mueff)) / ((n + 2) ** 2 + this.mueff));
    this.damps = 1 + 2 * Math.max(0, Math.sqrt((this.mueff - 1) / (n + 1)) - 1) + this.cs;
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    this.mean = start.slice();
    this.sigma = o.sigma ?? 0.25;
    this.C = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    this.B = this.C.map((r) => r.slice());
    this.D = Array(n).fill(1);
    this.pc = Array(n).fill(0);
    this.ps = Array(n).fill(0);
    this.gauss = rng(o.seed ?? 1);
  }

  /** λ new points, in the box [0,1]ⁿ. */
  ask(): number[][] {
    this.last = [];
    for (let k = 0; k < this.lambda; k++) {
      const z = Array.from({ length: this.n }, () => this.gauss());
      const y = this.B.map((row) => row.reduce((s, b, j) => s + b * this.D[j] * z[j], 0));
      const x = this.mean.map((m, i) => Math.max(0, Math.min(1, m + this.sigma * y[i])));
      this.last.push({ x, z });
    }
    return this.last.map((p) => p.x);
  }

  /** Their costs (lower is better), in the order asked. */
  tell(costs: number[]) {
    const n = this.n;
    const order = costs.map((f, i) => [f, i] as const).sort((a, b) => a[0] - b[0]);
    if (order[0][0] < this.best.f) this.best = { x: this.last[order[0][1]].x.slice(), f: order[0][0] };
    const old = this.mean.slice();
    const sel = order.slice(0, this.mu).map(([, i]) => this.last[i].x);
    this.mean = Array.from({ length: n }, (_, i) => sel.reduce((s, x, k) => s + this.w[k] * x[i], 0));
    const ys = sel.map((x) => x.map((v, i) => (v - old[i]) / this.sigma));
    const yw = Array.from({ length: n }, (_, i) => ys.reduce((s, y, k) => s + this.w[k] * y[i], 0));
    // C^(-1/2) yw = B D^-1 Bᵀ yw
    const bty = this.B[0].map((_, j) => this.B.reduce((s, row, i) => s + row[j] * yw[i], 0));
    const invsq = this.B.map((row) => row.reduce((s, b, j) => s + (b * bty[j]) / this.D[j], 0));
    this.ps = this.ps.map((p, i) => (1 - this.cs) * p + Math.sqrt(this.cs * (2 - this.cs) * this.mueff) * invsq[i]);
    const psNorm = Math.sqrt(this.ps.reduce((s, v) => s + v * v, 0));
    this.gen++;
    const hsig = psNorm / Math.sqrt(1 - (1 - this.cs) ** (2 * this.gen)) / this.chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    this.pc = this.pc.map((p, i) => (1 - this.cc) * p + hsig * Math.sqrt(this.cc * (2 - this.cc) * this.mueff) * yw[i]);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const rankMu = ys.reduce((s, y, k) => s + this.w[k] * y[i] * y[j], 0);
        this.C[i][j] = (1 - this.c1 - this.cmu) * this.C[i][j] + this.c1 * (this.pc[i] * this.pc[j] + (1 - hsig) * this.cc * (2 - this.cc) * this.C[i][j]) + this.cmu * rankMu;
      }
    this.sigma *= Math.exp((this.cs / this.damps) * (psNorm / this.chiN - 1));
    this.sigma = Math.min(0.6, Math.max(1e-4, this.sigma));
    const e = eigenSym(this.C);
    this.B = e.vectors;
    this.D = e.values.map(Math.sqrt);
  }
}

/** Minimise f over [0,1]ⁿ from a start, with a budget of evaluations (f takes a whole generation, for batching). */
export async function minimise(f: (xs: number[][]) => Promise<number[]>, start: number[], budget: number, o: CmaOptions & { onGeneration?: (best: number, evals: number) => void } = {}) {
  const cma = new Cma(start, o);
  let evals = 0;
  while (evals + cma.lambda <= budget) {
    const xs = cma.ask();
    const fs = await f(xs);
    evals += xs.length;
    cma.tell(fs);
    o.onGeneration?.(cma.best.f, evals);
  }
  return { x: cma.best.x, f: cma.best.f, evals };
}
