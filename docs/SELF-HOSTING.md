# Host your own OpenBand

🇬🇧 English · 🇮🇹 [Italiano](SELF-HOSTING.it.md) · [← README](../README.md)

The studio is a static app, so it runs anywhere — for a school, a community or just yourself:

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/iltempe/openband) [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/iltempe/openband)

- **GitHub Pages from your fork:** fork → *Settings → Pages → Source: GitHub Actions* → *Settings → Secrets and variables → Actions → Variables*: `OPENBAND_DEPLOY = true`. Forks don't deploy until you opt in.
- **Cloudflare Pages:** connect the repository with the *Vite* preset (build `npm run build`, output `dist`), or `wrangler pages deploy dist`.
- **Docker** (NAS, Raspberry Pi, a school server; amd64 and arm64): from a clone, `docker compose up -d --build` with the included `docker-compose.yml`, or `docker build -t openband . && docker run -p 8080:7777 openband` (multiplayer rooms on, healthcheck on `/version.json`).
- **Settings without rebuilding:** put a `config.json` next to `index.html` (or point `OPENBAND_CONFIG` to one in Docker) — instance name, default language, features to turn off (the in-browser chat, plugins, rooms), plugin catalog URL, collaboration server. See [`config.example.json`](../config.example.json).
- Every host gets the same headers: assets cached forever, the page and the service worker never, and a Content-Security-Policy (`server/csp.mjs`) that lets the page reach only the bridge on the user's computer, the Anthropic API, the plugin catalog and the collaboration servers. A static instance stores nothing: songs stay in each visitor's browser. Cross-origin isolation (COOP/COEP, for future `SharedArrayBuffer` use) is not enabled yet.

## Play together

- **On the same network** (fastest): start the MCP server with `OPENBAND_COLLAB=1` — it then also serves the studio and a room relay on your LAN address (printed at start; the AI bridge itself stays reachable only from this computer). Open a room with *On this network* and send the link.
- **Peer to peer**: *Peer to peer* connects the browsers directly with WebRTC; the link opens the online demo. Peers find each other through a signaling server: OpenBand's own (`/signal` on a server started with `OPENBAND_COLLAB=1`) or y-webrtc's public one, and you can pass your own with `?signal=wss://…` (it travels with the link). Public signaling servers come and go, so for reliable sessions over the internet run one you control.
- A password encrypts peer-to-peer traffic and separates rooms with the same name; send it apart from the link.

## claude.ai as a client (remote MCP)

A self-hosted OpenBand started with `OPENBAND_REMOTE_MCP=1` also speaks MCP over Streamable HTTP at `/mcp`, so it can be added in claude.ai under *Settings → Connectors → Add custom connector* (also from a phone):

```
claude.ai ──HTTPS · MCP──▶ https://music.example/mcp ──WebSocket──▶ the user's OpenBand tab
```

1. Run it: `docker run -p 8080:7777 -e OPENBAND_REMOTE_MCP=1 -e OPENBAND_REMOTE_TOKEN=<a long random string> openband` (the image built above), behind HTTPS (Caddy, nginx… forwarding the `Host` header).
2. In claude.ai add the connector `https://music.example/mcp?token=<the token>`.
3. Open the studio → **AI** → *Claude (remote)* tab: the tab shows a 6-digit code. Tell Claude “pair with OpenBand, code 395 337” (or add `&pair=<code>` to the connector URL).

<img src="remote-mcp.png" alt="The Claude (remote) tab with the connector URL and the pairing code" width="300">

The server is only a relay and stores nothing: songs stay in the tab. Each MCP session drives the one tab it paired with — other tabs, even on the same server, are invisible to it — and no tool works before pairing (`pair_studio`). Codes change every 10 minutes and are spent once used; 5 wrong codes per session per minute (30 across all sessions) block pairing for a minute; tool calls are rate-limited per session (60 every 10 s) and idle sessions end after 30 minutes. In this mode files are imported only from public http(s) URLs (never local paths, and never addresses of the server's own network), and exports have no `save_to`: the file downloads in the tab. Closing or reloading the tab ends the pairing. `OPENBAND_REMOTE_TOKEN` is optional but strongly advised on a public address: without it, anyone who knows the URL can open sessions (they still need a code from a tab).
