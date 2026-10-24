// Undo that includes plugin state (F19). A plugin's internal state (anything its GUI changes, not just
// automatable parameters) lives in the project — `fx.plugins[].state` and the instrument's `wam.state` —
// so every undo step's snapshot carries it. This module keeps the live plugins and the project in step:
//   - GUI edits: while a plugin window is open its state is polled (every 750 ms, hashed); a change opens
//     an automatic "Edit <plugin>" step that closes after 1.5 s of quiet.
//   - Undo / redo / checkout / load: when the project's state for a live plugin changes, it is applied
//     with setState (polling paused, UI shows a spinner), so the plugin never ends up in a state that
//     didn't exist.
//   - Memory: history snapshots keep at most ~50 MB of plugin state; older steps lose it (flagged).
import { create } from 'zustand';
import type { HistoryEntry, Project } from './types';

/** `${trackId}:${slotId}` for effects, `${trackId}:instrument` for a plugin instrument. */
export type PluginKey = string;

export interface LivePlugin {
  name: string;
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<void>;
}

/** The plugin states a project holds, by live key. */
export function projectPluginStates(p: Project): Map<PluginKey, { state: unknown; name: string }> {
  const out = new Map<PluginKey, { state: unknown; name: string }>();
  for (const t of p.tracks) {
    const inst = p.instruments?.find((i) => i.id === t.instrument && (i.source === 'wam' || i.source === 'native'));
    if (inst?.wam) out.set(`${t.id}:instrument`, { state: inst.wam.state, name: inst.name });
    // Native plugins (G8): their state is the format's own chunk, base64.
    else if (inst?.native) out.set(`${t.id}:instrument`, { state: inst.native.state_b64, name: inst.name });
    for (const s of t.fx?.plugins ?? []) out.set(`${t.id}:${s.id}`, { state: (s.format ?? 'wam') === 'wam' ? s.state : s.native?.state_b64, name: s.name });
  }
  return out;
}

/** Write a plugin's state into a project draft. */
export function setProjectPluginState(d: Project, key: PluginKey, state: unknown) {
  const [trackId, slot] = key.split(':');
  const t = d.tracks.find((x) => x.id === trackId);
  if (!t) return;
  if (slot === 'instrument') {
    const inst = d.instruments?.find((i) => i.id === t.instrument);
    if (inst?.wam) inst.wam.state = state;
    else if (inst?.native) inst.native.state_b64 = state as string;
    return;
  }
  const s = t.fx?.plugins?.find((x) => x.id === slot);
  if (s && (s.format ?? 'wam') !== 'wam' && s.native) s.native.state_b64 = state as string;
  else if (s) s.state = state;
}

// ---------------------------------------------------------------- hashing

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(s: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    c = CRC[(c ^ code) & 0xff] ^ (c >>> 8);
    if (code > 0xff) c = CRC[(c ^ (code >>> 8)) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
/** Stable hash of a state (key order normalised); undefined stays undefined. */
export function stateHash(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const norm = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(norm) : x && typeof x === 'object' && !ArrayBuffer.isView(x) ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : ArrayBuffer.isView(x) ? Array.from(x as unknown as ArrayLike<number>) : x;
  const json = JSON.stringify(norm(v)) ?? 'null';
  return `${json.length}:${crc32(json)}`;
}

/** Names of the plugins whose state differs between two projects (for get_history). */
export function pluginsChanged(a: Project, b: Project): string[] {
  const A = projectPluginStates(a);
  const B = projectPluginStates(b);
  const names = new Set<string>();
  for (const [k, v] of B) if (stateHash(A.get(k)?.state) !== stateHash(v.state) && A.has(k)) names.add(v.name);
  return [...names];
}

// ---------------------------------------------------------------- memory limit

export const PLUGIN_HISTORY_LIMIT = 50 * 1024 * 1024;
const sizes = new WeakMap<Project, number>();
function pluginBytes(p: Project): number {
  let n = sizes.get(p);
  if (n === undefined) {
    n = 0;
    for (const { state } of projectPluginStates(p).values()) n += state === undefined ? 0 : (JSON.stringify(state) ?? '').length;
    sizes.set(p, n);
  }
  return n;
}
/**
 * Keep the plugin state of the newest steps within `limit` bytes; older steps keep everything else but
 * lose their plugin states (`pluginStateDropped`: undoing to them leaves the plugins as they are).
 */
export function trimPluginHistory(past: HistoryEntry[], limit = PLUGIN_HISTORY_LIMIT): HistoryEntry[] | null {
  let total = 0;
  let full = false;
  let changed = false;
  const out = [...past];
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i];
    if (e.pluginStateDropped) continue;
    const b = pluginBytes(e.project);
    // Newest first; once the budget is used, every older step loses its plugin state.
    if (!full && total + b <= limit) {
      total += b;
      continue;
    }
    full = true;
    const project = structuredClone(e.project);
    for (const k of projectPluginStates(project).keys()) setProjectPluginState(project, k, undefined);
    out[i] = { ...e, project, pluginStateDropped: true };
    changed = true;
  }
  return changed ? out : null;
}

// ---------------------------------------------------------------- live sync

export const usePluginSync = create<{ applying: number }>(() => ({ applying: 0 }));

export interface SyncDeps {
  /** Live plugins by key. */
  live: () => Map<PluginKey, LivePlugin>;
  project: () => Project;
  /** The key of the plugin whose window is open (polled), if any. */
  watched: () => PluginKey | null;
  commit: (mutate: (d: Project) => void, label: string) => void;
  beginEdit: (label: string) => string;
  endEdit: (id: string) => void;
  /** Is this edit step still the open transaction? (undo closes it) */
  isOpen: (id: string) => boolean;
  notify?: (msg: string) => void;
}

interface Known {
  /** Hash of the state the project holds for this plugin. */
  project?: string;
  /** Hash of what the live plugin reported last. */
  live?: string;
}

export class PluginStateSync {
  private known = new Map<PluginKey, Known>();
  private edit: { id: string; key: PluginKey; timer: ReturnType<typeof setTimeout> } | null = null;
  private applying = 0;
  quietMs = 1500;

  constructor(private deps: SyncDeps) {}

  get busy() {
    return this.applying > 0;
  }

  /** The project changed (any edit, undo, redo, checkout, load): push states that differ to the plugins. */
  async projectChanged() {
    const states = projectPluginStates(this.deps.project());
    const live = this.deps.live();
    const jobs: Promise<void>[] = [];
    for (const [key, plugin] of live) {
      const want = states.get(key);
      if (!want) continue;
      const h = stateHash(want.state);
      const k = this.known.get(key);
      if (!k) {
        // First sight (just created from this state): nothing to apply.
        this.known.set(key, { project: h });
        continue;
      }
      if (h === k.project) continue;
      k.project = h;
      // A step whose plugin state was dropped (memory limit): leave the plugin as it is.
      if (want.state === undefined) continue;
      if (k.live === h) continue;
      jobs.push(this.apply(key, plugin, want.state));
    }
    await Promise.all(jobs);
  }

  private async apply(key: PluginKey, plugin: LivePlugin, state: unknown) {
    this.applying++;
    usePluginSync.setState({ applying: this.applying });
    try {
      await plugin.setState(structuredClone(state));
      // What the plugin reports after setState is the new baseline (its own serialisation may differ).
      const k = this.known.get(key) ?? {};
      k.live = stateHash(await plugin.getState().catch(() => state));
      this.known.set(key, k);
    } catch (e) {
      this.deps.notify?.(`Could not restore ${plugin.name}: ${(e as Error).message}`);
    } finally {
      this.applying--;
      usePluginSync.setState({ applying: this.applying });
    }
  }

  /** One poll of the open plugin window. Returns true when it recorded a change. */
  async poll(): Promise<boolean> {
    if (this.applying) return false;
    const key = this.deps.watched();
    if (!key) return false;
    const plugin = this.deps.live().get(key);
    if (!plugin) return false;
    const state = await plugin.getState().catch(() => undefined);
    if (state === undefined || this.applying) return false;
    const h = stateHash(state)!;
    const k = this.known.get(key) ?? {};
    this.known.set(key, k);
    if (k.live === undefined) {
      // Opening the window is not an edit: the first reading is the baseline.
      k.live = h;
      if (k.project === undefined) k.project = stateHash(projectPluginStates(this.deps.project()).get(key)?.state);
      return false;
    }
    if (h === k.live) return false;
    k.live = h;
    k.project = h;
    this.recordEdit(key, plugin.name, state);
    return true;
  }

  /** A state the plugin now has (GUI or set_plugin_params): one undo step, extended while edits continue. */
  recordEdit(key: PluginKey, name: string, state: unknown, opts: { own?: boolean } = { own: true }) {
    const h = stateHash(state);
    this.known.set(key, { project: h, live: h });
    if (opts.own === false) {
      this.deps.commit((d) => setProjectPluginState(d, key, state), `Edit ${name}`);
      return;
    }
    if (!this.edit || this.edit.key !== key || !this.deps.isOpen(this.edit.id)) {
      this.closeEdit();
      this.edit = { id: this.deps.beginEdit(`Edit ${name}`), key, timer: 0 as unknown as ReturnType<typeof setTimeout> };
    }
    this.deps.commit((d) => setProjectPluginState(d, key, state), `Edit ${name}`);
    clearTimeout(this.edit.timer);
    this.edit.timer = setTimeout(() => this.closeEdit(), this.quietMs);
  }

  closeEdit() {
    if (!this.edit) return;
    clearTimeout(this.edit.timer);
    const id = this.edit.id;
    this.edit = null;
    this.deps.endEdit(id);
  }

  /** The plugin's state was copied into the project by someone else (periodic capture). */
  noteCaptured(key: PluginKey, state: unknown) {
    const h = stateHash(state);
    this.known.set(key, { project: h, live: h });
  }

  forget(key: PluginKey) {
    this.known.delete(key);
  }
}
