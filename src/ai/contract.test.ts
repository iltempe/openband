// The directors' contract (SPEC v0.6 §8.4): every provider the page chat speaks to — Anthropic, OpenAI
// Responses, Gemini (OpenAI-compatible) and Ollama — gets the same core + capability tools, can call
// load_toolset, and sees the new tools on the next turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { commands } from '../commands';
import { newChat, runTurn } from './agent';
import { AnthropicProvider } from './provider';
import { ChatCompletionsProvider, OpenAIResponsesProvider } from './openai';
import { CAPABILITY, CORE, TOOLSETS } from '../../server/tools.mjs';

type Sent = { url: string; body: Record<string, unknown> };

/** A fetch answering in turn with JSON bodies, or SSE text for Anthropic's stream. */
function fakeFetch(answers: (unknown | { sse: string })[]) {
  const sent: Sent[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      const a = answers[Math.min(i++, answers.length - 1)] as { sse?: string };
      if (a && typeof a === 'object' && 'sse' in a) return new Response(a.sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return sent;
}

/** Anthropic's stream for one assistant message: a tool call, or text. */
function anthropicSse(content: { tool?: { name: string; input: unknown }; text?: string }) {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
  const usage = { input_tokens: 100, output_tokens: 10 };
  let s = ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage } });
  if (content.tool) {
    s += ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: content.tool.name, input: {} } });
    s += ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(content.tool.input) } });
  } else {
    s += ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    s += ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: content.text ?? '' } });
  }
  s += ev('content_block_stop', { index: 0 });
  s += ev('message_delta', { delta: { stop_reason: content.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  s += ev('message_stop', {});
  return { sse: s };
}

const chatCall = (name: string, args: unknown) => ({ model: 'm', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
const chatText = (text: string) => ({ model: 'm', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
const respCall = (name: string, args: unknown) => ({ model: 'm', status: 'completed', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name, arguments: JSON.stringify(args) }], usage: { input_tokens: 10, output_tokens: 2 } });
const respText = (text: string) => ({ model: 'm', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 2 } });

/** The tool names a provider's request carried, whatever its format. */
const toolNames = (s: Sent): string[] =>
  ((s.body.tools as Record<string, unknown>[]) ?? []).map((t) => String((t.function as { name?: string } | undefined)?.name ?? t.name));

const PROVIDERS = [
  {
    name: 'Anthropic',
    make: () => new AnthropicProvider('sk-ant-test', 'claude-opus-5-5'),
    answers: [anthropicSse({ tool: { name: 'load_toolset', input: { name: 'lyrics' } } }), anthropicSse({ text: 'Ready.' })],
  },
  {
    name: 'OpenAI (Responses)',
    make: () => new OpenAIResponsesProvider('https://api.openai.com/v1', 'sk-test', 'gpt-6.1-sol'),
    answers: [respCall('load_toolset', { name: 'lyrics' }), respText('Ready.')],
  },
  {
    name: 'Gemini (OpenAI-compatible)',
    make: () => new ChatCompletionsProvider('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'AIzaTEST', 'gemini-3.8-flash'),
    answers: [chatCall('load_toolset', { name: 'lyrics' }), chatText('Ready.')],
  },
  {
    name: 'Ollama',
    make: () => new ChatCompletionsProvider('ollama', 'http://localhost:11434/v1', null, 'qwen3.6'),
    answers: [chatCall('load_toolset', { name: 'lyrics' }), chatText('Ready.')],
  },
];

describe("the directors' contract (§8.4)", () => {
  beforeEach(() => {
    commands.new_project({ name: 'T', bpm: 100 });
    useStore.setState({ past: [], future: [], activeTransaction: null, bridgeLog: [] });
    newChat();
  });
  afterEach(() => vi.unstubAllGlobals());

  const firstTurns: Record<string, string[]> = {};
  for (const p of PROVIDERS)
    it(`${p.name}: core + capability tools, load_toolset, the new tools on the next turn`, async () => {
      const sent = fakeFetch(p.answers);
      await runTurn('Hello there', p.make());
      expect(sent.length).toBeGreaterThanOrEqual(2);
      const first = toolNames(sent[0]).sort();
      const expected = [...CORE, ...CAPABILITY].filter((n) => n !== 'begin_change' && n !== 'end_change').sort();
      expect(first).toEqual(expected);
      expect(first).not.toContain('set_lyrics');
      firstTurns[p.name] = first;
      const second = toolNames(sent[1]);
      for (const n of TOOLSETS.lyrics.tools) expect(second).toContain(n);
      expect(second).not.toContain('set_lyrics_typo');
    });

  it('every provider got the very same first set of tools', () => {
    const sets = Object.values(firstTurns).map((x) => x.join(','));
    expect(sets).toHaveLength(PROVIDERS.length);
    expect(new Set(sets).size).toBe(1);
  });

  it('the request\'s words preload the obvious toolsets ("mixa" → mix)', async () => {
    const sent = fakeFetch([chatText('Ok.')]);
    await runTurn('Mixa la canzone e aggiungi un po\' di riverbero', new ChatCompletionsProvider('ollama', 'http://localhost:11434/v1', null, 'qwen3.6'));
    expect(toolNames(sent[0])).toContain('set_track_effects');
    expect(toolNames(sent[0])).not.toContain('set_lyrics');
  });
});
