// Hermes Agent (issue #7): OpenBand added to ~/.hermes/config.yaml under mcp_servers, whatever is there.
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain ESM module
import { hermesClient, readHermesEntry, writeHermesEntry } from './clients.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-hermes-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const entry = { command: 'npx', args: ['-y', '--allow-remote=all', 'https://github.com/iltempe/openband/releases/download/v0.6.35/openband.tgz', 'mcp'] };
let n = 0;
const client = (text?: string) => {
  const c = hermesClient({ HERMES_HOME: path.join(dir, `h${n++}`) });
  if (text !== undefined) {
    fs.mkdirSync(c.dir, { recursive: true });
    fs.writeFileSync(c.file, text);
  }
  return c;
};
// A real YAML parser (Ruby's, where there is one) reads what we wrote.
const ruby = spawnSync('ruby', ['-v']).status === 0;
const parse = (file: string) => JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0]))', file], { encoding: 'utf8' }));

describe('Hermes Agent', () => {
  it('lives in HERMES_HOME or ~/.hermes', () => {
    expect(hermesClient({ HERMES_HOME: '/x/h' }).file).toBe(path.join('/x/h', 'config.yaml'));
    expect(hermesClient({}).file).toBe(path.join(os.homedir(), '.hermes', 'config.yaml'));
  });
  it('a new config: mcp_servers with OpenBand', () => {
    const c = client();
    expect(writeHermesEntry(c, entry)).toEqual({ changed: true, backup: null });
    expect(readHermesEntry(c.file)).toEqual(entry);
    if (ruby) expect(parse(c.file)).toEqual({ mcp_servers: { openband: entry } });
  });
  it('keeps the rest of the file and the other servers, at their indent', () => {
    const c = client('model:\n  provider: nous\n\nmcp_servers:\n    filesystem:\n        command: "npx"\n        args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/u"]\n\nmemory:\n  enabled: true\n');
    const r = writeHermesEntry(c, entry);
    expect(r.changed).toBe(true);
    expect(fs.readFileSync(r.backup, 'utf8')).toContain('filesystem');
    if (ruby) {
      const y = parse(c.file);
      expect(y.model).toEqual({ provider: 'nous' });
      expect(y.memory).toEqual({ enabled: true });
      expect(y.mcp_servers.filesystem.command).toBe('npx');
      expect(y.mcp_servers.openband).toEqual(entry);
    }
    expect(readHermesEntry(c.file)).toEqual(entry);
  });
  it('replaces an older OpenBand entry, and twice is no change', () => {
    const c = client('mcp_servers:\n  openband:\n    command: "node"\n    args: ["old.mjs"]\n  other:\n    url: "https://x"\n');
    writeHermesEntry(c, entry);
    expect(readHermesEntry(c.file)).toEqual(entry);
    expect(fs.readFileSync(c.file, 'utf8')).not.toContain('old.mjs');
    if (ruby) expect(parse(c.file).mcp_servers.other).toEqual({ url: 'https://x' });
    expect(writeHermesEntry(c, entry)).toEqual({ changed: false });
  });
  it('an empty inline map becomes a block; a full inline one is left to the user', () => {
    const c = client('mcp_servers: {}\n');
    writeHermesEntry(c, entry);
    if (ruby) expect(parse(c.file)).toEqual({ mcp_servers: { openband: entry } });
    expect(() => writeHermesEntry(client('mcp_servers: { a: { url: "x" } }\n'), entry)).toThrow(/by hand/);
  });
  it('Windows paths and env survive', () => {
    const c = client();
    const e = { command: 'C:\\Program Files\\OpenBand\\OpenBand.exe', args: ['C:\\x\\server\\mcp-server.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };
    writeHermesEntry(c, e);
    expect(readHermesEntry(c.file)).toEqual(e);
    if (ruby) expect(parse(c.file).mcp_servers.openband).toEqual(e);
  });
});
