// Types for server/tools.mjs (plain ESM, shared by the MCP server and the in-browser agent).
import type { ZodType } from 'zod';

export type ToolKind = 'call' | 'file' | 'export' | 'chord_sheet' | 'image' | 'events_list' | 'events_wait';
export interface ToolDef {
  kind: ToolKind;
  name: string;
  description: string;
  shape: Record<string, ZodType>;
  title?: string;
  timeout?: number;
  annotations?: { readOnlyHint?: boolean };
}
export declare const TOOLS: ToolDef[];
export declare const INSTRUCTIONS: string;
