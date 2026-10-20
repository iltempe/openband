// Chat with Claude in the browser, with the user's own API key (no install, no server).
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useChat } from '../ai/chat';
import { MODELS, type ModelId } from '../ai/models';
import { forgetKey, getKey, saveKey, useApiKey } from '../ai/keys';
import { Markdown } from './Comments';
import { useT, type MessageKey } from '../i18n';

const SUGGESTIONS: MessageKey[] = ['chat.s1', 'chat.s2', 'chat.s3'];
const money = (usd: number) => (usd < 0.01 ? '< $0.01' : `$${usd.toFixed(2)}`);

/** The "API key" tab of Connect AI. */
export function KeyForm() {
  const [key, setKey] = useState('');
  const model = useApiKey((k) => k.model);
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  return (
    <form
      className="ca-steps key-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await saveKey(key);
          setKey('');
          setError(null);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <p>{t('chat.keyIntro')}</p>
      <input type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
      <label className="mic-row">
        <span>{t('chat.model')}</span>
        <select value={model} onChange={(e) => useApiKey.setState({ model: e.target.value as ModelId })}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · ${m.input}/${m.output} per M tokens
            </option>
          ))}
        </select>
      </label>
      <button className="btn primary" type="submit" disabled={!key.trim()}>
        {t('chat.useKey')}
      </button>
      {error && <div className="ca-problem">{error}</div>}
      <p className="ca-lna">{t('chat.privacy')}</p>
      <p className="ca-lna">
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
          {t('chat.getKey')}
        </a>
      </p>
    </form>
  );
}

export function AIChat() {
  const { items, busy, live, total } = useChat();
  const model = useApiKey((k) => k.model);
  const log = useStore((s) => s.bridgeLog);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const t = useT();
  // scrollIntoView() returns a Promise in recent browsers: never let it become the effect's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [items.length, live]);

  const send = async (msg: string) => {
    const m = msg.trim();
    if (!m || busy) return;
    setText('');
    const key = await getKey();
    if (!key) return void useApiKey.setState({ hasKey: false });
    // The agent and the Anthropic SDK load on the first message only.
    const [{ runTurn }, { AnthropicProvider }] = await Promise.all([import('../ai/agent'), import('../ai/provider')]);
    await runTurn(m, new AnthropicProvider(key, model), { model });
  };

  return (
    <div className="ai-chat">
      <div className="chat-list">
        {!items.length && (
          <div className="chat-empty">
            <p>{t('chat.hello')}</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="ai-example" onClick={() => void send(t(s))}>
                “{t(s)}”
              </button>
            ))}
          </div>
        )}
        {items.map((it) => {
          const cmds = it.txId ? log.filter((l) => l.txId === it.txId && l.method !== 'begin_change' && l.method !== 'end_change').reverse() : [];
          return (
            <div key={it.id} className={`chat-msg ${it.role}`}>
              <div className="chat-text">{it.role === 'assistant' ? <Markdown text={it.text || '…'} /> : it.text}</div>
              {it.role === 'assistant' && (cmds.length > 0 || it.cost !== undefined) && (
                <details className="chat-cmds">
                  <summary>
                    {t('chat.commands', { n: cmds.length })} · {money(it.cost ?? 0)}
                  </summary>
                  {cmds.map((c) => (
                    <div key={c.id} className={`ai-log-item ${c.ok ? '' : 'err'}`}>
                      <span className="ai-log-method">{c.method}</span>
                      <span className="ai-log-sum">{c.summary}</span>
                    </div>
                  ))}
                </details>
              )}
            </div>
          );
        })}
        {busy && (
          <div className="chat-msg assistant live">
            <div className="chat-text">{live ? <Markdown text={live} /> : <span className="chat-dots">●●●</span>}</div>
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          rows={2}
          value={text}
          placeholder={t('chat.placeholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
            e.stopPropagation();
          }}
        />
        {busy ? (
          <button type="button" className="btn chat-stop" onClick={() => void import('../ai/agent').then((a) => a.stopTurn())}>
            ⏹ {t('chat.stop')}
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={!text.trim()}>
            {t('chat.send')}
          </button>
        )}
      </form>
      <div className="chat-foot">
        <select value={model} disabled={busy} onChange={(e) => useApiKey.setState({ model: e.target.value as ModelId })}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <span title={t('chat.costHint')}>{t('chat.total', { cost: money(total) })}</span>
        <span className="eb-spacer" />
        <button className="mini" disabled={busy} onClick={() => void import('../ai/agent').then((a) => a.newChat())}>
          {t('chat.new')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void forgetKey()} title={t('chat.forgetHint')}>
          {t('chat.forget')}
        </button>
      </div>
    </div>
  );
}
