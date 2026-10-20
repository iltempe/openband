// "Connect AI" wizard in the AI panel: Claude Desktop (.mcpb), Claude Code / Cursor (npx), or an API key.
// On the online demo it also pairs with the server on this computer through a code.
import { useState } from 'react';
import { useStore } from '../store';
import { BRIDGE_ENABLED, connectRemote, useBridge, type BridgeProblem } from '../bridge';
import { openLocalStudio } from '../handoff';
import { useT, type MessageKey } from '../i18n';
import * as I from './Icons';
import { KeyForm } from './AIChat';
import { connectTabs, useConfig } from '../config';

export const MCPB_URL = 'https://github.com/iltempe/openband/releases/latest/download/openband.mcpb';
const CLI = 'claude mcp add openband -- npx -y openband mcp';
const JSON_CONFIG = `{
  "mcpServers": {
    "openband": { "command": "npx", "args": ["-y", "openband", "mcp"] }
  }
}`;

type Tab = 'desktop' | 'cli' | 'key';

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

export function ConnectAI() {
  const [tab, setTab] = useState<Tab>('desktop');
  const b = useBridge();
  const t = useT();
  const features = useConfig((c) => c.features);
  const LABEL: Record<Tab, MessageKey> = { desktop: 'ca.tabDesktop', cli: 'ca.tabCli', key: 'ca.tabKey' };
  const tabs: [Tab, MessageKey][] = connectTabs(features).map((id) => [id, LABEL[id]]);
  return (
    <div className="ai-setup connect-ai">
      <div className="ca-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {t(label)}
          </button>
        ))}
      </div>
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
          <p>{t('ca.cli2')}</p>
          <Copyable text="npx openband setup" />
          <p>{t('ca.cli3')}</p>
          <Copyable text={JSON_CONFIG} />
          <p>{BRIDGE_ENABLED ? t('ca.cliLocal') : t('ca.cliDemo')}</p>
        </div>
      )}
      {tab === 'key' && features.byoKey && <KeyForm />}
      {!BRIDGE_ENABLED && tab !== 'key' && <PairForm />}
      {BRIDGE_ENABLED && b.problem?.kind === 'protocol' && <div className="ca-problem">{problemText(b.problem, t)}</div>}
    </div>
  );
}
