// LLM providers for the in-browser agent: Anthropic (here), OpenAI, Gemini, Ollama and any
// OpenAI-compatible server (openai.ts). makeProvider picks one from the user's choice.
import Anthropic from '@anthropic-ai/sdk';
import type { ModelId, Usage } from './models';
import { baseUrlOf, type AiChoice } from './keys';
import { ChatCompletionsProvider, OpenAIResponsesProvider } from './openai';

export * from './models';

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface TurnResult {
  /** The assistant content blocks exactly as returned (appended to history unchanged). */
  content: Anthropic.Beta.BetaContentBlock[];
  stop_reason: string | null;
  usage: Usage;
  model: string;
}

export interface TurnRequest {
  system: string;
  tools: ToolSpec[];
  messages: Anthropic.Beta.BetaMessageParam[];
  signal?: AbortSignal;
  /** Streamed text, as it arrives. */
  onText?: (delta: string) => void;
}

export interface LLMProvider {
  readonly id: string;
  turn(req: TurnRequest): Promise<TurnResult>;
}

/** The provider for what the user picked; `key` is null (or 'none') for servers that need none. */
export function makeProvider(c: AiChoice, key: string | null): LLMProvider {
  const k = key && key !== 'none' ? key : null;
  if (c.provider === 'anthropic') return new AnthropicProvider(k ?? '', c.model);
  if (c.provider === 'openai') return new OpenAIResponsesProvider(baseUrlOf(c), k ?? '', c.model);
  return new ChatCompletionsProvider(c.provider, baseUrlOf(c), k, c.model);
}

/**
 * Anthropic Messages API, called from the browser with the user's own key. The SDK's
 * `dangerouslyAllowBrowser` sends `anthropic-dangerous-direct-browser-access: true`: the key is
 * visible to whoever controls this browser — acceptable only because it is the user's key, on their
 * device. Requests go straight from the browser to Anthropic.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  private client: Anthropic;
  constructor(
    apiKey: string,
    private model: ModelId = 'claude-opus-5-5',
  ) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    // Tools and system are the same every request: cache them (the tool list is large).
    const tools = req.tools.map((t, i) => ({ ...t, eager_input_streaming: true, ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}) }));
    // On a policy decline, let the API re-run the request on a fallback model (not offered for Haiku).
    const fallback = this.model === 'claude-haiku-5-5' ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 64000,
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        tools: tools as Anthropic.Beta.BetaToolUnion[],
        messages: req.messages,
        ...fallback,
      },
      { signal: req.signal },
    );
    if (req.onText) stream.on('text', (d) => req.onText!(d));
    const msg = await stream.finalMessage();
    return {
      content: msg.content,
      stop_reason: msg.stop_reason,
      model: msg.model,
      usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens, cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0, cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0 },
    };
  }
}
