// The GPU scheduler (SPEC v0.6 §6, E4): engines on this computer that need a GPU queue per device — one
// heavy model runs at a time, the ones kept loaded fit the VRAM budget (the least recently used is
// unloaded first: its process is stopped), and the studio's interactive requests go before batch jobs.
// Engines elsewhere (url) and builtins are not scheduled here.

export class GpuScheduler {
  /**
   * budgetGb: VRAM per device ({ default: 8 } or { 'cuda:0': 24 }); null = unknown, keep one loaded.
   * unload(id): stop an engine (frees its VRAM).
   */
  constructor({ budgetGb = null, unload = async () => {}, now = () => Date.now() } = {}) {
    this.budget = budgetGb;
    this.unload = unload;
    this.now = now;
    /** device → { running: job | null, queue: job[] } */
    this.devices = new Map();
    /** id → { device, vram, lastUsed } */
    this.resident = new Map();
    this.seq = 0;
  }

  budgetFor(device) {
    if (this.budget == null) return null;
    return typeof this.budget === 'number' ? this.budget : (this.budget[device] ?? this.budget.default ?? null);
  }

  dev(device) {
    let d = this.devices.get(device);
    if (!d) this.devices.set(device, (d = { running: null, queue: [] }));
    return d;
  }

  /** Run fn for engine id on a device when it's its turn; interactive before batch, then first come first served. */
  run({ id, device = 'gpu', vram = 0, priority = 'interactive' }, fn) {
    const d = this.dev(device);
    return new Promise((resolve, reject) => {
      d.queue.push({ id, vram, priority, seq: this.seq++, fn, resolve, reject });
      d.queue.sort((a, b) => (a.priority === b.priority ? a.seq - b.seq : a.priority === 'interactive' ? -1 : 1));
      void this.next(device);
    });
  }

  async next(device) {
    const d = this.dev(device);
    if (d.running || !d.queue.length) return;
    const job = d.queue.shift();
    d.running = job;
    try {
      await this.makeRoom(device, job);
      this.resident.set(job.id, { device, vram: job.vram, lastUsed: this.now() });
      job.resolve(await job.fn());
    } catch (e) {
      job.reject(e);
    } finally {
      const r = this.resident.get(job.id);
      if (r) r.lastUsed = this.now();
      d.running = null;
      void this.next(device);
    }
  }

  /** Unload the least recently used engines of the device until the job fits (or only it is left). */
  async makeRoom(device, job) {
    const budget = this.budgetFor(device);
    const others = () => [...this.resident.entries()].filter(([id, r]) => r.device === device && id !== job.id).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const used = () => others().reduce((s, [, r]) => s + r.vram, 0);
    while (others().length && (budget == null || used() + job.vram > budget)) {
      const [id] = others()[0];
      this.resident.delete(id);
      await this.unload(id);
    }
  }

  forget(id) {
    this.resident.delete(id);
  }

  /** What the Ensemble panel shows: per engine, loaded / running / waiting. */
  stateOf(id) {
    let running = false;
    let queued = 0;
    for (const d of this.devices.values()) {
      if (d.running?.id === id) running = true;
      queued += d.queue.filter((j) => j.id === id).length;
    }
    const r = this.resident.get(id);
    return { loaded: !!r, running, queued, ...(r ? { device: r.device, vram_gb: r.vram } : {}) };
  }
}

/** Is an engine one the scheduler governs: on this computer, with a GPU and a VRAM need? */
export function gpuNeed(spec, manifest) {
  const rt = manifest?.runtime ?? {};
  if (spec?.url || rt.where === 'cloud' || rt.where === 'lan' || rt.where === 'builtin') return null;
  const gpu = (rt.device ?? []).find((d) => /^(cuda|mps|rocm|xpu)/.test(d));
  const vram = Number(rt.vram_gb) || 0;
  if (!gpu || !vram) return null;
  return { device: spec?.device ?? (gpu.startsWith('mps') ? 'mps' : gpu.startsWith('cuda') ? 'cuda:0' : gpu), vram };
}
