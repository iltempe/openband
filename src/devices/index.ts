// Devices in the studio (R3.4): their state, mappings live, and movement recorded as automation in one undo step.
import { create } from 'zustand';
import { engine } from '../audio/engine';
import { engineRequest, onDeviceFrame } from '../bridge';
import { parseTargetKey, setPoints, targetRange } from '../automation';
import { useRecSetup } from '../recording';
import { useStore } from '../store';
import { connectSerial } from './serial';
import { mapValue, smoother, thinPoints, type DeviceMapping } from './mapping';

export interface DeviceInfo {
  id: string;
  name: string;
  hardware: string;
  controls: { id: string; label: string; kind: string }[];
  outputs: { id: string; kind: string }[];
  latency_ms: number | null;
  streaming: boolean;
  manifest_hash: string;
}

export const useDevices = create<{ list: DeviceInfo[]; values: Record<string, Record<string, number>>; ask: { name: string; resolve: (ok: boolean) => void } | null }>(() => ({ list: [], values: {}, ask: null }));

const st = () => useStore.getState();
/** "the filter" is the tone control; the track's fields have older names. */
const ALIASES: Record<string, string> = { cutoff: 'tone', filter: 'tone', delay: 'echo' };
const FIELDS: Record<string, string> = { volume: 'volume', pan: 'pan', tone: 'cutoff', reverb: 'reverb', echo: 'delay' };
const targetOf = (k: string) => parseTargetKey(k.includes(':') ? k : `mix:${ALIASES[k] ?? k}`);
const smoothers = new Map<string, ReturnType<typeof smoother>>();
const lastAt = new Map<string, number>();
/** While playing: the gesture per mapping, written as automation when the song stops. */
const takes = new Map<string, { m: DeviceMapping; points: { beat: number; value: number }[] }>();
const LIVE_MS = 33;
const key = (m: DeviceMapping) => `${m.deviceId}:${m.control}:${m.trackId}:${m.target}`;

const live: { pending: Map<string, { m: DeviceMapping; value: number }>; timer: ReturnType<typeof setTimeout> | null } = { pending: new Map(), timer: null };

/** At most 30 times a second: a commit per sensor frame would flood the store. */
function flushLive() {
  live.timer = null;
  const items = [...live.pending.values()];
  live.pending.clear();
  st().commit(
    (d) => {
      for (const { m, value } of items) {
        const t = d.tracks.find((x) => x.id === m.trackId);
        const target = targetOf(m.target);
        if (!t || !target) continue;
        if (target.kind === 'mix') (t as unknown as Record<string, number>)[FIELDS[target.param]] = value;
        else if (target.kind === 'fx') ((t.fx ??= {} as never) as unknown as Record<string, Record<string, number>>)[target.unit] = { ...((t.fx as unknown as Record<string, Record<string, number>>)[target.unit] ?? {}), [target.param]: value };
      }
    },
    { history: false },
  );
}

function onFrame(deviceId: string, f: { t: number; values: Record<string, number> }) {
  useDevices.setState((s) => ({ values: { ...s.values, [deviceId]: f.values } }));
  const now = f.t * 1000;
  for (const m of st().project.deviceMappings ?? []) {
    if (m.deviceId !== deviceId || f.values[m.control] === undefined) continue;
    const k = key(m);
    const dt = now - (lastAt.get(k) ?? now);
    lastAt.set(k, now);
    if (!smoothers.has(k)) smoothers.set(k, smoother(m.smoothMs));
    const value = smoothers.get(k)!(mapValue(f.values[m.control], m), dt);
    live.pending.set(k, { m, value });
    live.timer ??= setTimeout(flushLive, LIVE_MS);
    if (st().isPlaying && (m.write || useRecSetup.getState().armed[m.trackId] !== undefined)) {
      const take = takes.get(k) ?? { m, points: [] };
      take.points.push({ beat: engine.position, value });
      takes.set(k, take);
    }
  }
}

/** The gesture becomes automation: one undo takes it all away. */
export function commitTakes() {
  if (!takes.size) return 0;
  const items = [...takes.values()];
  takes.clear();
  st().commit(
    (d) => {
      for (const { m, points } of items) {
        const t = d.tracks.find((x) => x.id === m.trackId);
        const target = targetOf(m.target);
        if (!t || !target) continue;
        setPoints(t, target, thinPoints(points));
      }
    },
    { label: 'Record device movement' },
  );
  return items.length;
}

export async function refreshDevices() {
  const list = await engineRequest<DeviceInfo[]>('device_list');
  useDevices.setState((s) => ({ list: [...list, ...s.list.filter((d) => d.manifest_hash === 'usb')] }));
}

export async function connectDevice(url: string, token?: string) {
  const d = await engineRequest<DeviceInfo>('device_connect', { url, token });
  await engineRequest('device_watch', { device: d.id });
  st().commit((p) => void (p.devices = [...(p.devices ?? []).filter((x) => x.id !== d.id), { id: d.id, url, manifestHash: d.manifest_hash }]), { label: `Connect ${d.name}` });
  await refreshDevices();
  return d;
}

export function mapControl(a: { device: string; control: string; track_id: string; target: string; curve?: DeviceMapping['curve']; range?: [number, number]; smooth_ms?: number; write?: boolean }) {
  const target = targetOf(a.target);
  if (!target) throw new Error(`"${a.target}" is not a target. Call list_automatable.`);
  const r = targetRange(target);
  const m: DeviceMapping = { deviceId: a.device, control: a.control, trackId: a.track_id, target: a.target, curve: a.curve ?? 'linear', min: a.range?.[0] ?? r.min, max: a.range?.[1] ?? r.max, smoothMs: a.smooth_ms ?? 20, ...(a.write ? { write: true } : {}) };
  st().commit((p) => void (p.deviceMappings = [...(p.deviceMappings ?? []).filter((x) => key(x) !== key(m)), m]), { label: `Map ${a.control}` });
  return m;
}

export function unmapControl(a: { device: string; control: string }) {
  st().commit((p) => void (p.deviceMappings = (p.deviceMappings ?? []).filter((x) => !(x.deviceId === a.device && x.control === a.control))), { label: `Unmap ${a.control}` });
  return { unmapped: a.control };
}

const allowed = new Set<string>();
/** The first time a device is driven, the person says yes: it is hardware in the room. */
export async function deviceSet(device: string, output: string, value: number) {
  if (!allowed.has(device)) {
    const name = useDevices.getState().list.find((d) => d.id === device)?.name ?? device;
    const ok = await new Promise<boolean>((resolve) => useDevices.setState({ ask: { name, resolve } }));
    useDevices.setState({ ask: null });
    if (!ok) throw new Error('Not sent: the user did not confirm it in the studio.');
    allowed.add(device);
  }
  await engineRequest('device_set', { device, output, value });
  return { device, output, value };
}

/** A USB device, in this browser: no server between. */
export async function connectUsb() {
  let id = '';
  await connectSerial(
    (d) => {
      id = d.manifest.engine.id;
      useDevices.setState((s) => ({ list: [...s.list.filter((x) => x.id !== id), { id, name: d.manifest.engine.name, hardware: d.manifest.device.hardware, controls: d.manifest.device.controls, outputs: d.manifest.device.outputs ?? [], latency_ms: null, streaming: true, manifest_hash: 'usb' }] }));
    },
    (values) => id && onFrame(id, { t: performance.now() / 1000, values }),
  );
}

export function initDevices() {
  onDeviceFrame(onFrame);
  useStore.subscribe((s, prev) => {
    if (prev.isPlaying && !s.isPlaying) commitTakes();
  });
}
