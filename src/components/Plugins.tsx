// Web Audio Module plugins: browser (catalog + URL), floating plugin window, effect slots.
import { usePluginSync } from '../pluginHistory';
import { LevelMatchControl } from './LevelMatch';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { create } from 'zustand';
import type { Track } from '../types';
import { getTrack, useStore } from '../store';
import { wamCatalog, type WamCatalogEntry } from '../audio/wam';
import { addNativeEffect, addNativeInstrument, addPluginEffect, addPluginInstrument, captureWamStates, livePlugin, pluginSync, removePluginEffect, searchPlugins, updateSlot } from '../plugins';
import { desktopNative, liveNative, restartNative, useNativeStatus, type NativePluginInfo } from '../audio/native';
import { t, useT } from '../i18n';
import { engine } from '../audio/engine';
import * as I from './Icons';

type Mode = 'instrument' | 'effect' | 'any';
export const usePluginBrowser = create<{ open: boolean; mode: Mode; trackId?: string }>(() => ({ open: false, mode: 'any' }));
export const openPluginBrowser = (mode: Mode = 'any', trackId?: string) => usePluginBrowser.setState({ open: true, mode, trackId });

const notify = (m: string) => useStore.getState().notify(m);

async function addEntry(url: string, kind: WamCatalogEntry['kind'] | 'other', trackId?: string) {
  const s = useStore.getState();
  if (kind === 'instrument') {
    const sel = getTrack(s.project, trackId ?? s.selectedTrackId);
    const r = await addPluginInstrument(url, sel?.kind === 'instrument' && trackId ? sel.id : undefined);
    s.set({ pluginWindow: { trackId: r.track_id!, slotId: null } });
    return r.name;
  }
  const target = getTrack(s.project, trackId ?? s.selectedTrackId);
  if (!target) throw new Error(t('plug.needTrack'));
  const r = await addPluginEffect(target.id, url);
  s.set({ pluginWindow: { trackId: target.id, slotId: r.slot_id }, bottom: 'fx' });
  return r.name;
}

/** Native plugins installed on this computer (desktop app, G8), effects for now. */
function InstalledPlugins({ kind, query, trackId, onAdded }: { kind: Mode; query: string; trackId?: string; onAdded: () => void }) {
  const tr = useT();
  const dn = desktopNative();
  const [found, setFound] = useState<{ plugins: NativePluginInfo[]; failed: { path: string; reason: string }[] } | null>(null);
  const [scanning, setScanning] = useState(false);
  const scan = async (retry: string[] = []) => {
    if (!dn) return;
    setScanning(true);
    try {
      setFound(await dn.scan({ retry }));
    } catch (e) {
      notify(tr('imp.failed', { error: (e as Error).message }));
    } finally {
      setScanning(false);
    }
  };
  useEffect(() => {
    void scan();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!dn) return null;
  const q = query.trim().toLowerCase();
  const shown = (found?.plugins ?? []).filter((p) => p.kind !== 'note-effect' && (kind === 'any' || p.kind === kind) && (!q || `${p.name} ${p.vendor} ${p.features.join(' ')} ${p.description}`.toLowerCase().includes(q)));
  const add = (p: NativePluginInfo) => {
    // Native plugins run with the user's privileges: say so once, before the first one.
    let warned = false;
    try {
      warned = localStorage.getItem('openband.nativeWarned') === '1';
    } catch {}
    if (!warned) {
      if (!window.confirm(tr('nat.warning'))) return;
      try {
        localStorage.setItem('openband.nativeWarned', '1');
      } catch {}
    }
    const s = useStore.getState();
    const target = getTrack(s.project, trackId ?? s.selectedTrackId);
    try {
      if (p.kind === 'instrument') {
        // On the track the browser was opened for (an instrument track), otherwise on a new one.
        const r = addNativeInstrument(p, trackId && target?.kind === 'instrument' ? target.id : undefined);
        s.set({ pluginWindow: { trackId: r.track_id!, slotId: null } });
        notify(tr('plug.added', { name: r.name }));
        return onAdded();
      }
      if (!target) throw new Error(t('plug.needTrack'));
      const r = addNativeEffect(target.id, p);
      s.set({ bottom: 'fx', selectedTrackId: target.id });
      notify(tr('plug.added', { name: r.name }));
      onAdded();
    } catch (e) {
      notify(tr('imp.failed', { error: (e as Error).message }));
    }
  };
  return (
    <div className="plug-native">
      <div className="plug-native-head">
        <span className="smart-kicker">{tr('nat.installed')}</span>
        <button className="mini" disabled={scanning} onClick={() => void scan()}>
          {scanning ? tr('nat.scanning') : tr('nat.rescan')}
        </button>
      </div>
      {found && !shown.length && <div className="ai-log-empty">{tr('nat.none')}</div>}
      {shown.map((p) => (
        <div key={`${p.path}:${p.id}`} className="plug-item">
          <div className={`plug-thumb native f-${p.format}`}>{p.format.toUpperCase()}</div>
          <div className="plug-text">
            <div className="plug-name">
              {p.name} <span className="plug-kind">{tr(`plug.kind.${p.kind}` as 'plug.kind.any')}</span>
            </div>
            <div className="plug-desc">
              {p.vendor} {p.version} · {p.features.join(', ')}
            </div>
          </div>
          <button className="mini" onClick={() => add(p)}>
            {tr('sf.add')}
          </button>
        </div>
      ))}
      {!!found?.failed.length && (
        <details className="plug-ignored">
          <summary>{tr('nat.ignored', { n: found.failed.length })}</summary>
          {found.failed.map((f) => (
            <div key={f.path} className="plug-ignored-row">
              <span title={f.path}>{f.path.split(/[\\/]/).pop()}</span>
              <span className="plug-desc">{f.reason}</span>
              <button className="mini" disabled={scanning} onClick={() => void scan([f.path])}>
                {tr('nat.retry')}
              </button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

export function PluginBrowser() {
  const { open, mode, trackId } = usePluginBrowser();
  const [all, setAll] = useState<WamCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Mode>(mode);
  const [ranked, setRanked] = useState<WamCatalogEntry[] | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const tr = useT();

  useEffect(() => {
    if (!open) return;
    setKind(mode);
    wamCatalog().then(setAll, (e) => setError((e as Error).message));
  }, [open, mode]);

  // Plain-language search ("warm tube overdrive", "riverbero ampio") ranks the catalog.
  useEffect(() => {
    if (!query.trim()) return setRanked(null);
    let live = true;
    searchPlugins(query, kind === 'any' ? undefined : kind, 60).then((r) => live && setRanked(r), () => live && setRanked([]));
    return () => {
      live = false;
    };
  }, [query, kind]);

  const shown = useMemo(() => (ranked ?? all ?? []).filter((p) => kind === 'any' || p.kind === kind), [ranked, all, kind]);
  if (!open) return null;
  const close = () => {
    usePluginBrowser.setState({ open: false });
    setQuery('');
  };
  const add = async (key: string, u: string, k: WamCatalogEntry['kind'] | 'other') => {
    setBusy(key);
    try {
      const name = await addEntry(u, k === 'other' ? (kind === 'instrument' ? 'instrument' : 'effect') : k, trackId);
      notify(tr('plug.added', { name }));
      close();
    } catch (e) {
      notify(tr('imp.failed', { error: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal plugin-browser">
        <div className="modal-head">
          <div>
            <div className="lib-title">{tr('plug.title')}</div>
            <div className="lib-sub">{tr('plug.sub')}</div>
          </div>
          <button className="icon-btn" onClick={close}>
            <I.Close />
          </button>
        </div>
        <div className="plug-filters">
          {(['any', 'instrument', 'effect'] as Mode[]).map((k) => (
            <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
              {tr(`plug.kind.${k}` as 'plug.kind.any')}
            </button>
          ))}
        </div>
        <input className="modal-search" autoFocus placeholder={tr('plug.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="modal-list">
          <InstalledPlugins kind={kind} query={query} trackId={trackId} onAdded={close} />
          {error && <div className="wave-missing">{error}</div>}
          {!all && !error && <div className="ai-log-empty">{tr('imp.loading')}</div>}
          {shown.map((p) => (
            <div key={p.identifier} className="plug-item">
              <div className="plug-thumb" style={p.thumbnail ? { backgroundImage: `url("${p.thumbnail}")` } : undefined} />
              <div className="plug-text">
                <div className="plug-name">
                  {p.name} <span className="plug-kind">{tr(`plug.kind.${p.kind}` as 'plug.kind.any')}</span>
                </div>
                <div className="plug-desc">
                  {p.vendor} · {p.description}
                </div>
              </div>
              <button className="mini" disabled={busy !== null} onClick={() => add(p.identifier, p.url, p.kind)}>
                {busy === p.identifier ? tr('sf.importing') : tr('sf.add')}
              </button>
            </div>
          ))}
          {all && !shown.length && <div className="ai-log-empty">{tr('sf.none')}</div>}
        </div>
        <form
          className="plug-url"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) void add('url', url.trim(), 'other');
          }}
        >
          <input placeholder={tr('plug.urlPlaceholder')} value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="mini" type="submit" disabled={!url.trim() || busy !== null}>
            {tr('plug.load')}
          </button>
        </form>
        <div className="modal-foot">{tr('plug.hint')}</div>
      </div>
    </div>
  );
}

/**
 * A native plugin (G8): its own window, opened by the host and floating above the studio, and its
 * parameters as sliders here — the same everywhere, also where the plugin has no window (Linux for now).
 */
function NativePanel({ pluginKey, name }: { pluginKey: string; name: string }) {
  const tr = useT();
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const status = useNativeStatus((s) => s[pluginKey]);
  const [n, setN] = useState(() => liveNative(pluginKey));
  useEffect(() => {
    // It may still be loading: look again until it is there.
    if (n) return;
    const t = setInterval(() => setN(liveNative(pluginKey)), 300);
    return () => clearInterval(t);
  }, [n, pluginKey]);
  useEffect(() => {
    if (!n) return;
    void n.refreshValues();
    return n.subscribe(redraw);
  }, [n]);
  if (!n) return <div className="ai-log-empty">{desktopNative() ? tr('plug.loadingGui') : tr('nat.needDesktop')}</div>;
  if (n.error) return <div className="wave-missing">{n.error}</div>;
  const q = query.trim().toLowerCase();
  const params = n.params.filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, 80);
  const save = () => void n.getState().then((b64) => b64 && pluginSync.recordEdit(pluginKey, name, b64));
  const toggleGui = async () => {
    setBusy(true);
    try {
      const r = await n.gui(!status?.gui);
      if (!r.open && r.supported === false) notify(tr('nat.noWindow'));
      else if (r.error) notify(r.error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="native-panel">
      <div className="native-head">
        {n.hasGui && (
          <button className="btn primary" disabled={busy} onClick={() => void toggleGui()}>
            <I.Fx width={14} height={14} /> {status?.gui ? tr('nat.closeWindow') : tr('nat.openWindow')}
          </button>
        )}
        <input className="native-search" placeholder={tr('nat.searchParams', { n: n.params.length })} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {!n.params.length && <div className="ai-log-empty">{tr('nat.noParams')}</div>}
      <div className="native-params">
        {params.map((p) => {
          const v = n.values.get(p.id) ?? p.value;
          return (
            <label key={p.id} className="native-param">
              <span className="native-param-name" title={p.name}>
                {p.name}
              </span>
              <input type="range" min={p.min} max={p.max} step={p.stepped ? 1 : (p.max - p.min) / 1000 || 0.001} value={v} onChange={(e) => n.setParam(p.id, Number(e.target.value))} onPointerUp={save} onKeyUp={save} />
              <span className="native-param-value">{p.stepped ? Math.round(v) : +v.toFixed(3)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Floating window with the plugin's own GUI. */
export function PluginWindow() {
  const win = useStore((s) => s.pluginWindow);
  const project = useStore((s) => s.project);
  const mount = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [pos, setPos] = useState({ x: 80, y: 90 });
  const tr = useT();

  const track = win ? getTrack(project, win.trackId) : undefined;
  const slot = win?.slotId ? track?.fx?.plugins?.find((p) => p.id === win.slotId) : undefined;
  const instrument = project.instruments?.find((i) => i.id === track?.instrument);
  const name = slot?.name ?? instrument?.name ?? '';
  // Native plugins (G8) have their own window, opened by the host, and a panel of parameters here.
  const native = win ? (slot ? (slot.format ?? 'wam') !== 'wam' : instrument?.source === 'native') : false;

  useEffect(() => {
    if (!win || native) return;
    let gui: HTMLElement | null = null;
    let destroy: (() => void) | null = null;
    let alive = true;
    setStatus('loading');
    livePlugin(win.trackId, win.slotId ?? undefined)
      .then(async (inst) => {
        const el = await inst.createGui();
        if (!alive || !mount.current) return inst.destroyGui(el);
        gui = el;
        mount.current.replaceChildren(el);
        destroy = () => inst.destroyGui(el);
        setStatus('ready');
      })
      .catch((e) => {
        if (!alive) return;
        setMessage((e as Error).message);
        setStatus('error');
      });
    return () => {
      alive = false;
      if (gui) destroy?.();
      void captureWamStates();
    };
  }, [win?.trackId, win?.slotId]);

  if (!win || !track) return null;
  const startDrag = (e: React.PointerEvent) => {
    const x0 = e.clientX - pos.x;
    const y0 = e.clientY - pos.y;
    const move = (ev: PointerEvent) => setPos({ x: Math.max(0, ev.clientX - x0), y: Math.max(0, ev.clientY - y0) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="plugin-window" style={{ left: pos.x, top: pos.y, '--track': track.color } as React.CSSProperties}>
      <div className="plugin-window-head" onPointerDown={startDrag}>
        <I.Fx width={14} height={14} />
        <span className="plugin-window-title">{name}</span>
        <span className="plugin-window-sub">{track.name}</span>
        <button className="icon-btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => useStore.getState().set({ pluginWindow: null })}>
          <I.Close width={14} height={14} />
        </button>
      </div>
      <div className="plugin-window-body">
        {native ? (
          <NativePanel pluginKey={`${win.trackId}:${win.slotId ?? 'instrument'}`} name={name} />
        ) : (
          <>
            {status === 'loading' && <div className="ai-log-empty">{tr('plug.loadingGui')}</div>}
            {status === 'error' && <div className="wave-missing">{message}</div>}
            <div ref={mount} />
          </>
        )}
      </div>
    </div>
  );
}

/** Effect plugin slots shown in the Effects panel. */
/** A native plugin that crashed (or couldn't load): the track plays bypassed; Restart or Remove. */
function NativeSlotStatus({ trackId, slotId }: { trackId: string; slotId: string }) {
  const tr = useT();
  const st = useNativeStatus((s) => s[`${trackId}:${slotId}`]);
  const [busy, setBusy] = useState(false);
  if (!st?.crashed && !st?.error) return null;
  return (
    <span className={`plug-crash ${st.crashed ? 'crashed' : ''}`} role="status" title={st.crashed ?? st.error}>
      {st.crashed ? tr('nat.crashed') : tr('nat.error')}
      {st.crashed && (
        <button
          className="mini"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            restartNative(`${trackId}:${slotId}`)
              .catch((e: Error) => notify(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {tr('nat.restart')}
        </button>
      )}
    </span>
  );
}

/** The latency a plugin adds, compensated by the engine (G8): shown when there is some. */
function SlotLatency({ trackId, slotId }: { trackId: string; slotId: string }) {
  const tr = useT();
  const [samples, setSamples] = useState(0);
  useEffect(() => {
    const read = () => setSamples(engine.pluginLatency(trackId, slotId));
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, [trackId, slotId]);
  if (!samples) return null;
  const ms = (samples / engine.sampleRateNow()) * 1000;
  return (
    <span className="plug-latency" title={tr('plug.latencyHint', { samples })}>
      {ms.toFixed(1)} ms
    </span>
  );
}

export function PluginSlots({ track }: { track: Track }) {
  const slots = track.fx?.plugins ?? [];
  const set = useStore((s) => s.set);
  const tr = useT();
  return (
    <div className={`fx-unit plug-slots ${slots.length ? 'on' : ''}`}>
      <div className="fx-unit-head">
        <span className="fx-unit-title">{tr('plug.slots')}</span>
        <button className="mini" onClick={() => openPluginBrowser('effect', track.id)}>
          <I.Plus width={12} height={12} /> {tr('plug.add')}
        </button>
      </div>
      <div className="plug-slot-list">
        {!slots.length && <div className="plug-empty">{tr('plug.none')}</div>}
        {slots.map((s) => (
          <div key={s.id} className="plug-slot">
            <button className={`fx-power ${s.on ? 'on' : ''}`} onClick={() => updateSlot(track.id, s.id, (x) => void (x.on = !x.on))}>
              <span className="dot" />
            </button>
            <NativeSlotStatus trackId={track.id} slotId={s.id} />
            <span className="plug-slot-name">{s.name}</span>
            {s.format && s.format !== 'wam' && <span className={`plug-format f-${s.format}`}>{s.format.toUpperCase()}</span>}
            <SlotLatency trackId={track.id} slotId={s.id} />
            {s.format !== 'test' && (
              <button className="mini" onClick={() => set({ pluginWindow: { trackId: track.id, slotId: s.id } })}>
                {tr('plug.edit')}
              </button>
            )}
            <LevelMatchControl track={track} slotId={s.id} compact />
            <button className="mini danger" onClick={() => removePluginEffect(track.id, s.id)}>
              <I.Close width={12} height={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** While undo/redo restores plugin states the studio waits (no clicks that would race with it). */
export function PluginRestoreOverlay() {
  const busy = usePluginSync((s) => s.applying > 0);
  const tr = useT();
  if (!busy) return null;
  return (
    <div className="plugin-restore" role="status" aria-live="polite">
      <span className="spinner" /> {tr('plg.restoring')}
    </div>
  );
}
