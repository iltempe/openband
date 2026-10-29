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
  /**
   * Who made what (SPEC v0.6 §6, from the contribution ledger): so the timestamp also proves how much of
   * the work is human. Absent in manifests stamped before v0.6.41.
   */
  contributions?: Contributions;
}

export interface Contributions {
  /** Share of the bars of content made by engines, 0..1 (0: all human). */
  ai_share: number;
  tracks: { name: string; bars: number; ai_share: number; engines: string[] }[];
  /** Each engine that made something still in the song, with its licence. */
  engines: { id: string; name: string; version?: string; capabilities: string[]; license: string; commercial: 'yes' | 'no' | 'conditional' }[];
  attributions: string[];
  /** SHA-256 of the ledger's canonical JSON, and how many entries it has. */
  ledger_sha256: string;
  ledger_entries: number;
}

const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v);

/** The manifest's bytes, canonical. */
export const canonicalManifest = (m: Manifest) => JSON.stringify(sortKeys(m));

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
