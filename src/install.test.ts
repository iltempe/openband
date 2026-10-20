import { describe, expect, it } from 'vitest';
import * as app from './install';
import * as server from '../server/package.mjs';

describe('install commands', () => {
  it('the app and the server agree on where OpenBand comes from — never the npm name "openband"', () => {
    expect(app.PACKAGE_SPEC).toBe(server.PACKAGE_SPEC);
    expect(app.RUN).toBe(server.RUN);
    expect(JSON.parse(app.MCP_JSON).mcpServers.openband).toEqual(server.SERVER_ENTRY);
    for (const s of [app.RUN, app.MCP_COMMAND, app.CLAUDE_CODE_ADD, app.MCP_JSON]) expect(s).not.toMatch(/npx (-y )?openband\b|"openband", "mcp"/);
  });
});
