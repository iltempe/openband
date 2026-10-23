// OMEP 1.0 JSON Schemas, compiled once (JSON Schema 2020-12, ajv).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
const load = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

export const SCHEMAS = {
  manifest: load('manifest.schema.json'),
  scp: load('scp.schema.json'),
  contribution: load('contribution.schema.json'),
  toolInput: load('tool-input.schema.json'),
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const s of Object.values(SCHEMAS)) ajv.addSchema(s);

const compiled = Object.fromEntries(Object.entries(SCHEMAS).map(([k, s]) => [k, ajv.getSchema(s.$id)]));

/** Validate `value` against one of the OMEP schemas: [] when valid, else readable errors. */
export function validate(kind, value) {
  const fn = compiled[kind];
  if (!fn) throw new Error(`Unknown OMEP schema "${kind}"`);
  if (fn(value)) return [];
  return (fn.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ''}`);
}

/** The capability catalog of OMEP 1.0: what each capability returns. */
export const CATALOG = {
  'music.song': { output: ['audio', 'stems'] },
  'music.add_layer': { output: ['audio'] },
  'music.repaint': { output: ['audio'] },
  'music.extend': { output: ['audio'] },
  'music.restyle': { output: ['audio', 'stems'] },
  'music.arrange': { output: ['notes', 'params'] },
  'symbolic.continue': { output: ['notes'] },
  'symbolic.harmonize': { output: ['notes'] },
  'symbolic.accompany': { output: ['notes'] },
  'symbolic.drums': { output: ['notes'] },
  'voice.sing': { output: ['audio'] },
  'audio.separate': { output: ['stems'] },
  'audio.transcribe': { output: ['notes'] },
  'audio.match_sound': { output: ['params'] },
  'mix.assist': { output: ['params'] },
  'stream.jam': { output: ['stream'] },
};

/** The MCP capability an OMEP engine declares (under `experimental` until MCP extensions are widely supported). */
export const EXTENSION = 'io.openband/music-engine';
