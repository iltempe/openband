// How people install OpenBand, as shown in the app: from the latest GitHub Release (the npm name
// "openband" is not OpenBand's). Same values as server/package.mjs (tested).
export const PACKAGE_SPEC = 'https://github.com/iltempe/openband/releases/latest/download/openband.tgz';
// npm 12 refuses tarball URLs unless allowed; older npm ignores the flag.
export const NPX_ARGS = ['-y', '--allow-remote=all'];
export const RUN = `npx ${NPX_ARGS.join(' ')} ${PACKAGE_SPEC}`;
export const MCP_COMMAND = `${RUN} mcp`;
export const CLAUDE_CODE_ADD = `claude mcp add openband -- ${MCP_COMMAND}`;
export const CODEX_ADD = `codex mcp add openband -- ${MCP_COMMAND}`;
export const MCP_JSON = `{
  "mcpServers": {
    "openband": { "command": "npx", "args": ["-y", "--allow-remote=all", "${PACKAGE_SPEC}", "mcp"] }
  }
}`;
export const MCPB_URL = 'https://github.com/iltempe/openband/releases/latest/download/openband.mcpb';
