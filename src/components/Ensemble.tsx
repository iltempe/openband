// Ensemble (SPEC v0.6): the Create dialog (describe a part, OpenBand's engines play it) and the Ensemble
// panel (engines, policy, the contribution ledger, the human / AI share). Works without any AI connected.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useT, type MessageKey } from '../i18n';
import { runCommand } from '../commands';
import { useBridge } from '../bridge';
import { allEngines, builtinEngines, refreshEngines, setPolicy, useEnsemble } from '../ensemble/engines';
import { relayEngines, relaySettings, setRelay } from '../ensemble/relay';
import { estimate, spending } from '../ensemble/budget';
import { exclusion, inferCapability, route, type EngineInfo } from '../ensemble/router';
import { shares } from '../ensemble/ledger';
import type { Region } from '../types';
import * as I from './Icons';

const WHERE: Record<string, MessageKey> = { builtin: 'en.where.builtin', browser: 'en.where.browser', local: 'en.where.local', lan: 'en.where.lan', cloud: 'en.where.cloud' };
const PARTS: { id: string; label: MessageKey }[] = [
  { id: '', label: 'en.part.auto' },
  { id: 'symbolic.drums', label: 'en.part.drums' },
  { id: 'symbolic.accompany', label: 'en.part.accompany' },
  { id: 'music.add_layer', label: 'en.part.layer' },
];

function LicenceBadge({ e }: { e: EngineInfo }) {
  const t = useT();
  const c = e.manifest.license.commercial;
  return (
    <span className={`en-badge lic-${c}`} title={`${e.manifest.license.code}${e.manifest.license.weights ? ` · ${e.manifest.license.weights}` : ''}${e.manifest.license.conditions ? ` · ${e.manifest.license.conditions}` : ''}`}>
      {t(c === 'yes' ? 'en.lic.yes' : c === 'no' ? 'en.lic.no' : 'en.lic.cond')}
    </span>
  );
}

/** ✦ on a region an engine made, with who and how. */
export function ContributionBadge({ region }: { region: Region }) {
  const entry = useStore((s) => (region.contribution ? s.project.ledger?.find((e) => e.id === region.contribution) : undefined));
  const t = useT();
  if (!entry) return null;
  const tip = `${entry.engineName ?? entry.engine} · ${entry.capability}${entry.conform.length ? `\n${t('en.corrected')}: ${entry.conform.join('; ')}` : ''}`;
  return (
    <span className="ctb-badge" title={tip} aria-label={tip}>
      ✦
    </span>
  );
}

export function CreateDialog() {
  const open = useEnsemble((e) => e.createOpen);
  const p = useStore((s) => s.project);
  const selectedTrack = useStore((s) => s.selectedTrackId);
  const t = useT();
  const [text, setText] = useState('');
  const [part, setPart] = useState('');
  const [where, setWhere] = useState('song');
  const [bars, setBars] = useState({ from: 1, to: 8 });
  const [engine, setEngine] = useState('');
  const [variants, setVariants] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engines, setEngines] = useState<EngineInfo[]>(builtinEngines());
  const policy = useEnsemble((e) => e.policy);
  useEffect(() => {
    if (open) void allEngines().then(setEngines);
  }, [open]);
  const track = p.tracks.find((x) => x.id === selectedTrack);
  const capability = inferCapability({ capability: part || undefined, trackKind: part ? undefined : track?.kind, text });
  const routed = useMemo(() => {
    try {
      return route({ capability }, engines, policy);
    } catch {
      return null;
    }
  }, [capability, engines, policy]);
  if (!open) return null;
  const close = () => useEnsemble.setState({ createOpen: false });
  const go = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const sec = p.sections?.find((s) => s.id === where);
      const r = (await runCommand(
        'create',
        { text: text || undefined, capability: part || undefined, ...(sec ? { section_id: sec.id } : where === 'bars' ? { from_bar: bars.from, to_bar: bars.to } : {}), ...(engine ? { engine } : {}), variants, ...(track && !part ? { track_id: track.kind === 'audio' && capability !== 'music.add_layer' ? undefined : track.id } : {}) },
        'ui',
      )) as { engines: string[]; corrections: string[][]; region_id?: string; region_ids?: string[]; take_ids?: string[] };
      const fixes = r.corrections.flat();
      setResult(`${t('en.madeBy', { engines: [...new Set(r.engines)].join(', ') })}${r.take_ids ? ` · ${t('en.takes', { n: r.take_ids.length })}` : ''}${fixes.length ? ` · ${t('en.corrected')}: ${fixes.join('; ')}` : ''}`);
      const rid = r.region_id ?? r.region_ids?.[0];
      const region = useStore.getState().project.regions.find((x) => x.id === rid);
      if (region) useStore.getState().selectRegion(region);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal en-create" role="dialog" aria-label={t('en.create')}>
        <div className="modal-head">
          <div>
            <div className="lib-title">✦ {t('en.create')}</div>
            <div className="lib-sub">{t('en.createSub')}</div>
          </div>
          <button className="icon-btn" onClick={close} aria-label={t('en.close')}>
            <I.Close />
          </button>
        </div>
        <form
          className="en-form"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          <input autoFocus placeholder={t('en.textPh')} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <label className="mic-row">
            <span>{t('en.part')}</span>
            <select value={part} onChange={(e) => setPart(e.target.value)}>
              {PARTS.map((x) => (
                <option key={x.id} value={x.id}>
                  {t(x.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="mic-row">
            <span>{t('en.where')}</span>
            <select value={where} onChange={(e) => setWhere(e.target.value)}>
              <option value="song">{p.loop?.enabled ? t('en.where.cycle') : t('en.where.song')}</option>
              {(p.sections ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value="bars">{t('en.where.bars')}</option>
            </select>
          </label>
          {where === 'bars' && (
            <div className="mic-row en-bars">
              <span>{t('en.bars')}</span>
              <input type="number" min={1} value={bars.from} onChange={(e) => setBars({ ...bars, from: Math.max(1, Number(e.target.value)) })} />
              <span>–</span>
              <input type="number" min={bars.from} value={bars.to} onChange={(e) => setBars({ ...bars, to: Math.max(bars.from, Number(e.target.value)) })} />
            </div>
          )}
          <label className="mic-row">
            <span>{t('en.engine')}</span>
            <select value={engine} onChange={(e) => setEngine(e.target.value)}>
              <option value="">{t('en.engineAuto', { name: routed?.candidates[0]?.manifest.engine.name ?? '—' })}</option>
              {routed?.candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.manifest.engine.name}
                </option>
              ))}
            </select>
          </label>
          <label className="mic-row">
            <span>{t('en.variants')}</span>
            <select value={variants} onChange={(e) => setVariants(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {routed?.candidates[0] && (() => {
            const pick = routed.candidates.find((c) => c.id === engine) ?? routed.candidates[0];
            const usd = pick.manifest.runtime.pricing ? estimate(pick, capability, { scp: '1.0', song: { bpm: p.bpm, meter: '4/4', key: p.key, length_bars: 8 }, scope: where === 'bars' ? { from_bar: bars.from, to_bar: bars.to + 1 } : { from_bar: 1, to_bar: 9 } }, variants) : 0;
            return usd > 0 ? <div className="en-quote">{t('on.quote', { usd: usd.toFixed(4), n: variants, engine: pick.manifest.engine.name })}</div> : null;
          })()}
          <div className="en-cap">
            {capability}
            {routed && !routed.candidates.length && <span className="ca-problem">{t('en.noEngine')}</span>}
          </div>
          {error && <div className="ca-problem">{error}</div>}
          {result && <div className="en-result">✓ {result}</div>}
          <div className="ver-actions" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={close}>
              {t('en.close')}
            </button>
            <button type="submit" className="btn primary" disabled={busy || !routed?.candidates.length}>
              {busy ? t('en.creating') : t('en.createBtn')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function EnsemblePanel() {
  const t = useT();
  const { policy, external, broken, checking } = useEnsemble();
  const p = useStore((s) => s.project);
  const hasEngines = useBridge((b) => b.engines);
  useEffect(() => {
    void refreshEngines(true);
  }, [hasEngines]);
  const engines = [...builtinEngines(), ...external, ...relayEngines()];
  const ledger = [...(p.ledger ?? [])].reverse();
  const share = shares(p).filter((s) => s.bars > 0);
  const firstExclusion = (e: EngineInfo) => {
    for (const cap of Object.keys(e.manifest.capabilities)) {
      const why = exclusion(e, { capability: cap as never }, policy);
      if (why && !/^doesn't offer/.test(why)) return why;
    }
    return null;
  };
  return (
    <div className="en-panel">
      <section>
        <h4>{t('en.policy')}</h4>
        <label className="en-toggle">
          <input type="checkbox" checked={policy.commercial_only} onChange={(e) => setPolicy({ commercial_only: e.target.checked })} /> {t('en.pol.commercial')}
        </label>
        <label className="en-toggle">
          <input type="checkbox" checked={policy.local_only} onChange={(e) => setPolicy({ local_only: e.target.checked })} /> {t('en.pol.local')}
        </label>
        <label className="en-toggle">
          <input type="checkbox" checked={policy.allow_cloud} disabled={policy.local_only} onChange={(e) => setPolicy({ allow_cloud: e.target.checked })} /> {t('en.pol.cloud')}
        </label>
        <button className="btn primary en-create-btn" onClick={() => useEnsemble.setState({ createOpen: true })}>
          ✦ {t('en.create')}
        </button>
      </section>
      <section>
        <h4>
          {t('en.engines')}
          <button className="mini" disabled={checking} onClick={() => void refreshEngines(true)}>
            {t('en.refresh')}
          </button>
        </h4>
        <ul className="en-engines">
          {engines.map((e) => {
            const why = firstExclusion(e);
            return (
              <li key={e.id} className={why ? 'off' : ''}>
                <div>
                  <b>{e.manifest.engine.name}</b> <span className="en-badge">{t(WHERE[e.manifest.runtime.where])}</span> <LicenceBadge e={e} />
                </div>
                <div className="en-caps">{Object.keys(e.manifest.capabilities).join(' · ')}</div>
                {why && <div className="en-why">{why}</div>}
              </li>
            );
          })}
          {broken.map((b) => (
            <li key={b.id} className="off">
              <b>{b.id}</b> <span className="en-why">{b.error}</span>
            </li>
          ))}
        </ul>
        <p className="ca-note">{hasEngines ? t('en.addHint') : t('en.noServer')}</p>
      </section>
      <OnlineEngines engines={engines.filter((e) => e.manifest.runtime.where === 'cloud')} />
      <section>
        <h4>{t('en.share')}</h4>
        {share.length ? (
          <ul className="en-share">
            {share.map((s) => (
              <li key={s.trackId}>
                <span className="en-share-name">{s.name}</span>
                <span className="en-bar" title={`${Math.round((1 - s.ai) * 100)}% ${t('en.human')} · ${Math.round(s.ai * 100)}% AI${s.engines.length ? ` (${s.engines.join(', ')})` : ''}`}>
                  <span className="en-bar-ai" style={{ width: `${s.ai * 100}%` }} />
                </span>
                <span className="en-share-pc">{Math.round(s.ai * 100)}% AI</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ca-note">{t('en.shareEmpty')}</p>
        )}
        <h4>{t('en.ledger')}</h4>
        {ledger.length ? (
          <ul className="en-ledger">
            {ledger.map((e) => (
              <li key={e.id}>
                <button
                  className="en-ledger-row"
                  onClick={() => {
                    const r = p.regions.find((x) => e.regionIds.includes(x.id));
                    if (r) useStore.getState().selectRegion(r);
                  }}
                >
                  <b>{e.engineName ?? e.engine}</b> · {e.capability}
                  {e.request ? ` · “${e.request}”` : ''}
                  <span className="en-when">
                    {new Date(e.at).toLocaleString()} · {e.requestedBy === 'ai' ? 'AI' : t('en.you')} · {e.license.code}
                    {e.license.weights ? ` / ${e.license.weights}` : ''}
                  </span>
                  {e.conform.length > 0 && <span className="en-fix">{e.conform.join(' · ')}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ca-note">{t('en.ledgerEmpty')}</p>
        )}
      </section>
    </div>
  );
}

/** Online engines (§9-bis): the relay for the online studio, the budget, and what each engine sends. */
function OnlineEngines({ engines }: { engines: EngineInfo[] }) {
  const t = useT();
  const policy = useEnsemble((e) => e.policy);
  const [relay, setRelayForm] = useState(() => relaySettings() ?? { url: '', token: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const spent = spending();
  if (!policy.allow_cloud) return null;
  const save = () => {
    try {
      setRelay(relay.url && relay.token ? relay : null);
      setMsg(relay.url ? t('on.relaySaved') : t('on.relayRemoved'));
      useEnsemble.setState({ checkedAt: 0 });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const accept = (id: string, on: boolean) => setPolicy({ accepted_conditions: on ? [...new Set([...policy.accepted_conditions, id])] : policy.accepted_conditions.filter((x) => x !== id) });
  return (
    <section className="en-online">
      <h4>{t('on.title')}</h4>
      <p className="ca-note">{t('on.relayNote')}</p>
      <div className="en-relay">
        <input placeholder="https://openband-relay.<you>.workers.dev" value={relay.url} onChange={(e) => setRelayForm({ ...relay, url: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        <input placeholder={t('on.token')} type="password" value={relay.token} onChange={(e) => setRelayForm({ ...relay, token: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn" onClick={save}>
          {t('on.save')}
        </button>
        <a href="https://github.com/iltempe/openband/blob/main/deploy/relay/README.md" target="_blank" rel="noreferrer">
          {t('on.howto')}
        </a>
      </div>
      {msg && <p className="ca-note">{msg}</p>}
      <div className="en-budget">
        <label>
          {t('on.session')}
          <input type="number" min={0} step={0.5} value={policy.budget_session_usd} onChange={(e) => setPolicy({ budget_session_usd: Math.max(0, Number(e.target.value)) })} /> USD
        </label>
        <label>
          {t('on.month')}
          <input type="number" min={0} step={1} value={policy.budget_month_usd} onChange={(e) => setPolicy({ budget_month_usd: Math.max(0, Number(e.target.value)) })} /> USD
        </label>
        <span className="en-spent">{t('on.spent', { session: spent.session_usd.toFixed(4), month: spent.month_usd.toFixed(4) })}</span>
      </div>
      <ul className="en-engines">
        {engines.map((e) => {
          const d = e.manifest.runtime.data_policy;
          const rights = e.manifest.runtime.output_rights;
          const conditional = [e.manifest.license.commercial, rights?.commercial].includes('conditional');
          return (
            <li key={e.id}>
              <div>
                <b>{e.manifest.engine.name}</b> <span className="en-badge">{e.manifest.runtime.pricing ? `${e.manifest.runtime.pricing.usd} USD / ${e.manifest.runtime.pricing.unit}` : ''}</span>
                {spent.byEngine[e.id] ? <span className="en-spent"> · {t('on.engineSpent', { usd: spent.byEngine[e.id].toFixed(4) })}</span> : null}
              </div>
              {d && (
                <div className="en-data">
                  {t(d.uploads_audio ? 'on.sendsAudio' : 'on.sendsText')} · {t('on.retention', { r: d.retention ?? '?' })} · {t('on.training', { v: d.training_on_inputs })} ·{' '}
                  <a href={d.terms_url} target="_blank" rel="noreferrer">
                    {t('on.terms')}
                  </a>{' '}
                  ({t('on.verified', { date: d.verified })})
                </div>
              )}
              {conditional && (
                <label className="en-toggle">
                  <input type="checkbox" checked={policy.accepted_conditions.includes(e.id)} onChange={(ev) => accept(e.id, ev.target.checked)} /> {t('on.accept')}
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
