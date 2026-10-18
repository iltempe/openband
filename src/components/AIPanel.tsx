import { useStore } from '../store';
import { BRIDGE_ENABLED, BRIDGE_URL } from '../bridge';
import * as I from './Icons';
import { useT } from '../i18n';

const config = (path: string) => `{
  "mcpServers": {
    "openband": {
      "command": "node",
      "args": ["${path}/openband/server/mcp-server.mjs"]
    }
  }
}`;

const EXAMPLES = ['ai.ex1', 'ai.ex2', 'ai.ex3', 'ai.ex4'] as const;

export function AIPanel() {
  const status = useStore((s) => s.bridgeStatus);
  const log = useStore((s) => s.bridgeLog);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const t = useT();
  const CONFIG = config(t('ai.path'));

  return (
    <aside className="ai-panel">
      <div className="ai-head">
        <div>
          <div className="lib-title">
            <I.Sparkles width={16} height={16} /> AI · Model Context Protocol
          </div>
          <div className={`ai-status ${status}`}>
            <span className="dot" />
            {status === 'connected' ? t('ai.connected') : status === 'connecting' ? t('ai.connecting') : BRIDGE_ENABLED ? t('ai.unreachable') : t('ai.demo')}
          </div>
        </div>
        <button className="icon-btn" onClick={() => set({ aiOpen: false })}>
          <I.Close />
        </button>
      </div>

      {!BRIDGE_ENABLED && (
        <div className="ai-setup">
          <p>
            {t('ai.demoText1')}{' '}
            <a href="https://github.com/iltempe/openband" target="_blank" rel="noreferrer">GitHub</a> {t('ai.demoText2')}
          </p>
        </div>
      )}

      {BRIDGE_ENABLED && status !== 'connected' && (
        <div className="ai-setup">
          <p>
            {t('ai.setup1')} <code>{BRIDGE_URL}</code>.
          </p>
          <pre>{CONFIG}</pre>
          <button
            className="mini"
            onClick={() => {
              navigator.clipboard?.writeText(CONFIG).then(() => notify(t('ai.copied')), () => notify(t('ai.copyFailed')));
            }}
          >
            <I.Copy width={13} height={13} /> {t('ai.copy')}
          </button>
        </div>
      )}

      <div className="ai-section">{t('ai.try')}</div>
      <div className="ai-examples">
        {EXAMPLES.map((e) => (
          <div key={e} className="ai-example">“{t(e)}”</div>
        ))}
      </div>

      <div className="ai-section">{t('ai.activity')}</div>
      <div className="ai-log">
        {log.length === 0 && <div className="ai-log-empty">{t('ai.logEmpty')}</div>}
        {log.map((l) => (
          <div key={l.id} className={`ai-log-item ${l.ok ? '' : 'err'}`}>
            <span className="ai-log-time">{new Date(l.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span className="ai-log-method">{l.method}</span>
            <span className="ai-log-sum">{l.summary}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
