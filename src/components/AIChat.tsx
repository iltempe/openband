// Chat with Claude in the browser, with the user's own API key (no install, no server).
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useChat } from '../ai/chat';
import { MODELS, PROVIDERS, providerInfo, type ProviderId } from '../ai/models';
import { baseUrlOf, changeAi, chooseAi, forgetKey, getKey, saveKey, useApiKey } from '../ai/keys';
import { Markdown } from './Comments';
import { useT, type MessageKey } from '../i18n';

let current: { sig: string; provider: import('../ai/provider').LLMProvider } | null = null;

const SUGGESTIONS: MessageKey[] = ['chat.s1', 'chat.s2', 'chat.s3'];
const money = (usd: number) => (usd < 0.01 ? '< $0.01' : `$${usd.toFixed(2)}`);

/** The "AI model" tab of Connect AI: which AI, which model, where (Ollama / custom), and the key. */
export function KeyForm() {
  const choice = useApiKey();
  const info = providerInfo(choice.provider);
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [found, setFound] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const local = info.models.length === 0;
  // Is there already a key for this provider?
  useEffect(() => {
    let live = true;
    setSaved(false);
    setFound([]);
    setError(null);
    void getKey(choice.provider).then((k) => live && setSaved(!!k && k !== 'none'), () => {});
    return () => void (live = false);
  }, [choice.provider]);
  const find = async () => {
    setError(null);
    try {
      const k = key.trim() || (await getKey(choice.provider));
      const names = await (await import('../ai/openai')).listModels(baseUrlOf(choice), k && k !== 'none' ? k : null);
      setFound(names);
      if (!names.length) setError(t('chat.noModels'));
      else if (!choice.model) chooseAi({ model: names[0] });
    } catch (e) {
      setError(`${(e as Error).message} — ${t('chat.ollamaHint', { origin: location.origin })}`);
    }
  };
  return (
    <form
      className="ca-steps key-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          if (!choice.model.trim()) throw new Error(t('chat.needModel'));
          if (key.trim() || !saved) await saveKey(key);
          else useApiKey.setState({ hasKey: true, picking: false });
          setKey('');
          setError(null);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <p>{t('chat.keyIntro')}</p>
      <label className="mic-row">
        <span>{t('chat.provider')}</span>
        <select value={choice.provider} onChange={(e) => chooseAi({ provider: e.target.value as ProviderId })}>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {local && (
        <label className="mic-row">
          <span>{t('chat.serverUrl')}</span>
          <input spellCheck={false} placeholder={info.baseUrl} value={choice.baseUrl} onChange={(e) => chooseAi({ baseUrl: e.target.value.trim() })} />
        </label>
      )}
      <label className="mic-row">
        <span>{t('chat.model')}</span>
        {local ? (
          <span className="key-model">
            <input list="ai-models" spellCheck={false} placeholder={t('chat.modelName')} value={choice.model} onChange={(e) => chooseAi({ model: e.target.value.trim() })} />
            <datalist id="ai-models">
              {found.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <button type="button" className="mini" onClick={() => void find()}>
              {t('chat.findModels')}
            </button>
          </span>
        ) : (
          <select value={choice.model} onChange={(e) => chooseAi({ model: e.target.value })}>
            {info.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · ${m.input}/${m.output} per M tokens
              </option>
            ))}
          </select>
        )}
      </label>
      {(info.needsKey || choice.provider === 'custom') && (
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={saved ? t('chat.keySaved') : info.needsKey ? info.keyHint : t('chat.keyOptional')}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      )}
      <button className="btn primary" type="submit" disabled={info.needsKey && !key.trim() && !saved}>
        {t('chat.useKey')}
      </button>
      {error && <div className="ca-problem">{error}</div>}
      {choice.provider === 'ollama' && <p className="ca-lna">{t('chat.ollamaHint', { origin: location.origin })}</p>}
      <p className="ca-lna">{t('chat.privacy')}</p>
      {info.keyUrl && (
        <p className="ca-lna">
          <a href={info.keyUrl} target="_blank" rel="noreferrer">
            {t('chat.getKey')}
          </a>
        </p>
      )}
    </form>
  );
}

export function AIChat() {
  const { items, busy, live, total } = useChat();
  const choice = useApiKey();
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
    const key = await getKey(choice.provider);
    if (!key) return void useApiKey.setState({ hasKey: false });
    // The agent and the provider code load on the first message only.
    const [{ runTurn }, { makeProvider }] = await Promise.all([import('../ai/agent'), import('../ai/provider')]);
    // One provider per choice: it remembers what the model sent (reasoning, Gemini's signatures).
    const sig = JSON.stringify([choice.provider, choice.model, choice.baseUrl, key]);
    if (current?.sig !== sig) current = { sig, provider: makeProvider(choice, key) };
    await runTurn(m, current.provider, { model: choice.model });
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
        {providerInfo(choice.provider).models.length ? (
          <select value={choice.model} disabled={busy} onChange={(e) => chooseAi({ model: e.target.value })}>
            {MODELS.filter((m) => providerInfo(choice.provider).models.includes(m)).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="chat-model">{choice.model}</span>
        )}
        <span title={t('chat.costHint')}>{t('chat.total', { cost: money(total) })}</span>
        <span className="eb-spacer" />
        <button className="mini" disabled={busy} onClick={() => void import('../ai/agent').then((a) => a.newChat())}>
          {t('chat.new')}
        </button>
        <button className="mini" disabled={busy} onClick={changeAi}>
          {t('chat.change')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void forgetKey()} title={t('chat.forgetHint')}>
          {t('chat.forget')}
        </button>
      </div>
    </div>
  );
}
