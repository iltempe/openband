import { useStore } from '../store';
import { RoomActivity } from './Collab';
import { JamSection } from './Jam';
import { Markdown, openComments } from './Comments';
import type { BridgeLogEntry } from '../types';
import { useState } from 'react';
import { emitStudioEvent, setActivitySharing, useActivitySharing } from '../events';
import { BRIDGE_ENABLED, useBridge } from '../bridge';
import { ConnectAI } from './ConnectAI';
import { AIChat } from './AIChat';
import { useApiKey } from '../ai/keys';
import * as I from './Icons';
import { useT } from '../i18n';

const EXAMPLES = ['ai.ex1', 'ai.ex2', 'ai.ex3', 'ai.ex4'] as const;

/** Consecutive log entries of the same transaction form one group (the log is newest first). */
function groupByTransaction(log: BridgeLogEntry[]) {
  const groups: { key: string; txId?: string; items: BridgeLogEntry[] }[] = [];
  for (const l of log) {
    const last = groups[groups.length - 1];
    if (last && l.txId && last.txId === l.txId) last.items.push(l);
    else groups.push({ key: l.id, txId: l.txId, items: [l] });
  }
  return groups;
}

export function AIPanel() {
  const status = useStore((s) => s.bridgeStatus);
  const log = useStore((s) => s.bridgeLog);
  const past = useStore((s) => s.past);
  const open = useStore((s) => s.activeTransaction);
  const undo = useStore((s) => s.undo);
  const share = useActivitySharing((s) => s.share);
  const [question, setQuestion] = useState('');
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const t = useT();
  const pairing = useBridge((b) => b.pairing);
  const hasKey = useApiKey((k) => k.hasKey);

  return (
    <aside className="ai-panel">
      <div className="ai-head">
        <div>
          <div className="lib-title">
            <I.Sparkles width={16} height={16} /> AI · Model Context Protocol
          </div>
          <div className={`ai-status ${status}`}>
            <span className="dot" />
            {status === 'connected' ? t('ai.connected') : hasKey ? t('chat.status') : status === 'connecting' ? t('ai.connecting') : BRIDGE_ENABLED ? t('ai.unreachable') : pairing ? t('ca.waitingCode') : t('ai.demo')}
          </div>
        </div>
        <button className="icon-btn" onClick={() => set({ aiOpen: false })}>
          <I.Close />
        </button>
      </div>

      {status !== 'connected' && (hasKey ? <AIChat /> : <ConnectAI />)}

      {status === 'connected' && (
        <div className="ai-live">
          <label className="ai-share">
            <input type="checkbox" checked={share} onChange={(e) => setActivitySharing(e.target.checked)} />
            <span>
              {t('ai.share')}
              <small>{t('ai.shareHint')}</small>
            </span>
          </label>
          <form
            className="ai-ask"
            onSubmit={(e) => {
              e.preventDefault();
              const text = question.trim();
              if (!text) return;
              const s = useStore.getState();
              emitStudioEvent({ kind: 'ask', text, context: s.selectedRegionId ? { region_id: s.selectedRegionId } : undefined });
              setQuestion('');
              notify(t('ai.askSent'));
            }}
          >
            <input placeholder={t('ai.askPlaceholder')} value={question} onChange={(e) => setQuestion(e.target.value)} />
            <button className="mini" type="submit" disabled={!question.trim()}>
              {t('ai.ask')}
            </button>
          </form>
          <JamSection />
        </div>
      )}

      {!(hasKey && status !== 'connected') && (
        <>
      <div className="ai-section">{t('ai.try')}</div>
      <div className="ai-examples">
        {EXAMPLES.map((e) => (
          <div key={e} className="ai-example">“{t(e)}”</div>
        ))}
      </div>
        </>
      )}

      <RoomActivity />
      <div className="ai-section">{t('ai.activity')}</div>
      <div className="ai-log">
        {log.length === 0 && <div className="ai-log-empty">{t('ai.logEmpty')}</div>}
        {groupByTransaction(log).map((g) => {
          const step = g.txId ? past.find((h) => h.id === g.txId) : undefined;
          const isOpen = !!g.txId && open?.id === g.txId;
          const isLast = !!step && past[past.length - 1]?.id === step.id;
          return (
            <div key={g.key} className={`ai-group ${g.txId ? 'tx' : ''}`}>
              {g.txId && (step || isOpen) && (
                <div className="ai-group-head">
                  <span className="ai-group-label">{step?.label ?? open?.label}</span>
                  <span className="ai-group-count">{t('ai.groupCount', { n: g.items.length })}</span>
                  {step && (
                    <button className="mini" disabled={!isLast} title={isLast ? '' : t('ai.undoOnlyLast')} onClick={() => undo()}>
                      ↶ {t('ai.undoThis')}
                    </button>
                  )}
                  {isOpen && <span className="ai-group-live">{t('ai.inProgress')}</span>}
                </div>
              )}
              {g.txId && <TxNotes txId={g.txId} />}
              {g.items.map((l) => (
                <div key={l.id} className={`ai-log-item ${l.ok ? '' : 'err'}`}>
                  <span className="ai-log-time">{new Date(l.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  <span className="ai-log-method">{l.method}</span>
                  <span className="ai-log-sum">{l.summary}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** The AI's explanations made during one transaction, shown with its activity. */
function TxNotes({ txId }: { txId: string }) {
  const annotations = useStore((s) => s.project.annotations);
  const list = (annotations ?? []).filter((a) => a.txId === txId);
  if (!list.length) return null;
  return (
    <div className="ai-notes">
      {list.map((a) => (
        <button key={a.id} className="ai-note" onClick={() => openComments(a.target)}>
          <Markdown text={a.text} />
        </button>
      ))}
    </div>
  );
}
