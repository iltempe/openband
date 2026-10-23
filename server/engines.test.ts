import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EngineHost, readEnginesConfig } from './engines.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-engines-'));
const file = path.join(dir, 'engines.json');
const mock = path.resolve('omep/mock-engine.mjs');
fs.writeFileSync(
  file,
  JSON.stringify({
    engines: {
      mock: { builtin: 'omep-mock' },
      sharp: { command: process.execPath, args: [mock, '--wrong-key'] },
      missing: { command: path.join(dir, 'no-such-engine') },
      'bad id!': { command: 'x' },
      remote: { url: 'ftp://nope' },
    },
  }),
);
const host = new EngineHost({ file });
afterAll(() => host.close());
const context = JSON.parse(fs.readFileSync('omep/examples/context.json', 'utf8'));

describe('engine host', () => {
  it('reads only well-formed entries the user wrote', () => {
    expect(Object.keys(readEnginesConfig(file)).sort()).toEqual(['missing', 'mock', 'sharp']);
    expect(readEnginesConfig(path.join(dir, 'none.json'))).toEqual({});
  });

  it('starts the configured engines, reads their manifests, reports the broken ones', async () => {
    const list = await host.list();
    const by = Object.fromEntries(list.map((e) => [e.id, e]));
    expect(by.mock.status).toBe('ready');
    expect(by.mock.manifest.engine.id).toBe('omep-mock');
    expect(Object.keys(by.sharp.manifest.capabilities)).toContain('music.add_layer');
    expect(by.missing.status).toBe('error');
  }, 30000);

  it('calls a capability; files come back inline as audio', async () => {
    const notes = await host.call('mock', 'symbolic.drums', { context, seed: 2 });
    expect(notes.kind).toBe('notes');
    expect(notes.notes.length).toBeGreaterThan(50);
    const layer = await host.call('mock', 'music.add_layer', { context });
    expect(layer.files[0].uri).toMatch(/^data:audio\/wav;base64,UklGR/);
    await expect(host.call('mock', 'voice.sing', { context })).rejects.toThrow(/no tool voice\.sing/);
    await expect(host.call('ghost', 'symbolic.drums', { context })).rejects.toThrow(/No engine "ghost"/);
  }, 30000);

  it('reloads the file: a removed engine is stopped', async () => {
    fs.writeFileSync(file, JSON.stringify({ engines: { mock: { builtin: 'omep-mock' } } }));
    const list = await host.list();
    expect(list.map((e) => e.id)).toEqual(['mock']);
    expect(host.live.has('sharp')).toBe(false);
  }, 30000);
});
