// The in-browser agent: the user's message → Claude → tool calls run with runCommand → tool results →
// … until Claude is done. Each user turn is one undo step (begin_change/end_change), at most 40 tool
// calls, and Stop works at any time. The history is only ever appended to.
import type Anthropic from '@anthropic-ai/sdk';
import { runCommand } from '../commands';
import { useStore } from '../store';
import { BROWSER_NOTE, INSTRUCTIONS, agentTools, findTool, validateInput } from './tools';
import { NO_USAGE, addUsage, costUsd, type Usage } from './models';
import type { LLMProvider } from './provider';
import { useChat } from './chat';

export { useChat };

type Block = Anthropic.Beta.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export const MAX_TOOL_CALLS = 40;

let history: Anthropic.Beta.BetaMessageParam[] = [];
let controller: AbortController | null = null;
let seq = 0;
const id = () => `c${++seq}`;

export function newChat() {
  if (useChat.getState().busy) return;
  history = [];
  useChat.setState({ items: [], live: '' });
}
export const stopTurn = () => controller?.abort();
/** For tests. */
export const chatHistory = () => history;

const asJson = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));

async function toBase64(url: string): Promise<{ data_base64: string; filename: string }> {
  if (!/^https?:\/\//i.test(url)) throw new Error('In the browser files can only be imported from an http(s) URL');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data_base64: btoa(bin), filename: decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download') };
}

/** Run one tool call; returns the tool_result content. */
async function execute(name: string, input: Record<string, unknown>): Promise<ToolResult['content']> {
  const t = findTool(name)!;
  switch (t.def.kind) {
    case 'file': {
      const { source, ...rest } = input as { source: string };
      return asJson(await runCommand(name, { ...rest, ...(await toBase64(source)) }, 'ai'));
    }
    case 'export':
      return asJson(await runCommand(name, {}, 'ai'));
    case 'chord_sheet': {
      const r = (await runCommand(name, { format: input.format }, 'ai')) as { text?: string };
      return asJson(r?.text ?? r);
    }
    case 'image': {
      const r = (await runCommand(name, input, 'ai')) as { png_base64: string; width: number; height: number; from_bar: number; to_bar: number };
      return [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: r.png_base64 } },
        { type: 'text', text: JSON.stringify({ width: r.width, height: r.height, from_bar: r.from_bar, to_bar: r.to_bar }) },
      ];
    }
    default:
      return asJson(await runCommand(name, input, 'ai'));
  }
}

/** Results for tool calls that won't run (stopped, limit), so the history stays valid. */
function closePendingToolUses(reason: string) {
  const last = history[history.length - 1];
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return;
  const uses = (last.content as Block[]).filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === 'tool_use');
  if (uses.length) history.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: reason, is_error: true })) });
}

/** One user turn. Resolves when Claude is done (or stopped). */
export async function runTurn(text: string, provider: LLMProvider, opts: { maxToolCalls?: number; model?: string } = {}) {
  const st = useChat.getState();
  if (st.busy) throw new Error('Wait for the current answer (or press Stop)');
  const max = opts.maxToolCalls ?? MAX_TOOL_CALLS;
  controller = new AbortController();
  const signal = controller.signal;
  useChat.setState((s) => ({ busy: true, live: '', items: [...s.items, { id: id(), role: 'user', text }] }));
  const tools = agentTools().map((t) => ({ name: t.def.name, description: t.def.description, input_schema: t.jsonSchema }));
  const system = INSTRUCTIONS + BROWSER_NOTE;
  let usage: Usage = NO_USAGE;
  let model = opts.model ?? '';
  let calls = 0;
  let overLimit = 0;
  let answer = '';
  // The whole turn is one undo step, named after the request.
  await runCommand('begin_change', { label: text.trim().slice(0, 60) || 'AI' }, 'ai');
  const txId = useStore.getState().activeTransaction?.id;
  history.push({ role: 'user', content: text });
  try {
    for (;;) {
      const res = await provider.turn({ system, tools, messages: history, signal, onText: (d) => useChat.setState((s) => ({ live: s.live + d })) });
      model = res.model || model;
      usage = addUsage(usage, res.usage);
      history.push({ role: 'assistant', content: res.content as Block[] });
      const said = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      if (said) answer += (answer ? '\n\n' : '') + said;
      useChat.setState({ live: '' });
      if (res.stop_reason === 'refusal') {
        closePendingToolUses('declined');
        answer += (answer ? '\n\n' : '') + '⚠ Claude declined this request.';
        break;
      }
      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (!uses.length) break;
      // A cut-off answer can carry an incomplete tool input: don't run it, ask again.
      const truncated = res.stop_reason === 'max_tokens';
      const results: ToolResult[] = [];
      for (const u of uses) {
        if (signal.aborted) break;
        if (truncated) {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: 'The tool input was cut off (max_tokens): send it again, shorter.', is_error: true });
          continue;
        }
        if (calls >= max) {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: `Stopped: at most ${max} tool calls per request. Tell the user what is left to do.`, is_error: true });
          continue;
        }
        calls++;
        const v = validateInput(u.name, u.input);
        if (!v.ok) {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: v.error, is_error: true });
          continue;
        }
        try {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: await execute(u.name, v.value) });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: `Error: ${(e as Error).message}`, is_error: true });
        }
      }
      if (signal.aborted) break;
      history.push({ role: 'user', content: results });
      // Past the limit Claude gets one more round to say what is left, then the turn ends.
      if (calls >= max && ++overLimit > 1) break;
    }
  } catch (e) {
    if (!signal.aborted) answer += (answer ? '\n\n' : '') + `⚠ ${(e as Error).message}`;
  } finally {
    if (signal.aborted) {
      closePendingToolUses('Stopped by the user.');
      answer += (answer ? '\n\n' : '') + '⏹ Stopped.';
    }
    await runCommand('end_change', {}, 'ai').catch(() => {});
    controller = null;
    const cost = costUsd(model, usage);
    useChat.setState((s) => ({ busy: false, live: '', total: s.total + cost, items: [...s.items, { id: id(), role: 'assistant', text: answer, txId, cost, tools: calls }] }));
  }
}
