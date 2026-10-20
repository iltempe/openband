// Web Audio Modules 2.0 host: loads WAM plugins (instruments and effects) from URLs, the web's
// open plugin standard. Plugins are ES modules whose default export has createInstance().
import * as Tone from 'tone';
import { getConfig } from '../config';
import { cutoffToHz } from '../music';
import type { Instrument } from './instruments';

/** The public WAM community collection (CORS-enabled). */
export const WAM_INDEX_URL = 'https://www.webaudiomodules.com/community/plugins.json';
const WAM_BASE = 'https://www.webaudiomodules.com/community/plugins/';

export interface WamCatalogEntry {
  identifier: string;
  name: string;
  vendor: string;
  description: string;
  kind: 'instrument' | 'effect' | 'other';
  url: string;
  thumbnail?: string;
  keywords: string[];
  categories: string[];
}

/** Minimal shapes of the WAM API we use (see @webaudiomodules/api). */
interface WamNodeLike extends AudioNode {
  scheduleEvents(...events: { type: string; time?: number; data: unknown }[]): void;
  clearEvents(): void;
  getParameterInfo(...ids: string[]): Promise<Record<string, { id: string; label: string; type: string; defaultValue: number; minValue: number; maxValue: number; units: string; choices: string[] }>>;
  getParameterValues(normalized?: boolean, ...ids: string[]): Promise<Record<string, { id: string; value: number; normalized: boolean }>>;
  setParameterValues(values: Record<string, { id: string; value: number; normalized: boolean }>): Promise<void>;
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<void>;
  destroy?(): void;
}
export interface WamInstance {
  audioNode: WamNodeLike;
  descriptor: { name: string; vendor: string; isInstrument?: boolean; hasAudioInput?: boolean; hasMidiInput?: boolean };
  name?: string;
  createGui(): Promise<HTMLElement>;
  destroyGui(el: HTMLElement): void;
}
interface WamFactory {
  createInstance(groupId: string, ctx: BaseAudioContext, initialState?: unknown): Promise<WamInstance>;
}

let catalog: Promise<WamCatalogEntry[]> | null = null;

/** The community plugin list, minus helpers that make no sense inside OpenBand (video, MIDI I/O…). */
export function wamCatalog(): Promise<WamCatalogEntry[]> {
  const cfg = getConfig();
  if (!cfg.features.plugins) return Promise.reject(new Error('Plugins are turned off on this OpenBand instance'));
  catalog ??= fetch(cfg.pluginCatalogUrl ?? WAM_INDEX_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((list: { identifier: string; name: string; vendor: string; description: string; category?: string[]; keywords?: string[]; path: string; thumbnail?: string }[]) =>
      list
        .map((p) => {
          const cats = (p.category ?? []).map((c) => c.toLowerCase());
          const kind: WamCatalogEntry['kind'] = cats.includes('instrument') ? 'instrument' : cats.includes('effect') ? 'effect' : 'other';
          return {
            identifier: p.identifier,
            name: p.name,
            vendor: p.vendor,
            description: p.description,
            kind,
            url: new URL(p.path, WAM_BASE).href,
            thumbnail: p.thumbnail ? new URL(p.thumbnail, WAM_BASE).href : undefined,
            keywords: p.keywords ?? [],
            categories: p.category ?? [],
          };
        })
        // Audio-track and audio-input plugins duplicate OpenBand features; video and hardware
        // editors need extensions this host doesn't provide.
        .filter((p) => p.kind !== 'other' && !/audioTrack|audioInput/.test(p.identifier)),
    )
    .catch((e) => {
      catalog = null;
      throw new Error(`Could not load the WAM plugin list: ${(e as Error).message}`);
    });
  return catalog;
}

/** Resolve a plugin reference: a catalog identifier, a catalog name, or a URL to its index.js. */
export async function resolvePlugin(ref: string): Promise<{ url: string; name: string; kind: WamCatalogEntry['kind'] }> {
  if (/^https?:\/\//i.test(ref)) {
    const known = (await wamCatalog().catch(() => [])).find((p) => p.url === ref);
    return { url: ref, name: known?.name ?? ref.split('/').slice(-3, -1).join(' '), kind: known?.kind ?? 'other' };
  }
  const q = ref.trim().toLowerCase();
  const list = await wamCatalog();
  const hit = list.find((p) => p.identifier.toLowerCase() === q) ?? list.find((p) => p.name.toLowerCase() === q) ?? list.find((p) => p.name.toLowerCase().includes(q));
  if (!hit) throw new Error(`Plugin "${ref}" not found. Call list_plugins, or pass the URL of the plugin's index.js.`);
  return { url: hit.url, name: hit.name, kind: hit.kind };
}

// ---------- loading ----------

const hostGroups = new WeakMap<BaseAudioContext, Promise<string>>();
const factories = new Map<string, Promise<WamFactory>>();

function hostGroup(ctx: BaseAudioContext) {
  let g = hostGroups.get(ctx);
  if (!g) {
    // Imported lazily: the SDK touches AudioWorkletNode at load time, which doesn't exist in Node (tests).
    g = import('@webaudiomodules/sdk').then(({ initializeWamHost }) => initializeWamHost(ctx)).then(([id]: [string, string]) => id);
    hostGroups.set(ctx, g);
  }
  return g;
}

function factory(url: string) {
  let f = factories.get(url);
  if (!f) {
    f = import(/* @vite-ignore */ url).then((m) => {
      if (!m.default?.createInstance) throw new Error('Not a Web Audio Module (no default export with createInstance)');
      return m.default as WamFactory;
    });
    f.catch(() => factories.delete(url));
    factories.set(url, f);
  }
  return f;
}

/** Instantiate a plugin in the given (native) audio context. */
export async function createWam(url: string, ctx: BaseAudioContext, state?: unknown): Promise<WamInstance> {
  const [group, F] = await Promise.all([hostGroup(ctx), factory(url)]);
  const instance = await F.createInstance(group, ctx, state ?? undefined);
  if (state !== undefined && state !== null) {
    try {
      await instance.audioNode.setState(state);
    } catch {
      // some plugins only accept state at creation time
    }
  }
  return instance;
}

const nativeContext = (n: Tone.ToneAudioNode) => n.context.rawContext as unknown as BaseAudioContext;

/** Live instances by key (`trackId:instrument` or `trackId:slotId`), for the GUI window and MCP. */
export const liveWams = new Map<string, WamInstance>();
/** Why a plugin failed to load, by the same key. */
export const wamErrors = new Map<string, string>();

// ---------- instrument ----------

/** A WAM instrument as a track instrument: notes become scheduled MIDI events. */
export class WamInstrument implements Instrument {
  output: Tone.Filter;
  ready: Promise<void>;
  instance: WamInstance | null = null;
  error: string | null = null;
  private held = new Set<number>();

  constructor(url: string, state?: unknown, private key?: string) {
    this.output = new Tone.Filter({ type: 'lowpass', frequency: 20000, rolloff: -12, Q: 0.5 });
    this.ready = createWam(url, nativeContext(this.output), state)
      .then((inst) => {
        this.instance = inst;
        // Tone.connect bridges native nodes (the plugin) and Tone nodes.
        Tone.connect(inst.audioNode, this.output);
        if (this.key) liveWams.set(this.key, inst);
      })
      .catch((e) => {
        this.error = (e as Error).message;
        if (this.key) wamErrors.set(this.key, this.error);
        console.warn('[openband] WAM instrument failed to load:', url, e);
      });
  }

  private send(bytes: number[], time: number) {
    this.instance?.audioNode.scheduleEvents({ type: 'wam-midi', time, data: { bytes } });
  }
  private now() {
    return this.output.context.currentTime;
  }
  trigger(pitch: number, duration: number, time: number, velocity: number) {
    this.send([0x90, pitch, Math.max(1, Math.round(velocity * 127))], time);
    this.send([0x80, pitch, 0], time + Math.max(0.02, duration));
  }
  noteOn(pitch: number, velocity: number, time?: number) {
    this.held.add(pitch);
    this.send([0x90, pitch, Math.max(1, Math.round(velocity * 127))], time ?? this.now());
  }
  noteOff(pitch: number, time?: number) {
    this.held.delete(pitch);
    this.send([0x80, pitch, 0], time ?? this.now());
  }
  setCutoff(v: number, time?: number) {
    this.output.frequency.rampTo(cutoffToHz(v), 0.05, time);
  }
  releaseAll() {
    const t = this.now();
    this.instance?.audioNode.clearEvents();
    for (const p of this.held) this.send([0x80, p, 0], t);
    this.held.clear();
    this.send([0xb0, 123, 0], t); // all notes off
  }
  dispose() {
    if (this.key && liveWams.get(this.key) === this.instance) liveWams.delete(this.key);
    const inst = this.instance;
    if (inst) {
      inst.audioNode.disconnect();
      inst.audioNode.destroy?.();
    }
    this.output.dispose();
  }
}

// ---------- effect ----------

/** A WAM effect between two gains. Until the plugin has loaded (or if it fails) audio passes dry. */
export class WamEffect {
  readonly input = new Tone.Gain(1);
  readonly output = new Tone.Gain(1);
  ready: Promise<void>;
  instance: WamInstance | null = null;
  error: string | null = null;
  private bypassed = false;

  constructor(readonly url: string, state?: unknown, private key?: string) {
    this.input.connect(this.output);
    this.ready = createWam(url, nativeContext(this.input), state)
      .then((inst) => {
        this.instance = inst;
        if (this.key) liveWams.set(this.key, inst);
        this.route();
      })
      .catch((e) => {
        this.error = (e as Error).message;
        if (this.key) wamErrors.set(this.key, this.error);
        console.warn('[openband] WAM effect failed to load:', url, e);
      });
  }

  setBypass(off: boolean) {
    this.bypassed = off;
    this.route();
  }

  private route() {
    this.input.disconnect();
    const node = this.instance?.audioNode;
    if (!node || this.bypassed) {
      this.input.connect(this.output);
      return;
    }
    node.disconnect();
    Tone.connect(this.input, node);
    Tone.connect(node, this.output);
  }

  dispose() {
    if (this.key && liveWams.get(this.key) === this.instance) liveWams.delete(this.key);
    this.instance?.audioNode.disconnect();
    this.instance?.audioNode.destroy?.();
    this.input.dispose();
    this.output.dispose();
  }
}
