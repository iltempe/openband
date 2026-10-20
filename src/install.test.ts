import { describe, expect, it } from 'vitest';
import * as app from './install';
import * as server from '../server/package.mjs';

describe('install commands', () => {
  it('the app and the server agree on where OpenBand comes from — never the npm name "openband"', () => {
    expect(app.PACKAGE_SPEC).toBe(server.PACKAGE_SPEC);
    expect(app.RUN).toBe(server.RUN);
    expect(app.NPX_ARGS).toEqual(server.NPX_ARGS);
    // The app shows the latest release; setup pins the running version's release (both ours).
    const shown = JSON.parse(app.MCP_JSON).mcpServers.openband;
    expect(shown.args).toEqual([...server.NPX_ARGS, server.PACKAGE_SPEC, 'mcp']);
    expect(server.SERVER_ENTRY.args.slice(0, 2)).toEqual(server.NPX_ARGS);
    expect(server.isOurPackage(server.SERVER_ENTRY.args[2])).toBe(true);
    expect(server.SERVER_ENTRY.args[2]).toMatch(/releases\/download\/v\d+\.\d+\.\d+\/openband-\d+\.\d+\.\d+\.tgz$/);
    for (const s of [app.RUN, app.MCP_COMMAND, app.CLAUDE_CODE_ADD, app.MCP_JSON]) expect(s).not.toMatch(/npx (-y )?openband\b|"openband", "mcp"/);
  });
});
