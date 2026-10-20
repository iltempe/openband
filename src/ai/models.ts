// Models offered in the in-browser chat, their list prices and the usage maths. No SDK here, so the
// chat UI can show prices without loading the Anthropic SDK.

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: 0.2 },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2 },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01 },
] as const;
export type ModelId = (typeof MODELS)[number]['id'];

/** Estimated cost in US dollars (cache writes at 1.25× the input price). */
export function costUsd(model: string, u: Usage): number {
  const m = MODELS.find((x) => x.id === model) ?? MODELS[0];
  return (u.input_tokens * m.input + u.cache_creation_input_tokens * m.input * 1.25 + u.cache_read_input_tokens * m.cacheRead + u.output_tokens * m.output) / 1e6;
}

export const addUsage = (a: Usage, b: Partial<Usage>): Usage => ({
  input_tokens: a.input_tokens + (b.input_tokens ?? 0),
  output_tokens: a.output_tokens + (b.output_tokens ?? 0),
  cache_creation_input_tokens: a.cache_creation_input_tokens + (b.cache_creation_input_tokens ?? 0),
  cache_read_input_tokens: a.cache_read_input_tokens + (b.cache_read_input_tokens ?? 0),
});
export const NO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
