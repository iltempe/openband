// Tool levels over MCP (SPEC v0.6 §8.1, §8.4): by default every tool, as before; with --toolsets=core the
// core and capability tools, and load_toolset brings a toolset with a tools/list_changed notification.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { CAPABILITY, CORE, TOOLS, TOOLSETS } from './tools.mjs';

const server = path.join(__dirname, 'mcp-server.mjs');
let port = 7840;

async function connect(args: string[]) {
  const c = new Client({ name: 'toolsets-test', version: '1.0.0' });
  const changed: number[] = [];
  c.setNotificationHandler(ToolListChangedNotificationSchema, async () => void changed.push(Date.now()));
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [server, ...args], env: { ...process.env, OPENBAND_PORT: String(port++), OPENBAND_OPEN_BROWSER: '0', OPENBAND_NO_UPDATE_CHECK: '1' } as Record<string, string>, stderr: 'ignore' }));
  return { c, changed };
}

describe('tool levels over MCP', () => {
  it('by default a client gets every tool, as before', async () => {
    const { c } = await connect([]);
    try {
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(TOOLS.map((t) => t.name)));
      const r = await c.callTool({ name: 'load_toolset', arguments: { name: 'lyrics' } });
      expect(JSON.stringify(r.content)).toMatch(/already available/);
    } finally {
      await c.close();
    }
  }, 30000);

  it('--toolsets=core: core + capability first; load_toolset adds a toolset and says so (list_changed)', async () => {
    const { c, changed } = await connect(['--toolsets=core']);
    try {
      const first = (await c.listTools()).tools.map((t) => t.name);
      expect(first.filter((n) => n !== 'open_studio').sort()).toEqual([...CORE, ...CAPABILITY].sort());
      // §8.1: ~20 core + ~8 capability (create, transform, separate, sing…), plus open_studio.
      expect(first.length).toBeLessThanOrEqual(34);
      await c.callTool({ name: 'load_toolset', arguments: { name: 'lyrics' } });
      await new Promise((r) => setTimeout(r, 200));
      expect(changed.length).toBeGreaterThan(0);
      const after = (await c.listTools()).tools.map((t) => t.name);
      expect(after).toEqual(expect.arrayContaining(TOOLSETS.lyrics.tools));
      expect(after).not.toContain('set_plugin_params');
      await c.callTool({ name: 'load_toolset', arguments: { name: 'all' } });
      expect((await c.listTools()).tools.length).toBe(TOOLS.length + 1); // + open_studio
    } finally {
      await c.close();
    }
  }, 30000);
});

describe('prompts, the song context resource, tasks (§8.1, §8.3)', () => {
  it('lists the flows as prompts and the context as resources; long tools can run as tasks', async () => {
    const { c } = await connect([]);
    try {
      const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
      expect(prompts).toEqual(expect.arrayContaining(['loop_to_song', 'prepare_release', 'vocal_session']));
      const msg = await c.getPrompt({ name: 'loop_to_song', arguments: { minutes: '3:30', shape: 'slow_build' } });
      expect(JSON.stringify(msg.messages)).toMatch(/set_energy_curve.*slow_build.*arrange_from_energy/);
      const resources = (await c.listResources()).resources.map((r) => r.uri);
      expect(resources).toEqual(expect.arrayContaining(['openband://project', 'openband://context/song']));
      const templates = (await c.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate);
      expect(templates).toEqual(expect.arrayContaining(['openband://context/section/{id}', 'openband://context/bars/{range}']));
      const tools = (await c.listTools()).tools;
      expect(tools.find((t) => t.name === 'create')?.execution?.taskSupport).toBe('optional');
      expect(c.getServerCapabilities()?.tasks).toBeTruthy();
    } finally {
      await c.close();
    }
  }, 30000);
});
