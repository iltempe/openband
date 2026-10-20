// Web Audio Module plugins: browser (catalog + URL), floating plugin window, effect slots.
import { usePluginSync } from '../pluginHistory';
import { LevelMatchControl } from './LevelMatch';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { Track } from '../types';
import { getTrack, useStore } from '../store';
import { wamCatalog, type WamCatalogEntry } from '../audio/wam';
import { addPluginEffect, addPluginInstrument, captureWamStates, livePlugin, removePluginEffect, searchPlugins, updateSlot } from '../plugins';
import { t, useT } from '../i18n';
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
  const name = slot?.name ?? project.instruments?.find((i) => i.id === track?.instrument)?.name ?? '';

  useEffect(() => {
    if (!win) return;
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
        {status === 'loading' && <div className="ai-log-empty">{tr('plug.loadingGui')}</div>}
        {status === 'error' && <div className="wave-missing">{message}</div>}
        <div ref={mount} />
      </div>
    </div>
  );
}

/** Effect plugin slots shown in the Effects panel. */
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
            <span className="plug-slot-name">{s.name}</span>
            <button className="mini" onClick={() => set({ pluginWindow: { trackId: track.id, slotId: s.id } })}>
              {tr('plug.edit')}
            </button>
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
