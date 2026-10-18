import { useStore } from '../store';
import { BRIDGE_ENABLED, BRIDGE_URL } from '../bridge';
import * as I from './Icons';

const CONFIG = `{
  "mcpServers": {
    "openband": {
      "command": "node",
      "args": ["/PERCORSO/openband/server/mcp-server.mjs"]
    }
  }
}`;

const EXAMPLES = [
  'Crea un beat lo-fi a 82 BPM in Re minore con batteria, basso e Rhodes',
  'Aggiungi una melodia di synth lead sulle battute 5–8',
  'Rendi il ritornello più energico: hi-hat in sedicesimi e crash sull’1',
  'Abbassa il pad, alza il riverbero sul piano e fai partire il loop',
];

export function AIPanel() {
  const status = useStore((s) => s.bridgeStatus);
  const log = useStore((s) => s.bridgeLog);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);

  return (
    <aside className="ai-panel">
      <div className="ai-head">
        <div>
          <div className="lib-title">
            <I.Sparkles width={16} height={16} /> AI · Model Context Protocol
          </div>
          <div className={`ai-status ${status}`}>
            <span className="dot" />
            {status === 'connected' ? 'Server MCP collegato' : status === 'connecting' ? 'Connessione in corso…' : BRIDGE_ENABLED ? 'Server MCP non raggiungibile' : 'Demo online · AI disponibile in locale'}
          </div>
        </div>
        <button className="icon-btn" onClick={() => set({ aiOpen: false })}>
          <I.Close />
        </button>
      </div>

      {!BRIDGE_ENABLED && (
        <div className="ai-setup">
          <p>
            Questa è la demo online: per farla suonare alla tua AI, clona il progetto da{' '}
            <a href="https://github.com/iltempe/openband" target="_blank" rel="noreferrer">GitHub</a> e avvialo in locale.
          </p>
        </div>
      )}

      {BRIDGE_ENABLED && status !== 'connected' && (
        <div className="ai-setup">
          <p>
            Aggiungi OpenBand al tuo client MCP (Claude Desktop, Cursor, ecc.). Il client avvia il server, che si collega a questa finestra su <code>{BRIDGE_URL}</code>.
          </p>
          <pre>{CONFIG}</pre>
          <button
            className="mini"
            onClick={() => {
              navigator.clipboard?.writeText(CONFIG).then(() => notify('Configurazione copiata'), () => notify('Copia non riuscita'));
            }}
          >
            <I.Copy width={13} height={13} /> Copia configurazione
          </button>
        </div>
      )}

      <div className="ai-section">Prova a chiedere</div>
      <div className="ai-examples">
        {EXAMPLES.map((e) => (
          <div key={e} className="ai-example">“{e}”</div>
        ))}
      </div>

      <div className="ai-section">Attività</div>
      <div className="ai-log">
        {log.length === 0 && <div className="ai-log-empty">I comandi ricevuti dall’AI appariranno qui.</div>}
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
