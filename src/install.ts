// How people install OpenBand, as shown in the app. Same values as server/package.mjs (tested).
export const PACKAGE_SPEC = 'github:iltempe/openband';
export const RUN = `npx -y ${PACKAGE_SPEC}`;
export const MCP_COMMAND = `${RUN} mcp`;
export const CLAUDE_CODE_ADD = `claude mcp add openband -- ${MCP_COMMAND}`;
export const MCP_JSON = `{
  "mcpServers": {
    "openband": { "command": "npx", "args": ["-y", "${PACKAGE_SPEC}", "mcp"] }
  }
}`;
export const MCPB_URL = 'https://github.com/iltempe/openband/releases/latest/download/openband.mcpb';
