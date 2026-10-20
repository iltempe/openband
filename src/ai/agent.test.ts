import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store';
import { commands } from '../commands';
import { chatHistory, newChat, runTurn, stopTurn, useChat } from './agent';
import { agentTools, validateInput } from './tools';
import { NO_USAGE } from './models';
import type { LLMProvider, TurnRequest, TurnResult } from './provider';
import { forgetKey, getKey, saveKey, setKeyStore } from './keys';

/** A provider that plays a script: each entry is the content of one assistant turn. */
function scripted(turns: TurnResult['content'][], seen: TurnRequest[] = []): LLMProvider {
  let i = 0;
  return {
    id: 'mock',
    async turn(req) {
      seen.push({ ...req, messages: [...req.messages] });
      const content = turns[Math.min(i++, turns.length - 1)];
      const toolUse = content.some((b) => b.type === 'tool_use');
      return { content, stop_reason: toolUse ? 'tool_use' : 'end_turn', model: 'claude-opus-5-5', usage: { ...NO_USAGE, input_tokens: 1000, output_tokens: 100 } };
    },
  };
}
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use' as const, id, name, input, caller: { type: 'direct' as const } }) as unknown as TurnResult['content'][number];
const say = (text: string) => ({ type: 'text' as const, text, citations: null }) as unknown as TurnResult['content'][number];

describe('in-browser agent', () => {
  beforeEach(() => {
    commands.new_project({ name: 'T', bpm: 100 });
    useStore.setState({ past: [], future: [], activeTransaction: null, bridgeLog: [] });
    newChat();
  });

  it('offers the same tools as the MCP server (minus the event stream) as JSON Schema', () => {
    const names = agentTools().map((t) => t.def.name);
    expect(names).toContain('add_track');
    expect(names).toContain('render_spectrogram');
    expect(names).not.toContain('wait_for_event');
    expect(names).not.toContain('begin_change');
    const addTrack = agentTools().find((t) => t.def.name === 'add_track')!;
    expect(addTrack.jsonSchema).toMatchObject({ type: 'object', properties: { kind: { enum: ['instrument', 'drums', 'audio'] } } });
    expect(validateInput('set_tempo', { bpm: 'fast' })).toMatchObject({ ok: false });
    expect(validateInput('set_tempo', { bpm: 90 })).toMatchObject({ ok: true });
  });

  it('runs the tool calls of a turn as one undo step', async () => {
    const seen: TurnRequest[] = [];
    const p = scripted(
      [
        [say('Setting up.'), use('t1', 'set_tempo', { bpm: 82 }), use('t2', 'add_track', { kind: 'drums', name: 'Beat' })],
        [use('t3', 'set_key', { key: 'Dm' })],
        [say('Done: 82 BPM in D minor with a drum track.')],
      ],
      seen,
    );
    await runTurn('Lo-fi beat at 82 BPM in D minor', p);
    const s = useStore.getState();
    expect(s.project.bpm).toBe(82);
    expect(s.project.key).toBe('Dm');
    expect(s.project.tracks.map((t) => t.name)).toContain('Beat');
    expect(s.past).toHaveLength(1);
    expect(s.past[0]).toMatchObject({ label: 'Lo-fi beat at 82 BPM in D minor', source: 'ai' });
    // History: user, assistant(tool_use×2), user(results×2), assistant, user(result), assistant.
    const h = chatHistory();
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect((h[2].content as { tool_use_id: string }[]).map((r) => r.tool_use_id)).toEqual(['t1', 't2']);
    // Each request resends the history so far, appended (never edited).
    expect(seen[1].messages.slice(0, 2)).toEqual(h.slice(0, 2));
    const items = useChat.getState().items;
    expect(items[items.length - 1]).toMatchObject({ role: 'assistant', tools: 3 });
    expect(items[items.length - 1].text).toContain('Done: 82 BPM');
    expect(items[items.length - 1].cost).toBeGreaterThan(0);
    // One undo brings everything back.
    useStore.getState().undo();
    expect(useStore.getState().project.bpm).toBe(100);
  });

  it('rejects invalid inputs without running them, and tells Claude why', async () => {
    await runTurn('x', scripted([[use('t1', 'set_tempo', { bpm: 'fast' })], [say('Sorry.')]]));
    expect(useStore.getState().project.bpm).toBe(100);
    const result = (chatHistory()[2].content as { is_error: boolean; content: string }[])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/Invalid input for set_tempo/);
  });

  it('stops at the tool-call limit', async () => {
    const many = Array.from({ length: 6 }, (_, i) => use(`t${i}`, 'set_tempo', { bpm: 60 + i }));
    await runTurn('x', scripted([many, many, many, [say('Stopped.')]]), { maxToolCalls: 4 });
    const results = chatHistory().filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content as { is_error?: boolean }[]);
    expect(results.filter((r) => !r.is_error)).toHaveLength(4);
    expect(useStore.getState().project.bpm).toBe(63);
  });

  it('Stop ends the turn and keeps the history valid', async () => {
    const slow: LLMProvider = {
      id: 'slow',
      turn: (req) =>
        new Promise((_, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const turn = runTurn('x', slow);
    await new Promise((r) => setTimeout(r, 10));
    stopTurn();
    await turn;
    expect(useChat.getState().busy).toBe(false);
    expect(useChat.getState().items.at(-1)!.text).toMatch(/Stopped/);
    expect(useStore.getState().activeTransaction).toBeNull();
  });

  it('never puts the API key in the project, its exports or the autosave', async () => {
    const mem = { v: null as string | null };
    setKeyStore({ get: async () => mem.v, set: async (k) => void (mem.v = k), clear: async () => void (mem.v = null) });
    const secret = 'sk-ant-api03-SECRETSECRETSECRET';
    const written: string[] = [];
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: (_k: string, v: string) => void written.push(v),
      removeItem: () => {},
    };
    await saveKey(secret);
    expect(await getKey()).toBe(secret);
    await runTurn('x', scripted([[use('t1', 'set_tempo', { bpm: 90 })], [say('ok')]]));
    const exported = JSON.stringify(await commands.export_project_json({}));
    const canonical = JSON.stringify(await commands.export_project_json({ canonical: true }));
    expect(exported).not.toContain(secret);
    expect(canonical).not.toContain(secret);
    expect(JSON.stringify(useStore.getState().project)).not.toContain(secret);
    expect(written.join('\n')).not.toContain(secret);
    await forgetKey();
    expect(await getKey()).toBeNull();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
