// Where OpenBand is installed from. The npm name "openband" is held by someone else (a "reserved" 0.0.0
// package), so `npx openband` would run a stranger's code: until OpenBand has an npm name of its own,
// everything installs straight from this repository on GitHub (built on install by scripts/prepare.mjs).
// One place to change it — the app keeps the same string in src/install.ts (a test checks they match).
export const PACKAGE_SPEC = 'github:iltempe/openband';
/** The command people type. */
export const RUN = `npx -y ${PACKAGE_SPEC}`;
/** The entry every MCP client gets: no absolute paths. */
export const SERVER_ENTRY = { command: 'npx', args: ['-y', PACKAGE_SPEC, 'mcp'] };
/** GitHub repository (releases: update notices, the Claude Desktop extension). */
export const REPO = 'iltempe/openband';
