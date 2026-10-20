# Connect an AI to OpenBand

🇬🇧 English · 🇮🇹 [Italiano](CONNECT.it.md) · [← README](../README.md)

```
AI client (Claude Desktop, Claude Code, Cursor…)
        │  stdio · MCP
        ▼
server/mcp-server.mjs ──── WebSocket ws://127.0.0.1:7777/bridge ────▶ OpenBand in the browser
```

The client launches the MCP server, which forwards every call to the open OpenBand window. Each command received shows up in the app's **AI** panel (the “MCP” button, top right).

**Claude Code**:

```bash
claude mcp add openband -- npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz mcp
```

**Claude Desktop, Cursor, VS Code…** — or run `npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz setup`. Claude Desktop keeps the file in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "openband": { "command": "npx", "args": ["-y", "--allow-remote=all", "https://github.com/iltempe/openband/releases/latest/download/openband.tgz", "mcp"] }
  }
}
```

No paths to edit: `npx` fetches the package from the latest GitHub Release, with the studio already built (`setup` writes the URL of the exact release you run). `--allow-remote=all` lets npm 12 (Node 26) download a package from a URL; older npm versions ignore it. The first tool call opens the studio in your browser by itself.

Then ask, for example:

> Make a lo-fi beat at 82 BPM in D minor with drums, bass and Rhodes, then start the loop.

> Add a warm tube overdrive to the bass and a wide reverb to the pad, then open the overdrive so I can tweak it.

> Import ~/Samples/vocal.wav as an audio track at bar 5, put a compressor on the bass, fade the pad in over two bars and save the song as ~/Desktop/song.wav and song.mid.

Environment variables: `OPENBAND_REMOTE_MCP=1` and `OPENBAND_REMOTE_TOKEN` (remote MCP at `/mcp`, see [self-hosting](SELF-HOSTING.md#claudeai-as-a-client-remote-mcp)), `OPENBAND_PORT` (default 7777; when it is taken the next free port is used and the studio opens with `?mcp=<port>`), `OPENBAND_OPEN_BROWSER=0` (don't open the browser), `OPENBAND_COLLAB=1` (multiplayer rooms on your network), `OPENBAND_NO_UPDATE_CHECK=1` (don't check GitHub once a day for a newer OpenBand) and `OPENBAND_DEV_URL` (default `http://localhost:5173`, used when there is no build). Trouble? `npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz doctor` checks Node, the port (and who is using it), the build, the packages and your MCP clients, with a fix for each ✗. In the studio, *⋯ → Diagnostics* shows audio, bridge, permissions, storage, plugins and recent errors, and *Report a problem* opens a pre-filled GitHub issue — without anything from your songs and never your keys — that you read before posting.

**From the online demo.** The demo can drive the OpenBand server on your computer too: open the **AI** panel, install the extension (or run `npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz mcp`), and type the 6-digit **pairing code** that Claude gives you when you ask it to open the studio (the server also prints it when it starts). The tab gets a session token, so reloading doesn't ask again; restarting the server revokes it. Your browser may ask to let the site access your local network — that is how the page reaches `127.0.0.1`: choose *Allow*. If your browser refuses, *Open the local studio* takes the song you have open to the studio served on your computer.

<img src="connect-ai.png" alt="Connect AI wizard on the online demo" width="300">

The bridge only accepts connections over loopback: from pages served on localhost (no code needed) and from the sites in `OPENBAND_ALLOWED_ORIGINS` (default `https://iltempe.github.io`), which must pair first — 5 wrong codes in a minute lock pairing for 5 minutes, codes expire after 10 minutes.

claude.ai on the web and on phones can connect to a self-hosted OpenBand: see [remote MCP](SELF-HOSTING.md#claudeai-as-a-client-remote-mcp). Every tool: [MCP-TOOLS.md](MCP-TOOLS.md).
