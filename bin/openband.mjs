#!/usr/bin/env node
// openband — the OpenBand studio and its MCP server, with nothing to clone or build. Installed from the
// GitHub Release (see server/package.mjs for why not `npx openband`):
//
//   npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz [command]
//
//   (no command)  open the studio in the browser (server on 127.0.0.1:7777, or the next free port)
//   mcp           MCP server over stdio, for Claude Desktop / Claude Code / Cursor / VS Code
//   setup         add OpenBand to the MCP clients installed on this computer
//   doctor        check that everything is in place
//   --version
//
// Only syntax every Node version understands is used before the version check below.
var major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error('OpenBand needs Node 18 or newer (you have ' + process.versions.node + ').');
  console.error('Download it from https://nodejs.org, or use the Claude Desktop extension (.mcpb), which needs nothing installed.');
  process.exit(1);
}

const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const path = await import('node:path');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const [cmd = 'start', ...rest] = process.argv.slice(2);

const HELP = `OpenBand ${pkg.version} — a music studio in the browser that AI can play.

Usage:
  openband [start]     open the studio in your browser
  openband mcp         run the MCP server (stdio) for an AI client
  openband setup       add OpenBand to Claude Desktop, Claude Code, Cursor or VS Code
  openband doctor      check Node, ports, the build and your MCP clients
  openband omep-conformance -- <engine command>   check an Open Music Engine Profile engine
  openband omep-new <folder> [--id] [--name]       start a new OMEP engine from the template
  openband omep-mock   run the reference mock engine (MCP over stdio)
  openband --version

Environment: OPENBAND_PORT (default 7777, or the next free one), OPENBAND_OPEN_BROWSER=0,
OPENBAND_COLLAB=1 (multiplayer rooms on your network).`;

switch (cmd) {
  case '-v':
  case '--version':
  case 'version':
    console.log(pkg.version);
    break;
  case '-h':
  case '--help':
  case 'help':
    console.log(HELP);
    break;
  case 'start':
    process.env.OPENBAND_STDIO = '0';
    await import('../server/mcp-server.mjs');
    break;
  case 'mcp':
    await import('../server/mcp-server.mjs');
    break;
  case 'setup':
    await (await import('../server/setup.mjs')).setup(rest);
    break;
  case 'omep-new': {
    process.argv = [process.argv[0], fileURLToPath(new URL('../omep/new-engine.mjs', import.meta.url)), ...rest];
    await import('../omep/new-engine.mjs');
    break;
  }
  case 'omep-conformance':
    // Check an OMEP engine: openband omep-conformance -- <command> [args…]
    process.argv = [process.argv[0], fileURLToPath(new URL('../omep/conformance.mjs', import.meta.url)), ...rest];
    await import('../omep/conformance.mjs');
    break;
  case 'omep-mock':
    await import('../omep/mock-engine.mjs');
    break;
  case 'doctor':
    process.exitCode = await (await import('../server/doctor.mjs')).doctor(rest);
    break;
  default:
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    process.exit(2);
}
