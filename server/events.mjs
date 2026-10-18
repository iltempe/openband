// Studio → AI events: a ring buffer with long-polling waiters. Pure (no I/O), tested with Vitest.

export class EventBuffer {
  constructor(capacity = 500) {
    this.capacity = capacity;
    this.events = [];
    this.lastId = 0;
    this.waiters = new Set();
  }

  /** Store an event from the studio; resolves any waiter interested in its kind. */
  push(event) {
    const e = { ...event, id: ++this.lastId, at: event.at ?? Date.now() };
    this.events.push(e);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    for (const w of [...this.waiters]) {
      if (!w.kinds || w.kinds.includes(e.kind)) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(e);
      }
    }
    return e;
  }

  /** Events after since_id (all buffered if omitted), optionally filtered by kind. */
  list({ since_id, kinds, limit = 100 } = {}) {
    const out = this.events.filter((e) => (since_id === undefined || e.id > since_id) && (!kinds || kinds.includes(e.kind)));
    return { events: out.slice(-limit), last_id: this.lastId };
  }

  /**
   * Wait for the next matching event. With since_id, an already-buffered newer event is returned
   * immediately. Resolves { timeout: true } after timeoutMs.
   */
  wait({ kinds, timeout_ms = 30000, since_id } = {}) {
    if (since_id !== undefined) {
      const hit = this.events.find((e) => e.id > since_id && (!kinds || kinds.includes(e.kind)));
      if (hit) return Promise.resolve(hit);
    }
    const ms = Math.max(0, Math.min(60000, timeout_ms));
    return new Promise((resolve) => {
      const w = { kinds, resolve };
      w.timer = setTimeout(() => {
        this.waiters.delete(w);
        resolve({ timeout: true, last_id: this.lastId });
      }, ms);
      this.waiters.add(w);
    });
  }
}
