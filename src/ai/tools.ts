// The tools the in-browser agent offers Claude: the very same definitions as the MCP server
// (server/tools.mjs), turned into JSON Schema, plus how to run each kind here in the browser.
import { z } from 'zod';
import { INSTRUCTIONS, TOOLS, levelOf, type ToolDef } from '../../server/tools.mjs';

export { INSTRUCTIONS };

/** Kinds the browser can run: studio → AI events belong to the MCP server and are left out. */
/** In the page there is no disk: exports download, so save_to is not offered. */
const withoutSaveTo = (shape: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(shape).filter(([k]) => k !== 'save_to'));
const IN_BROWSER = new Set(['call', 'file', 'export', 'chord_sheet', 'image', 'toolset']);
/** The agent makes each request one undo step itself: a model opening its own (small local models do)
 *  would nest a second one inside. */
const AGENT_OWNED = new Set(['begin_change', 'end_change']);

export interface AgentTool {
  def: ToolDef;
  /** zod schema of the input (with `source` for file tools) used to validate what Claude sends. */
  schema: z.ZodObject;
  jsonSchema: Record<string, unknown>;
}

const sourceArg = z.string().describe('http(s) URL of the file (in the browser, local paths are not available)');

let cache: AgentTool[] | null = null;
export function agentTools(): AgentTool[] {
  if (cache) return cache;
  cache = TOOLS.filter((t) => IN_BROWSER.has(t.kind) && !AGENT_OWNED.has(t.name)).map((def) => {
    const shape = def.kind === 'file' ? { source: sourceArg, ...def.shape } : def.kind === 'export' ? withoutSaveTo(def.shape) : def.shape;
    const schema = z.object(shape);
    const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
    return { def, schema, jsonSchema };
  });
  return cache;
}

export const findTool = (name: string) => agentTools().find((t) => t.def.name === name);

/**
 * The tools offered on a turn (SPEC v0.6 §8.1): core and capability ones always, the domain toolsets
 * once loaded (by the planner from the request's words, or by the model with load_toolset).
 */
export function toolsFor(loaded: Set<string>): AgentTool[] {
  return agentTools().filter((t) => {
    const level = levelOf(t.def.name);
    return level === 'core' || level === 'capability' || loaded.has('all') || (level !== null && loaded.has(level));
  });
}

/** Validate a tool input; an error message for Claude when it doesn't fit the schema. */
export function validateInput(name: string, input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const t = findTool(name);
  if (!t) return { ok: false, error: `Unknown tool "${name}"` };
  // Models other than Claude send arguments as a JSON string, which can arrive broken.
  if (input && typeof input === 'object' && '__invalid_json__' in input) return { ok: false, error: `The arguments for ${name} were not valid JSON: send them again.` };
  const r = t.schema.safeParse(input ?? {});
  if (r.success) return { ok: true, value: r.data as Record<string, unknown> };
  return { ok: false, error: `Invalid input for ${name}: ${r.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}` };
}

/** What changes in the instructions when Claude runs inside the browser (no files, no event stream). */
export const BROWSER_NOTE = `
You are running inside the OpenBand studio in the user's browser, with the user's own API key. Files can only be imported from http(s) URLs, exports download in the browser, and there is no event stream (get_events / wait_for_event are not available): the user talks to you in this chat. Keep answers short: the user sees the changes in the studio.`;
