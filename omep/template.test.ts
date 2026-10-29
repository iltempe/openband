import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runConformance } from './conformance.mjs';
import { newEngine } from './new-engine.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);

describe('omep-template', () => {
  it('an engine made from the template passes conformance as it comes', async () => {
    // Inside the repo, so the engine finds the MCP SDK in its node_modules.
    const dir = fs.mkdtempSync(path.join(here, '..', 'build', 'omep-tpl-'));
    fs.rmSync(dir, { recursive: true });
    try {
      const r = newEngine(dir, { name: 'My drummer', id: 'My Drummer!', license: 'Apache-2.0', homepage: 'https://example.org/drummer' });
      expect(r.id).toBe('my-drummer');
      const src = fs.readFileSync(path.join(dir, 'engine.mjs'), 'utf8');
      expect(src).not.toMatch(/__[A-Z]+__/);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))).toMatchObject({ name: 'my-drummer', license: 'Apache-2.0' });
      const c = await runConformance({ command: process.execPath, args: [path.join(dir, 'engine.mjs')] });
      expect(c.checks.filter((x) => x.required && !x.ok)).toEqual([]);
      expect(c.cases[0].adherence).toBeGreaterThan(0.9);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('refuses a folder that is not empty', () => {
    expect(() => newEngine(os.tmpdir())).toThrow(/not empty/);
  });
});
