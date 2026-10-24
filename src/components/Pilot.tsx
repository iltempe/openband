// The Mix & Master Pilot panel (G1): a genre, a target, one knob ("How much"), the reasons for every
// change, "Listen before" at the same loudness, and the role of each track. Also the export for
// platforms dialog and the role chip of the mixer strips.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useT, useLang, type MessageKey } from '../i18n';
import { runCommand } from '../commands';
import { PLATFORM_TARGETS, type Platform } from '../audio/master';
import { listenBefore, setPilotAmount } from '../pilot/pilot';
import { PROFILES, GENRES } from '../pilot/plan';
import { autoRole, noteFacts } from '../pilot/roles';
import { MIX_ROLES, type Track } from '../types';
import { Knob } from './Knob';
import { useOverlays } from './Welcome';
import * as I from './Icons';

const PLATFORMS = Object.keys(PLATFORM_TARGETS) as Platform[];

/** The role of a track, as a chip: Auto (what the pilot hears) or the user's choice. */
export function RoleSelect({ track, className = 'role-select', compact }: { track: Track; className?: string; compact?: boolean }) {
  const t = useT();
  const p = useStore((s) => s.project);
  const auto = autoRole(track, noteFacts(p, track.id));
  return (
    <select
      className={`${className} ${track.role ? 'set' : ''}`}
      value={track.role ?? ''}
      title={t('pi.role')}
      aria-label={`${t('pi.role')} · ${track.name}`}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => void runCommand('set_track_role', { track_id: track.id, role: e.target.value || null }, 'ui')}
    >
      <option value="">{compact ? `◦ ${t(`pi.role.${auto}` as MessageKey)}` : t('pi.auto', { role: t(`pi.role.${auto}` as MessageKey) })}</option>
      {MIX_ROLES.map((r) => (
        <option key={r} value={r}>
          {t(`pi.role.${r}` as MessageKey)}
        </option>
      ))}
    </select>
  );
}

export function PilotPanel() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const pilot = useStore((s) => s.project.pilot);
  const tracks = useStore((s) => s.project.tracks);
  const hasRef = useStore((s) => !!s.project.reference?.analysis);
  const checkpoint = useStore((s) => s.checkpoint);
  const [genre, setGenre] = useState(pilot?.genre ?? 'pop');
  const [platform, setPlatform] = useState<Platform>((pilot?.platform as Platform) ?? PROFILES.pop.platform);
  const [scope, setScope] = useState<'both' | 'mix' | 'master'>('both');
  const [useRef_, setUseRef] = useState(false);
  const [amount, setAmount] = useState(pilot?.amount ?? 0.7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [before, setBefore] = useState(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pilot) setAmount(pilot.amount);
  }, [pilot?.amount]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => listenBefore(false), []);
  useEffect(() => {
    if (!pilot && before) {
      setBefore(false);
      listenBefore(false);
    }
  }, [pilot, before]);

  const run = async () => {
    setBusy(true);
    setError(null);
    if (before) {
      setBefore(false);
      listenBefore(false);
    }
    try {
      await runCommand('mix_pilot', { amount, genre, platform, scope, use_reference: useRef_ && hasRef }, 'ui');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const turn = (v: number) => {
    setAmount(v);
    if (!pilot) return;
    void setPilotAmount(v, { settle: false, history: false });
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => void setPilotAmount(v, { history: false }).catch(() => {}), 700);
  };
  const toggleBefore = () => {
    const on = !before;
    setBefore(on);
    listenBefore(on);
  };
  const name = (id?: string) => tracks.find((x) => x.id === id)?.name;

  return (
    <div className="pi-panel">
      <div className="pilot-main">
        <div className="pilot-head">
          <span className="smart-kicker">{t('pi.title')}</span>
          {pilot && <span className="pilot-loud">{t('pi.loud', { before: fmt(pilot.lufsBefore), after: fmt(pilot.lufsAfter) })}</span>}
        </div>
        <div className="pilot-controls">
          <Knob label={t('pi.amount')} size={64} value={amount} defaultValue={0.7} color="#a78bfa" onStart={pilot ? checkpoint : undefined} onChange={turn} format={(v) => `${Math.round(v * 100)}%`} />
          <div className="pilot-fields">
            <label>
              {t('pi.genre')}
              <select value={genre} onChange={(e) => (setGenre(e.target.value), setPlatform(PROFILES[e.target.value].platform))}>
                {GENRES.map((g) => (
                  <option key={g} value={g}>
                    {PROFILES[g].name[lang === 'it' ? 'it' : 'en']}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('mc.platform')}
              <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
                {PLATFORMS.map((x) => (
                  <option key={x} value={x}>
                    {t(`mc.p.${x}` as MessageKey)} · {PLATFORM_TARGETS[x].lufs} LUFS
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('pi.scope')}
              <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                {(['both', 'mix', 'master'] as const).map((x) => (
                  <option key={x} value={x}>
                    {t(`pi.scope.${x}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            {hasRef && (
              <label className="pilot-check">
                <input type="checkbox" checked={useRef_} onChange={(e) => setUseRef(e.target.checked)} /> {t('pi.useRef')}
              </label>
            )}
          </div>
        </div>
        <div className="pilot-actions">
          <button className="btn primary" disabled={busy} onClick={() => void run()}>
            {busy ? t('pi.running') : t('pi.run')}
          </button>
          <button className={`btn ${before ? 'on' : ''}`} disabled={!pilot || busy} aria-pressed={before} title={t('pi.beforeHint')} onClick={toggleBefore}>
            {t('pi.before')}
          </button>
          <button className="btn" disabled={!pilot || busy} title={t('pi.fixHint')} onClick={() => void runCommand('fix_pilot', {}, 'ui')}>
            {t('pi.fix')}
          </button>
        </div>
        {error && <div className="pilot-error">{error}</div>}
      </div>
      <div className="pilot-roles">
        <div className="smart-kicker">{t('pi.role')}</div>
        {tracks.map((tr) => (
          <div key={tr.id} className="pilot-role" style={{ '--track': tr.color } as React.CSSProperties}>
            <span className="pilot-role-name">{tr.name}</span>
            <RoleSelect track={tr} />
          </div>
        ))}
      </div>
      <div className="pilot-why">
        {pilot ? (
          <>
            <div className="smart-kicker">{t('pi.changes', { n: pilot.decisions.filter((d) => d.kind !== 'role').length })}</div>
            <ul>
              {[...pilot.decisions].filter((d) => d.kind !== 'role').sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)).map((d, i) => (
                <li key={i} className={`pd-${d.kind}`} title={name(d.trackId)}>
                  {d.text}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="pilot-empty">{t('pi.noRun')}</p>
        )}
      </div>
    </div>
  );
}

/** The changes that matter most first; the roles are in their own column. */
const ORDER = ['master', 'eq', 'sidechain', 'hpf', 'pan', 'space', 'balance', 'gain', 'role'];
const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');

export function ExportPlatformsDialog() {
  const open = useOverlays((o) => o.exportPlatforms);
  const t = useT();
  const [platforms, setPlatforms] = useState<Platform[]>(['spotify', 'apple']);
  const [stems, setStems] = useState(true);
  const [versions, setVersions] = useState<('instrumental' | 'acapella')[]>(['instrumental']);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!open) return null;
  const close = () => !busy && useOverlays.setState({ exportPlatforms: false });
  const toggle = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const go = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = (await runCommand('export_for_platforms', { platforms, stems, versions }, 'ui')) as { filename: string; notes?: string[] };
      setMsg([t('ex.done', { name: r.filename }), ...(r.notes ?? [])].join(' '));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal ex-dialog" role="dialog" aria-label={t('ex.title')}>
        <div className="modal-head">
          <div>
            <div className="lib-title">{t('ex.title')}</div>
            <div className="lib-sub">{t('ex.hint')}</div>
          </div>
          <button className="icon-btn" onClick={close} disabled={busy}>
            <I.Close />
          </button>
        </div>
        <div className="ex-group">
          <div className="smart-kicker">{t('ex.platforms')}</div>
          {PLATFORMS.map((x) => (
            <label key={x} className="ex-check">
              <input type="checkbox" checked={platforms.includes(x)} onChange={() => setPlatforms(toggle(platforms, x))} />
              {t(`mc.p.${x}` as MessageKey)} <span className="ex-dim">{PLATFORM_TARGETS[x].lufs} LUFS · {PLATFORM_TARGETS[x].ceiling} dBTP</span>
            </label>
          ))}
        </div>
        <div className="ex-group">
          <label className="ex-check">
            <input type="checkbox" checked={stems} onChange={(e) => setStems(e.target.checked)} /> {t('ex.stems')}
          </label>
          <label className="ex-check">
            <input type="checkbox" checked={versions.includes('instrumental')} onChange={() => setVersions(toggle(versions, 'instrumental'))} /> {t('ex.instrumental')}
          </label>
          <label className="ex-check">
            <input type="checkbox" checked={versions.includes('acapella')} onChange={() => setVersions(toggle(versions, 'acapella'))} /> {t('ex.acapella')}
          </label>
        </div>
        {msg && <div className="ex-msg">{msg}</div>}
        <div className="ver-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={busy || !platforms.length} onClick={() => void go()}>
            {busy ? t('ex.busy') : t('ex.go')}
          </button>
        </div>
      </div>
    </div>
  );
}
