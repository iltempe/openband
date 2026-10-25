import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { commands } from '../commands';
import { newChat, runTurn, useChat } from './agent';
import { agentTools, toolsFor } from './tools';
import { ChatCompletionsProvider, OpenAIResponsesProvider, chatTools, geminiSchema, listModels, toChatMessages } from './openai';
import { makeProvider } from './provider';
import { costUsd, NO_USAGE } from './models';

/** A fetch that answers with the given JSON bodies in turn and records what was sent. */
function fakeFetch(answers: unknown[]) {
  const sent: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const body = answers[Math.min(i++, answers.length - 1)];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return sent;
}

const forbidden = (o: unknown): string[] => {
  if (Array.isArray(o)) return o.flatMap(forbidden);
  if (!o || typeof o !== 'object') return [];
  return Object.entries(o).flatMap(([k, v]) => [...(['additionalProperties', 'propertyNames', 'exclusiveMinimum', 'const', '$schema'].includes(k) ? [k] : []), ...(k === 'properties' ? Object.values(v as object).flatMap(forbidden) : forbidden(v))]);
};

describe('other AI providers', () => {
  beforeEach(() => {
    commands.new_project({ name: 'T', bpm: 100 });
    useStore.setState({ past: [], future: [], activeTransaction: null, bridgeLog: [] });
    newChat();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('Gemini (Chat Completions): tools in its schema subset, the model message sent back unchanged with its signature', async () => {
    const signed = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_tempo', arguments: '{"bpm":84}' }, extra_content: { google: { thought_signature: 'SIG==' } } }] };
    const sent = fakeFetch([
      { model: 'gemini-3.8-flash', choices: [{ finish_reason: 'tool_calls', message: signed }], usage: { prompt_tokens: 9000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 8000 } } },
      { model: 'gemini-3.8-flash', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Tempo set to 84.' } }], usage: { prompt_tokens: 9100, completion_tokens: 8 } },
    ]);
    const p = new ChatCompletionsProvider('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'AIzaTEST', 'gemini-3.8-flash');
    await runTurn('Set the tempo to 84', p, { model: 'gemini-3.8-flash' });
    expect(useStore.getState().project.bpm).toBe(84);
    expect(sent[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(sent[0].headers.authorization).toBe('Bearer AIzaTEST');
    const tools = sent[0].body.tools as { function: { parameters: unknown } }[];
    // The layered tools (core + capability, §8.1) go out; every tool, loaded later, fits Gemini's subset too.
    expect(tools.length).toBe(toolsFor(new Set()).length);
    expect(forbidden(tools.map((t) => t.function.parameters))).toEqual([]);
    const all = chatTools(agentTools().map((t) => ({ name: t.def.name, description: t.def.description, input_schema: t.jsonSchema })), 'gemini') as { function: { parameters: unknown } }[];
    expect(all.length).toBe(agentTools().length);
    expect(forbidden(all.map((t) => t.function.parameters))).toEqual([]);
    const msgs = sent[1].body.messages as Record<string, unknown>[];
    expect(msgs[0].role).toBe('system');
    expect(msgs[1]).toEqual({ role: 'user', content: 'Set the tempo to 84' });
    expect(msgs[2]).toEqual(signed); // signature and all
    expect(msgs[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(String(msgs[3].content)).toContain('84');
    expect(useChat.getState().items.at(-1)!.text).toBe('Tempo set to 84.');
    // Cached tokens are billed at the cached price.
    expect(useChat.getState().items.at(-1)!.cost).toBeCloseTo(costUsd('gemini-3.8-flash', { ...NO_USAGE, input_tokens: 1000 + 9100, cache_read_input_tokens: 8000, output_tokens: 28 }), 8);
  });

  it('OpenAI (Responses API): reasoning items travel back as received, results as function_call_output', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] };
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'add_track', arguments: '{"kind":"drums","name":"Beat"}' };
    const sent = fakeFetch([
      { model: 'gpt-6.1-sol', status: 'completed', output: [reasoning, call], usage: { input_tokens: 5000, output_tokens: 50 } },
      { model: 'gpt-6.1-sol', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added a drum track.' }] }], usage: { input_tokens: 5100, output_tokens: 6 } },
    ]);
    await runTurn('Add drums', new OpenAIResponsesProvider('https://api.openai.com/v1', 'sk-test', 'gpt-6.1-sol'), { model: 'gpt-6.1-sol' });
    expect(useStore.getState().project.tracks.some((t) => t.name === 'Beat')).toBe(true);
    expect(sent[0].url).toBe('https://api.openai.com/v1/responses');
    expect(sent[0].body).toMatchObject({ model: 'gpt-6.1-sol', store: false, include: ['reasoning.encrypted_content'] });
    expect(typeof sent[0].body.instructions).toBe('string');
    const input = sent[1].body.input as Record<string, unknown>[];
    expect(input[0]).toEqual({ role: 'user', content: 'Add drums' });
    expect(input[1]).toEqual(reasoning);
    expect(input[2]).toEqual(call);
    expect(input[3]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    expect(useChat.getState().items.at(-1)!.text).toBe('Added a drum track.');
  });

  it('Ollama: no key, broken JSON arguments come back as an error the model can fix', async () => {
    const sent = fakeFetch([
      { model: 'qwen3', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'set_tempo', arguments: '{bpm: 90' } }] } }] },
      { model: 'qwen3', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: [{ id: 'x2', type: 'function', function: { name: 'set_tempo', arguments: { bpm: 90 } } }] } }] },
      { model: 'qwen3', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }] },
    ]);
    const p = makeProvider({ provider: 'ollama', model: 'qwen3', baseUrl: '' }, 'none');
    await runTurn('90 bpm', p, { model: 'qwen3' });
    expect(sent[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(sent[0].headers.authorization).toBeUndefined();
    const second = sent[1].body.messages as Record<string, unknown>[];
    // The server gave no id: one was made up, and the tool result answers it.
    const madeUp = ((second[2].tool_calls as { id: string }[])[0]).id;
    expect(madeUp).toMatch(/^call_/);
    expect(second[3]).toMatchObject({ role: 'tool', tool_call_id: madeUp });
    expect(String(second[3].content)).toMatch(/not valid JSON/);
    expect(useStore.getState().project.bpm).toBe(90);
    expect(useChat.getState().items.at(-1)!.cost).toBe(0); // a local model costs nothing here
  });

  it('a tool image goes to the model as a user message (tool messages carry text only)', () => {
    const msgs = toChatMessages(
      'sys',
      [
        { role: 'user', content: 'look' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'render_spectrogram', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: '{"width":800}' }] }] },
      ],
      new WeakMap(),
    );
    expect(msgs[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'render_spectrogram', arguments: '{}' } }] });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: '{"width":800}' });
    expect(msgs[4]).toEqual({ role: 'user', content: [{ type: 'text', text: 'The image returned by the tool:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] });
  });

  it('explains an unreachable local server, and lists the models a server has', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const p = new ChatCompletionsProvider('ollama', 'http://localhost:11434/v1', null, 'qwen3');
    await expect(p.turn({ system: '', tools: [], messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/OLLAMA_ORIGINS/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'qwen3' }, { id: 'llama3.1' }] }))));
    expect(await listModels('http://localhost:11434/v1/', null)).toEqual(['llama3.1', 'qwen3']);
  });

  it('turns JSON Schema into the subset Gemini accepts', () => {
    expect(geminiSchema({ type: 'object', additionalProperties: false, properties: { n: { type: 'integer', exclusiveMinimum: 0 }, k: { const: 'x' } }, required: ['n'] })).toEqual({
      type: 'object',
      properties: { n: { type: 'integer', minimum: 0 }, k: { enum: ['x'], type: 'string' } },
      required: ['n'],
    });
  });
});
