export const SCHEMAS: Record<'manifest' | 'scp' | 'contribution' | 'toolInput', object>;
/** Errors of `value` against an OMEP schema, as "path message" strings; empty when valid. */
export function validate(kind: 'manifest' | 'scp' | 'contribution' | 'toolInput', value: unknown): string[];
export const CATALOG: Record<string, { output: string[] }>;
export const EXTENSION: 'io.openband/music-engine';
