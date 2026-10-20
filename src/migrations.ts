// Project schema migrations. Every way a project enters the app (autosave, .json, .openband
// bundles, MCP import) goes through migrate(), so old songs keep opening. Pure: no store/audio.
import type { Project } from './types';
import { uid } from './music';
import { lanesFromRecord } from './automation';

export const CURRENT_VERSION = 3;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Accept a project of any known version (object or JSON string) and return it as the current schema. */
export function migrate(raw: unknown, now = Date.now()): Project {
  let data = raw;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error('Not an OpenBand project: the file is not valid JSON');
    }
  }
  if (!isObject(data)) throw new Error('Not an OpenBand project: expected a JSON object');
  const version = data.version ?? 1;
  if (typeof version !== 'number' || version < 1) throw new Error('Not an OpenBand project: missing "version"');
  if (version > CURRENT_VERSION) throw new Error(`This project was made with a newer OpenBand (schema v${version}); update the app to open it`);
  if (!Array.isArray(data.tracks) || !Array.isArray(data.regions)) throw new Error('Damaged OpenBand project: "tracks" and "regions" must be lists');

  const p = structuredClone(data) as unknown as Project & Record<string, unknown>;

  // v1 → v2: same shape plus optional fields; fill defaults that very old saves may lack.
  p.name = typeof p.name === 'string' && p.name ? p.name : 'Untitled';
  p.bpm = typeof p.bpm === 'number' && p.bpm > 0 ? p.bpm : 110;
  p.key = typeof p.key === 'string' && p.key ? p.key : 'C';
  p.loop = isObject(p.loop) ? p.loop : { enabled: false, start: 0, end: 16 };
  p.masterVolume = typeof p.masterVolume === 'number' ? p.masterVolume : 0.8;
  p.metronome = !!p.metronome;
  for (const r of p.regions) {
    if (!Array.isArray(r.notes)) r.notes = [];
  }
  // Annotation authors were 'ai' | 'user'; now {kind, name} (F16 in rooms).
  if (Array.isArray(p.annotations))
    for (const a of p.annotations as unknown as { author: unknown }[]) {
      if (a.author === 'ai') a.author = { kind: 'ai', name: 'AI' };
      else if (typeof a.author === 'string' || !a.author) a.author = { kind: 'user', name: 'You' };
    }
  // v2 → v3: track automation becomes a list of lanes with open targets (F22).
  for (const t of p.tracks) {
    const lanes = lanesFromRecord((t as { automation?: unknown }).automation);
    if (lanes) t.automation = lanes;
    else delete t.automation;
  }
  p.version = 3;
  const meta = isObject(p.meta) ? (p.meta as Partial<Project['meta']>) : {};
  p.meta = {
    projectId: typeof meta?.projectId === 'string' && meta.projectId ? meta.projectId : uid('song'),
    createdAt: typeof meta?.createdAt === 'number' ? meta.createdAt : now,
    updatedAt: typeof meta?.updatedAt === 'number' ? meta.updatedAt : now,
  };
  return p;
}
