// The work's manifest (SPEC v0.6 G7): what a timestamp proves existed at a date — title, authors, the date
// declared, the licence, and the SHA-256 of each file of the work (master, project, lyrics, chords). One
// canonical JSON (sorted keys, no spaces): the same work always gives the same bytes, hence the same hash.

export interface WorkFile {
  name: string;
  sha256: string;
  bytes: number;
}
export interface Manifest {
  format: 'openband-work/1';
  title: string;
  authors: string[];
  declared_date: string;
  license: string;
  files: Record<string, WorkFile>;
  /** The song's version: the hash of its canonical project. */
  project_version: string;
  made_with: string;
}

const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v);

/** The manifest's bytes, canonical. */
export const canonicalManifest = (m: Manifest) => JSON.stringify(sortKeys(m));

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
