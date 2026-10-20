// AI models other than Claude for the in-browser agent, with plain fetch (no SDK):
//
// - OpenAI through the Responses API (api.openai.com).
// - Everything that speaks OpenAI's Chat Completions: Google Gemini (its OpenAI-compatible endpoint),
//   Ollama and LM Studio on this computer, OpenRouter, a self-hosted vLLM…
//
// The agent (agent.ts) keeps one history in the Anthropic shape; these providers translate it on the way
// out and translate the answer back. What a model returned is kept exactly as it came (by identity of the
// content array the agent stores) and sent back unchanged: reasoning items, Gemini's thought signatures
// and any other field this code doesn't know about survive the round trip.
import type Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ToolSpec, TurnRequest, TurnResult } from './provider';
import type { ProviderId } from './models';
import { aiFetch } from '../desktop';

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;
type Json = Record<string, unknown>;

interface ToolResultParts {
  text: string;
  images: string[]; // data: URLs
}

/** A tool_result's content as text plus images (data URLs). */
function resultParts(content: unknown): ToolResultParts {
  if (typeof content === 'string') return { text: content, images: [] };
  const out: ToolResultParts = { text: '', images: [] };
  for (const c of (content as Json[] | undefined) ?? []) {
    if (c.type === 'text') out.text += (out.text ? '\n' : '') + String(c.text);
    else if (c.type === 'image') {
      const s = c.source as { media_type: string; data: string };
      out.images.push(`data:${s.media_type};base64,${s.data}`);
    }
  }
  return out;
}

const blocksOf = (m: Msg): Block[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as Block[]));
const parseArgs = (s: unknown): Json => {
  if (s && typeof s === 'object') return s as Json;
  try {
    const v = JSON.parse(String(s || '{}'));
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    // The model sent broken JSON: the agent's validation turns this into an error the model can fix.
    return { __invalid_json__: String(s) };
  }
};

async function post(url: string, body: unknown, key: string | null, signal: AbortSignal | undefined, headers: Record<string, string> = {}): Promise<Json> {
  let res: Response;
  try {
    res = await aiFetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: JSON.stringify(body) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    const host = new URL(url).host;
    const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
    throw new Error(
      local
        ? `Could not reach ${host}. Is the server running? A local server must also allow this page: for Ollama start it with OLLAMA_ORIGINS=${typeof location !== "undefined" ? location.origin : "<this page>"} (see docs/AI-MODELS.md).`
        : `Could not reach ${host} from the browser (offline, or the server refuses requests from web pages).`,
    );
  }
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const err = (json.error as Json | undefined) ?? (Array.isArray(json) ? ((json[0] as Json)?.error as Json) : undefined);
    throw new Error(`${res.status}: ${String(err?.message ?? text.slice(0, 300) ?? res.statusText)}`);
  }
  return json;
}

// ---------------------------------------------------------------- Chat Completions (Gemini, Ollama, …)

/** Gemini accepts a subset of JSON Schema (OpenAPI 3.0 style) for function parameters. */
export function geminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const o: Json = {};
  for (const [k, v] of Object.entries(s as Json)) {
    if (k === 'additionalProperties' || k === 'propertyNames' || k === '$schema') continue;
    if (k === 'exclusiveMinimum' && typeof v === 'number') o.minimum = v;
    else if (k === 'exclusiveMaximum' && typeof v === 'number') o.maximum = v;
    else if (k === 'const') o.enum = [v];
    else if (k === 'properties') o.properties = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    else o[k] = geminiSchema(v);
  }
  // A const string has no type in JSON Schema; Gemini's enum needs one.
  if (o.enum && !o.type) o.type = typeof (o.enum as unknown[])[0] === 'number' ? 'number' : 'string';
  return o;
}

export function chatTools(tools: ToolSpec[], flavor: ProviderId) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: flavor === 'gemini' ? geminiSchema(t.input_schema) : t.input_schema } }));
}

/** The Anthropic-shaped history as Chat Completions messages. */
export function toChatMessages(system: string, history: Msg[], raw: WeakMap<object, unknown>): Json[] {
  const out: Json[] = [{ role: 'system', content: system }];
  for (const m of history) {
    if (m.role === 'assistant') {
      const kept = raw.get(m.content as object);
      if (kept) {
        out.push(kept as Json);
        continue;
      }
      const blocks = blocksOf(m);
      const text = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const calls = blocks.filter((b) => b.type === 'tool_use') as Anthropic.Beta.BetaToolUseBlockParam[];
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}) });
      continue;
    }
    // User: plain text, or the results of the tools called in the previous answer.
    const images: string[] = [];
    const texts: string[] = [];
    for (const b of blocksOf(m)) {
      if (b.type === 'tool_result') {
        const r = resultParts(b.content);
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'Error: ' : '') + (r.text || (r.images.length ? 'See the image below.' : 'Done.')) });
        images.push(...r.images);
      } else if (b.type === 'text') texts.push(b.text);
    }
    // Tool messages carry text only: images a tool returned follow as a user message.
    if (images.length) out.push({ role: 'user', content: [{ type: 'text', text: 'The image returned by the tool:' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] });
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

export function fromChatResponse(json: Json, raw: WeakMap<object, unknown>, fallbackModel: string): TurnResult {
  const choice = ((json.choices as Json[] | undefined) ?? [])[0] ?? {};
  const message = { ...((choice.message as Json | undefined) ?? { role: 'assistant', content: '' }) };
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? (message.content as Json[]).map((p) => String(p.text ?? '')).join('') : '';
  if (text) content.push({ type: 'text', text, citations: null } as Anthropic.Beta.BetaContentBlock);
  const calls: Json[] = ((message.tool_calls as Json[] | undefined) ?? []).map((c, i) => ({ ...c, id: (c.id as string) || `call_${Date.now().toString(36)}_${i}` }));
  if (calls.length) message.tool_calls = calls; // ids filled in where a server leaves them out
  for (const c of calls) {
    const fn = c.function as Json;
    content.push({ type: 'tool_use', id: c.id, name: String(fn.name), input: parseArgs(fn.arguments) } as Anthropic.Beta.BetaContentBlock);
  }
  raw.set(content, { ...message, role: 'assistant' });
  const finish = String(choice.finish_reason ?? '');
  const usage = (json.usage as Json | undefined) ?? {};
  const cached = Number((usage.prompt_tokens_details as Json | undefined)?.cached_tokens ?? 0);
  return {
    content,
    stop_reason: calls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn',
    model: String(json.model ?? fallbackModel),
    usage: { input_tokens: Number(usage.prompt_tokens ?? 0) - cached, output_tokens: Number(usage.completion_tokens ?? 0), cache_creation_input_tokens: 0, cache_read_input_tokens: cached },
  };
}

export class ChatCompletionsProvider implements LLMProvider {
  private raw = new WeakMap<object, unknown>();
  constructor(
    readonly id: ProviderId,
    private baseUrl: string,
    private key: string | null,
    private model: string,
  ) {}

  async turn(req: TurnRequest): Promise<TurnResult> {
    const json = await post(`${this.baseUrl}/chat/completions`, { model: this.model, messages: toChatMessages(req.system, req.messages, this.raw), tools: chatTools(req.tools, this.id) }, this.key, req.signal);
    const r = fromChatResponse(json, this.raw, this.model);
    const said = r.content.find((b) => b.type === 'text') as { text: string } | undefined;
    if (said) req.onText?.(said.text);
    return r;
  }
}

/** Model names a local / custom server offers (GET /models), for the model picker. */
export async function listModels(baseUrl: string, key: string | null): Promise<string[]> {
  const res = await aiFetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => m.id).sort();
}

// ---------------------------------------------------------------- OpenAI Responses API

export function toResponsesInput(history: Msg[], raw: WeakMap<object, unknown>): Json[] {
  const out: Json[] = [];
  for (const m of history) {
    if (m.role === 'assistant') {
      const kept = raw.get(m.content as object) as Json[] | undefined;
      if (kept) {
        out.push(...kept);
        continue;
      }
      for (const b of blocksOf(m)) {
        if (b.type === 'text' && b.text) out.push({ role: 'assistant', content: b.text });
        else if (b.type === 'tool_use') out.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
      continue;
    }
    const images: string[] = [];
    const texts: string[] = [];
    for (const b of blocksOf(m)) {
      if (b.type === 'tool_result') {
        const r = resultParts(b.content);
        out.push({ type: 'function_call_output', call_id: b.tool_use_id, output: (b.is_error ? 'Error: ' : '') + (r.text || (r.images.length ? 'See the image below.' : 'Done.')) });
        images.push(...r.images);
      } else if (b.type === 'text') texts.push(b.text);
    }
    if (images.length) out.push({ role: 'user', content: [{ type: 'input_text', text: 'The image returned by the tool:' }, ...images.map((image_url) => ({ type: 'input_image', image_url }))] });
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

export function fromResponses(json: Json, raw: WeakMap<object, unknown>, fallbackModel: string): TurnResult {
  const output = (json.output as Json[] | undefined) ?? [];
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  let refused = false;
  for (const item of output) {
    if (item.type === 'message') {
      for (const c of (item.content as Json[] | undefined) ?? []) {
        if (c.type === 'output_text' && c.text) content.push({ type: 'text', text: String(c.text), citations: null } as Anthropic.Beta.BetaContentBlock);
        if (c.type === 'refusal') refused = true;
      }
    } else if (item.type === 'function_call') content.push({ type: 'tool_use', id: String(item.call_id), name: String(item.name), input: parseArgs(item.arguments) } as Anthropic.Beta.BetaContentBlock);
  }
  // Everything goes back as it came, reasoning items included (with store: false they carry their state).
  raw.set(content, output);
  const usage = (json.usage as Json | undefined) ?? {};
  const cached = Number((usage.input_tokens_details as Json | undefined)?.cached_tokens ?? 0);
  const incomplete = json.status === 'incomplete' && (json.incomplete_details as Json | undefined)?.reason === 'max_output_tokens';
  return {
    content,
    stop_reason: refused ? 'refusal' : content.some((b) => b.type === 'tool_use') ? 'tool_use' : incomplete ? 'max_tokens' : 'end_turn',
    model: String(json.model ?? fallbackModel),
    usage: { input_tokens: Number(usage.input_tokens ?? 0) - cached, output_tokens: Number(usage.output_tokens ?? 0), cache_creation_input_tokens: 0, cache_read_input_tokens: cached },
  };
}

export class OpenAIResponsesProvider implements LLMProvider {
  readonly id = 'openai';
  private raw = new WeakMap<object, unknown>();
  constructor(
    private baseUrl: string,
    private key: string,
    private model: string,
  ) {}

  async turn(req: TurnRequest): Promise<TurnResult> {
    const json = await post(
      `${this.baseUrl}/responses`,
      {
        model: this.model,
        instructions: req.system,
        input: toResponsesInput(req.messages, this.raw),
        tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })),
        // Nothing is kept on OpenAI's side: the reasoning travels encrypted with the history.
        store: false,
        include: ['reasoning.encrypted_content'],
      },
      this.key,
      req.signal,
    );
    const r = fromResponses(json, this.raw, this.model);
    const said = r.content.find((b) => b.type === 'text') as { text: string } | undefined;
    if (said) req.onText?.(said.text);
    return r;
  }
}
