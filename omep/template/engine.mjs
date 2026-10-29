#!/usr/bin/env node
// __NAME__ — an OMEP 1.0 engine (https://github.com/iltempe/openband/tree/main/omep), made from omep-template.
//
// An OMEP engine is an MCP server that (1) declares the OMEP extension, (2) serves its manifest as the
// resource omep://manifest and (3) has one tool per capability, named like the capability, that takes a
// Song Context Package (`context`) and returns a Contribution as structuredContent.
//
// This one plays `symbolic.drums`: a groove over the bars the studio asks for. Replace `makeDrums` with
// your model (and the manifest with what it really is), then check it:
//
//   npm run conformance      (or: node <openband>/omep/conformance.mjs -- node engine.mjs)
//
// Everything marked TODO is yours to change.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const EXTENSION = 'io.openband/music-engine';

// TODO: who you are, under which licence, where it runs, what it can do.
const LICENSE = { code: '__LICENSE__', weights: null, commercial: 'yes', attribution: null, conditions: null, url: '__HOMEPAGE__' };
const MANIFEST = {
  omep: '1.0',
  engine: { id: '__ID__', name: '__NAME__', version: '0.1.0', homepage: '__HOMEPAGE__' },
  license: LICENSE,
  runtime: { where: 'local', device: ['cpu'], realtime: false },
  capabilities: {
    // What of the context your model actually uses: the studio enforces the rest afterwards.
    'symbolic.drums': { conditioning: ['bpm', 'meter', 'sections'] },
  },
  outputs: ['application/x-omep-notes'],
  languages: ['en'],
  determinism: 'seeded',
};

/** A small seeded random generator: same seed, same result (the manifest says "seeded"). */
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * TODO: your model. Notes are in beats from the start of the scope (General MIDI drums: 36 kick, 38
 * snare, 42 closed hi-hat), velocity 0..1. `scp` is the Song Context Package: song.bpm, song.meter,
 * scope.from_bar / to_bar (to_bar exclusive), sections, harmony, intent.text…
 */
function makeDrums(scp, seed) {
  const beatsPerBar = Number(String(scp.song?.meter ?? '4/4').split('/')[0]) || 4;
  const from = scp.scope?.from_bar ?? 1;
  const to = scp.scope?.to_bar ?? from + (scp.song?.length_bars ?? 4);
  const bars = Math.max(1, to - from);
  const r = random(seed);
  const notes = [];
  for (let bar = 0; bar < bars; bar++) {
    for (let beat = 0; beat < beatsPerBar; beat++) {
      const at = bar * beatsPerBar + beat;
      notes.push({ pitch: beat % 2 ? 38 : 36, start: at, duration: 0.25, velocity: beat % 2 ? 0.8 : 0.9 });
      for (const off of [0, 0.5]) notes.push({ pitch: 42, start: at + off, duration: 0.125, velocity: +(0.4 + r() * 0.2).toFixed(2) });
    }
  }
  // Claims: what you say you respected. The studio measures them anyway.
  return { notes, claims: { bpm: scp.song?.bpm, length_bars: bars, meter: scp.song?.meter ?? '4/4' } };
}

const server = new McpServer({ name: MANIFEST.engine.id, version: MANIFEST.engine.version }, { capabilities: { experimental: { [EXTENSION]: { version: '1.0' } } } });

server.registerResource('manifest', 'omep://manifest', { title: 'OMEP manifest', mimeType: 'application/json' }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(MANIFEST, null, 2) }],
}));

server.registerTool(
  'symbolic.drums',
  {
    title: 'Drums',
    description: `${MANIFEST.engine.name}: a drum part over the scope, as notes`,
    inputSchema: {
      context: z.union([z.looseObject({}), z.string()]).describe('Song Context Package (or a file:// URI of one)'),
      request: z.looseObject({}).optional(),
      seed: z.number().int().optional(),
      variants: z.number().int().min(1).max(8).optional(),
    },
  },
  async ({ context, seed = 1 }) => {
    if (typeof context !== 'object') return { content: [{ type: 'text', text: 'This engine needs the context inline' }], isError: true };
    const { notes, claims } = makeDrums(context, seed);
    const contribution = {
      kind: 'notes',
      notes,
      claims: Object.fromEntries(Object.entries(claims).filter(([, v]) => v !== undefined)),
      provenance: { engine: MANIFEST.engine.id, engine_version: MANIFEST.engine.version, model_hash: 'none', seed, capability: 'symbolic.drums' },
      license: LICENSE,
    };
    return { content: [{ type: 'text', text: `${notes.length} drum notes over ${claims.length_bars} bars` }], structuredContent: contribution };
  },
);

await server.connect(new StdioServerTransport());
