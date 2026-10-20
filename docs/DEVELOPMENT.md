# Developing OpenBand

🇬🇧 English · 🇮🇹 [Italiano](DEVELOPMENT.it.md) · [← README](../README.md)

```bash
git clone https://github.com/iltempe/openband.git
cd openband
npm install
npm run dev         # studio with hot reload
npm run typecheck   # TypeScript
npm test            # unit tests (Vitest, run in Node)
npm run build       # production build in dist/
node bin/openband.mjs mcp   # the MCP server from the checkout (or: claude mcp add openband -- node /path/to/openband/bin/openband.mjs mcp)
node scripts/smoke-pack.mjs # pack the package, install it in an empty folder and test it
npm run pack:mcpb           # build/openband-<version>.mcpb for Claude Desktop (then npm run smoke:mcpb)
npm run e2e                 # the built studio in Chrome: first run, PWA, self-hosting, remote MCP, automation
```

CI runs typecheck and tests on every push and pull request, plus the packaged builds (the package on 3 OSes × Node 18/20/22, the `.mcpb`), the e2e checks and a release dry run. Releases: see [RELEASING.md](RELEASING.md) — one tag builds the GitHub Release (the package and the Claude Desktop extension) and the demo at the same version. The roadmaps are specified in [SPEC.md](SPEC.md) (v0.2) and [SPEC-v0.3.md](SPEC-v0.3.md); design decisions are in [adr/](adr/); changes are listed in [CHANGELOG.md](../CHANGELOG.md).

To try your checkout from an MCP client: `claude mcp add openband -- node /path/to/openband/bin/openband.mjs mcp`.

## Code structure

```
src/
  types.ts, music.ts       data model, theory (notes, chords, drum map)
  store.ts                 state (zustand), undo/redo, autosave
  commands.ts              command API shared by the UI, MCP and the in-page chat (transactions, read-only set)
  migrations.ts            project schema versions (v1 → v3)
  bridge.ts, protocol.ts   WebSocket client to the local server, pairing, remote MCP tab
  ai/                      Claude in the browser: provider, agent loop, tools, keys, models
  audio/                   engine (live graph, meters, monitoring), render (offline, WAV), fx, WAM host,
                           samples, sampler, SoundFont, time-stretch, automation, worklets (LUFS)
  analysis/                pure DSP: FFT, loudness (BS.1770), spectrum, stereo, masking, key, harmony,
                           pitch tracking, reference matching, live loudness
  generate/                Surprise me, drummer, generated parts
  lint/, lyrics/           musical linter; syllables, alignment, prosody, ChordPro (pure)
  journal/                 journal, checkpoints, time machine (IndexedDB)
  collab/                  rooms (Yjs): binding, sessions, shared versions and comments
  interop/dawproject/      DAWproject import and export
  structure.ts, takes.ts, flubs.ts, punch.ts, loops.ts, automation.ts, …   one feature each
  workers/                 analysis and time-stretch off the main thread
  components/              the UI (Toolbar, Arrangement, Editor, Mixer, Library, AIPanel…)
server/
  mcp-server.mjs           MCP server (stdio) + WebSocket bridge + static files; tools.mjs defines the tools
  remote.mjs, pairing.mjs  remote MCP over HTTP, pairing codes
  setup.mjs, doctor.mjs, clients.mjs, update.mjs, package.mjs   the CLI (setup, doctor, update notices, install source)
  collab.mjs, csp.mjs, http.mjs   LAN rooms and signaling, security headers, static server
bin/openband.mjs           the `openband` command
scripts/                   linter CLI, .mcpb build and smoke tests, release notes, e2e (puppeteer), loop library
```
