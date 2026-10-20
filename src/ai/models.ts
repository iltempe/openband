// AI providers and models offered in the in-browser chat, their list prices and the usage maths. No SDK
// here, so the chat UI can show prices without loading any client code.
// Prices: USD per million tokens, list prices as of October 2026 (Gemini's are introductory rates).

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom';

export interface ModelInfo {
  id: string;
  name: string;
  input: number;
  output: number;
  cacheRead: number;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** Where requests go (editable for Ollama and custom servers). */
  baseUrl: string;
  /** Does it need an API key? (Ollama on this computer doesn't.) */
  needsKey: boolean;
  /** What a key looks like, to catch a key pasted into the wrong provider. */
  keyPattern?: RegExp;
  keyHint?: string;
  keyUrl?: string;
  /** Models offered; empty = the user types or picks a model name (local / custom servers). */
  models: readonly ModelInfo[];
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    needsKey: true,
    keyPattern: /^sk-ant-[\w-]{10,}$/,
    keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: 0.2 },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2 },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI (ChatGPT models)',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    keyPattern: /^sk-[\w-]{20,}$/,
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', input: 2, output: 10, cacheRead: 0.1 },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', input: 10, output: 50, cacheRead: 1 },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', input: 0.1, output: 0.5, cacheRead: 0.01 },
    ],
  },
  {
    id: 'gemini',
    name: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    keyPattern: /^AIza[\w-]{30,}$/,
    keyHint: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', input: 0.75, output: 3.75, cacheRead: 0.075 },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', input: 2, output: 10, cacheRead: 0.1 },
      { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', input: 0.3, output: 2.5, cacheRead: 0.03 },
    ],
  },
  { id: 'ollama', name: 'Ollama (on your computer)', baseUrl: 'http://localhost:11434/v1', needsKey: false, models: [] },
  { id: 'custom', name: 'Other OpenAI-compatible server', baseUrl: 'http://localhost:1234/v1', needsKey: false, models: [] },
];

export const providerInfo = (id: ProviderId) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

/** Every priced model (Anthropic's first, as before). */
export const MODELS: readonly ModelInfo[] = PROVIDERS.flatMap((p) => p.models);
export type ModelId = string;

/** Estimated cost in US dollars; models without a list price (local, custom) cost nothing here. Anthropic
 *  bills cache writes at 1.25× the input price; the others report no cache writes. */
export function costUsd(model: string, u: Usage): number {
  const m = MODELS.find((x) => x.id === model);
  if (!m) return 0;
  return (u.input_tokens * m.input + u.cache_creation_input_tokens * m.input * 1.25 + u.cache_read_input_tokens * m.cacheRead + u.output_tokens * m.output) / 1e6;
}

export const addUsage = (a: Usage, b: Partial<Usage>): Usage => ({
  input_tokens: a.input_tokens + (b.input_tokens ?? 0),
  output_tokens: a.output_tokens + (b.output_tokens ?? 0),
  cache_creation_input_tokens: a.cache_creation_input_tokens + (b.cache_creation_input_tokens ?? 0),
  cache_read_input_tokens: a.cache_read_input_tokens + (b.cache_read_input_tokens ?? 0),
});
export const NO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
