#!/usr/bin/env node
// The studio as a web server, for self-hosting (Docker, a NAS, a school server): the built app, the
// version endpoint, optional multiplayer rooms (OPENBAND_COLLAB=1) and the CSP — no stdio MCP.
// The AI bridge stays reachable only from the machine itself.
process.env.OPENBAND_STDIO = '0';
process.env.OPENBAND_OPEN_BROWSER ??= '0';
process.env.OPENBAND_HOST ??= '0.0.0.0';
process.env.OPENBAND_NO_UPDATE_CHECK ??= '1';
await import('./mcp-server.mjs');
