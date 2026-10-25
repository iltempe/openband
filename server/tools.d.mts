// Types for server/tools.mjs (plain ESM, shared by the MCP server and the in-browser agent).
import type { ZodType } from 'zod';

export type ToolKind = 'call' | 'file' | 'export' | 'chord_sheet' | 'image' | 'events_list' | 'events_wait' | 'toolset';
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
export declare const CORE: string[];
export declare const CAPABILITY: string[];
export declare const TOOLSETS: Record<string, { description: string; tools: string[] }>;
export declare function levelOf(name: string): string | null;
export declare function planToolsets(text: string): string[];
