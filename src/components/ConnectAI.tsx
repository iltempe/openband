// "Connect AI" wizard in the AI panel: Claude Desktop (.mcpb), Claude Code / Cursor (npx), or an API key.
// On the online demo it also pairs with the server on this computer through a code.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { BRIDGE_ENABLED, connectRemote, remoteMcpUrl, startRemoteMcp, useBridge, type BridgeProblem } from '../bridge';
import { openLocalStudio } from '../handoff';
import { useT, type MessageKey } from '../i18n';
import * as I from './Icons';
import { KeyForm } from './AIChat';
import { connectTabs, useConfig, type ConnectTab } from '../config';
import { desktop, type DesktopClientResult } from '../desktop';
import { useApiKey } from '../ai/keys';

import { CLAUDE_CODE_ADD as CLI, CODEX_ADD, MCPB_URL, MCP_JSON as JSON_CONFIG, RUN } from '../install';
export { MCPB_URL };

// 'apps': the desktop app adds itself to the AI apps on this computer, in one click.
type Tab = ConnectTab | 'apps';

function Copyable({ text }: { text: string }) {
  const t = useT();
  const notify = useStore((s) => s.notify);
  return (
    <div className="copyable">
      <pre>{text}</pre>
      <button className="mini" onClick={() => navigator.clipboard?.writeText(text).then(() => notify(t('ai.copied')), () => notify(t('ai.copyFailed')))}>
        <I.Copy width={13} height={13} /> {t('ai.copy')}
      </button>
    </div>
  );
}

function problemText(p: BridgeProblem, t: ReturnType<typeof useT>): string {
  switch (p.kind) {
    case 'unreachable':
      return t('ca.unreachable', { port: p.port }) + (p.permission ? ` ${t('ca.permission')}` : '');
    case 'protocol':
      return p.server < p.app ? t('ca.serverOld') : t('ca.appOld');
    case 'code':
      return p.reason === 'locked'
        ? t('ca.locked', { min: Math.max(1, Math.ceil((p.retryInMs ?? 300000) / 60000)) })
        : p.reason === 'expired'
          ? t('ca.expired')
          : p.reason === 'missing'
            ? t('ca.needCode')
            : t('ca.wrong', { n: p.attemptsLeft ?? 0 });
  }
}

/** Code + port form for the online demo. */
function PairForm() {
  const b = useBridge();
  const status = useStore((s) => s.bridgeStatus);
  const [code, setCode] = useState('');
  const [port, setPort] = useState(String(b.port));
  const t = useT();
  const p = Number(port) || 7777;
  return (
    <form
      className="ca-pair"
      onSubmit={(e) => {
        e.preventDefault();
        connectRemote(p, code);
      }}
    >
      <div className="ca-lna">{t('ca.lna')}</div>
      <div className="ca-fields">
        <label>
          <span>{t('ca.code')}</span>
          <input inputMode="numeric" autoComplete="one-time-code" placeholder="482-913" value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d-]/g, '').slice(0, 7))} />
        </label>
        <label className="ca-port">
          <span>{t('ca.port')}</span>
          <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} />
        </label>
        <button className="btn primary" type="submit" disabled={status === 'connecting' || code.replace(/\D/g, '').length !== 6}>
          {status === 'connecting' ? t('ai.connecting') : t('ca.connect')}
        </button>
      </div>
      {b.problem && <div className="ca-problem">{problemText(b.problem, t)}</div>}
      {b.problem?.kind === 'unreachable' && (
        <button type="button" className="btn" onClick={() => openLocalStudio(p)} title={t('ca.localHint')}>
          {t('ca.openLocal')}
        </button>
      )}
    </form>
  );
}

/** A self-hosted OpenBand with /mcp: claude.ai connects to the server, this tab pairs with a code. */
function RemoteMcp() {
  const t = useT();
  const r = useBridge((s) => s.remoteMcp);
  useEffect(() => {
    startRemoteMcp();
  }, []);
  if (r?.paired) return <div className="ca-steps ca-paired">✓ {t('ca.remotePaired')}</div>;
  return (
    <div className="ca-steps">
      <p>{t('ca.remote1')}</p>
      <Copyable text={remoteMcpUrl()} />
      <p>{t('ca.remote2')}</p>
      <div className="ca-code" aria-live="polite">
        {r?.code ? `${r.code.slice(0, 3)} ${r.code.slice(3)}` : t('ca.remoteWaiting')}
      </div>
      <p className="ca-note">{t('ca.remoteExpires')}</p>
    </div>
  );
}

/** In the desktop app: one button instead of downloads and commands. */
function DesktopApps() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<DesktopClientResult[] | null>(null);
  const STATUS: Record<DesktopClientResult['status'], MessageKey> = { added: 'dk.added', already: 'dk.already', failed: 'dk.failed', missing: 'dk.missing' };
  return (
    <div className="ca-steps">
      <p>{t('dk.intro')}</p>
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setResults(await desktop!.connectClients());
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t('ai.connecting') : t('dk.connect')}
      </button>
      {results && (
        <ul className="dk-results">
          {results.map((r) => (
            <li key={r.name} className={r.status}>
              {r.status === 'added' || r.status === 'already' ? '✓' : r.status === 'failed' ? '✗' : '–'} {r.name}: {t(STATUS[r.status])}
              {r.detail && r.detail !== 'restart' ? ` (${r.detail})` : ''}
            </li>
          ))}
        </ul>
      )}
      <p className="ca-note">{results?.some((r) => r.status === 'added') ? t('dk.restart') : t('dk.how')}</p>
    </div>
  );
}

export function ConnectAI() {
  const features = useConfig((c) => c.features);
  const remoteMcp = useConfig((c) => c.remoteMcp);
  const [tab, setTab] = useState<Tab>(useApiKey.getState().picking && features.byoKey ? 'key' : desktop ? 'apps' : remoteMcp ? 'remote' : 'desktop');
  const b = useBridge();
  const t = useT();
  // config.json arrives after the first render.
  useEffect(() => {
    if (remoteMcp) setTab('remote');
  }, [remoteMcp]);
  const LABEL: Record<Tab, MessageKey> = { remote: 'ca.tabRemote', desktop: 'ca.tabDesktop', cli: 'ca.tabCli', key: 'ca.tabKey', apps: 'dk.tab' };
  const tabs: [Tab, MessageKey][] = desktop
    ? [['apps', 'dk.tab'], ...(features.byoKey ? [['key', 'ca.tabKey'] as [Tab, MessageKey]] : [])]
    : connectTabs(features, remoteMcp).map((id) => [id, LABEL[id]]);
  return (
    <div className="ai-setup connect-ai">
      <div className="ca-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {t(label)}
          </button>
        ))}
      </div>
      {tab === 'apps' && <DesktopApps />}
      {tab === 'remote' && <RemoteMcp />}
      {tab === 'desktop' && (
        <ol className="ca-steps">
          <li>
            <a className="btn primary" href={MCPB_URL}>
              ⬇ {t('ca.download')}
            </a>
          </li>
          <li>{t('ca.desktop2')}</li>
          <li>{BRIDGE_ENABLED ? t('ca.desktop3local') : t('ca.desktop3demo')}</li>
        </ol>
      )}
      {tab === 'cli' && (
        <div className="ca-steps">
          <p>{t('ca.cli1')}</p>
          <Copyable text={CLI} />
          <p>{t('ca.cliCodex')}</p>
          <Copyable text={CODEX_ADD} />
          <p>{t('ca.cli2')}</p>
          <Copyable text={`${RUN} setup`} />
          <p>{t('ca.cli3')}</p>
          <Copyable text={JSON_CONFIG} />
          <p>{BRIDGE_ENABLED ? t('ca.cliLocal') : t('ca.cliDemo')}</p>
        </div>
      )}
      {tab === 'key' && features.byoKey && <KeyForm />}
      {!BRIDGE_ENABLED && tab !== 'key' && tab !== 'remote' && <PairForm />}
      {BRIDGE_ENABLED && b.problem?.kind === 'protocol' && <div className="ca-problem">{problemText(b.problem, t)}</div>}
    </div>
  );
}
