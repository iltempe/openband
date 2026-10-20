// The tools the in-browser agent offers Claude: the very same definitions as the MCP server
// (server/tools.mjs), turned into JSON Schema, plus how to run each kind here in the browser.
import { z } from 'zod';
import { INSTRUCTIONS, TOOLS, type ToolDef } from '../../server/tools.mjs';

export { INSTRUCTIONS };

/** Kinds the browser can run: studio → AI events belong to the MCP server and are left out. */
const IN_BROWSER = new Set(['call', 'file', 'export', 'chord_sheet', 'image']);

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
  cache = TOOLS.filter((t) => IN_BROWSER.has(t.kind)).map((def) => {
    const shape = def.kind === 'file' ? { source: sourceArg, ...def.shape } : def.kind === 'export' ? {} : def.shape;
    const schema = z.object(shape);
    const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
    return { def, schema, jsonSchema };
  });
  return cache;
}

export const findTool = (name: string) => agentTools().find((t) => t.def.name === name);

/** Validate a tool input; an error message for Claude when it doesn't fit the schema. */
export function validateInput(name: string, input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const t = findTool(name);
  if (!t) return { ok: false, error: `Unknown tool "${name}"` };
  const r = t.schema.safeParse(input ?? {});
  if (r.success) return { ok: true, value: r.data as Record<string, unknown> };
  return { ok: false, error: `Invalid input for ${name}: ${r.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}` };
}

/** What changes in the instructions when Claude runs inside the browser (no files, no event stream). */
export const BROWSER_NOTE = `
You are running inside the OpenBand studio in the user's browser, with the user's own API key. Files can only be imported from http(s) URLs, exports download in the browser, and there is no event stream (get_events / wait_for_event are not available): the user talks to you in this chat. Keep answers short: the user sees the changes in the studio.`;
