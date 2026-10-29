# Use OpenBand with any AI

🇬🇧 English · 🇮🇹 [Italiano](AI-MODELS.it.md) · [← README](../README.md)

OpenBand is not tied to one AI. The studio speaks the open [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) to AI apps, and its chat in the page can run Claude, OpenAI's models, Gemini, or a model on your
own computer with Ollama. Every AI gets the same 180 tools (175 in the page, where there are no files or
event stream).

**Tools in levels**, so small and local models aren't swamped: the chat in the page starts every
conversation with the **29 core and capability tools** (the song, tracks, regions and notes, transport,
undo, structure, and one tool per kind of musical job: `create`, `transform`, `suggest_continuation`, `mix_pilot`,
`arrange_from_energy`, `export_for_platforms`, `set_jam_mode`), adds the toolsets your words obviously
need (*"mix it"* → mix, *"le parole"* → lyrics), and the model loads any other with `load_toolset`
(editing, structure, mix, analysis, recording, versions, lyrics, plugins, sounds, files, collab, jam,
engines) — it appears on its next turn. AI apps over MCP get every tool, as before; start the server with
`--toolsets=core` (or `OPENBAND_TOOLSETS=core`) for the levels there too: the client is told when tools
are added (`tools/list_changed`).

| AI | In the page (your key) | AI app on your computer (MCP) | On the web (remote MCP) |
|---|---|---|---|
| **Claude** | ✓ Anthropic key | Claude Desktop, Claude Code | claude.ai |
| **OpenAI / ChatGPT** | ✓ OpenAI key (GPT-6.x) | Codex (CLI and IDE) | ChatGPT developer mode¹ |
| **Gemini** | ✓ Gemini key | Gemini CLI | — |
| **Ollama, LM Studio…** | ✓ no key, on your computer | Hermes Agent (with any model, also local) | — |
| **Others** | any OpenAI-compatible server | Cursor, VS Code, any MCP client | any client of remote MCP servers |

¹ Not tested yet with ChatGPT: it is the same remote MCP server claude.ai uses, so it should work;
[tell us](https://github.com/iltempe/openband/issues) if it doesn't.

## In the page: pick an AI

<img src="ai-models.png" alt="The AI model tab with Ollama selected" width="300">

Open the studio ([online demo](https://iltempe.github.io/openband/), the desktop app, or `npx`) →
**AI** panel → **AI model** tab. Choose the AI, the model, paste your key (none for Ollama) and chat:
the AI plays the studio with the same tools it gets over MCP, each request is one undo step, the
estimated cost of each answer is shown and *Stop* is always there.

- **Keys** stay in your browser's storage, never in songs or exports; requests go from your browser
  straight to the provider. *Forget key* deletes the key, *Change AI* switches to another one (the
  conversation then starts again: one AI can't read another's messages).
- **OpenAI** uses the Responses API (`api.openai.com`), with nothing stored on OpenAI's side
  (`store: false`). Get a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
- **Gemini** uses Google's OpenAI-compatible endpoint (`generativelanguage.googleapis.com/v1beta/openai`).
  Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
- **Prices** shown are list prices of October 2026 (Gemini's are introductory and double in 2027);
  they are estimates, your provider's bill is what counts.

### A model on your computer: Ollama

1. Install [Ollama](https://ollama.com) and download a model that can use tools, for example
   `ollama pull qwen3` (others: `llama3.1`, `mistral-small`, `gpt-oss`).
2. Give it room for OpenBand's tools (about 8,000 tokens): start Ollama with a larger context, e.g.
   `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`.
3. In the **AI model** tab choose *Ollama*, press *Find models*, pick one, *Use this AI*.

From the **desktop app** or a studio started on your computer (`npx …`, `http://127.0.0.1:7777`) that
is all. From the **online demo**, Ollama must also allow the page: start it with
`OLLAMA_ORIGINS=https://iltempe.github.io` (on macOS: `launchctl setenv OLLAMA_ORIGINS https://iltempe.github.io`
and restart Ollama), and when the browser asks to let the site reach your local network, choose *Allow*.

Small local models are free and private but struggle with a long list of tools: expect simpler songs and
more retries than with the large hosted models.

**Other servers**: choose *Other OpenAI-compatible server* and give its address — LM Studio
(`http://localhost:1234/v1`), vLLM, llama.cpp's server, or a hosted service such as OpenRouter
(`https://openrouter.ai/api/v1`, with its key). On a self-hosted OpenBand with a Content-Security-Policy,
hosted services other than Anthropic, OpenAI and Google must be added to `connect-src` (`server/csp.mjs`).

## AI apps on your computer (MCP)

`npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz setup`
(or, in the desktop app, *AI apps → Add OpenBand to my AI apps*) finds and configures Claude Desktop,
Claude Code, **Codex**, **Gemini CLI**, **Hermes Agent**, Cursor and VS Code. By hand:

**Codex** (OpenAI's CLI and IDE extension), `~/.codex/config.toml`:

```toml
[mcp_servers.openband]
command = "npx"
args = ["-y", "--allow-remote=all", "https://github.com/iltempe/openband/releases/latest/download/openband.tgz", "mcp"]
```

or `codex mcp add openband -- npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz mcp`.

**Gemini CLI**, `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "openband": { "command": "npx", "args": ["-y", "--allow-remote=all", "https://github.com/iltempe/openband/releases/latest/download/openband.tgz", "mcp"] }
  }
}
```

**Hermes Agent** (Nous Research), `~/.hermes/config.yaml` (or `$HERMES_HOME/config.yaml`), then
`/reload-mcp` in a Hermes chat:

```yaml
mcp_servers:
  openband:
    command: "npx"
    args: ["-y", "--allow-remote=all", "https://github.com/iltempe/openband/releases/latest/download/openband.tgz", "mcp"]
```

Then ask: *“make a lo-fi beat at 82 BPM in D minor with drums, bass and Rhodes, then loop it”*. The first
tool call opens the studio in your browser (or in the desktop app). More in [CONNECT.md](CONNECT.md).

## On the web: claude.ai and ChatGPT (remote MCP)

A self-hosted OpenBand started with `OPENBAND_REMOTE_MCP=1` serves MCP over HTTPS at `/mcp`
([how](SELF-HOSTING.md#claudeai-as-a-client-remote-mcp)). Add `https://your-host/mcp?token=<token>`:

- in **claude.ai**: *Settings → Connectors → Add custom connector*;
- in **ChatGPT**: turn on *Developer mode* (Settings → Apps / Connectors → Advanced; Plus, Pro, Business,
  Enterprise and Edu plans) and create a connector with that URL and no authentication.

Then open the studio → **AI** → *claude.ai, ChatGPT* tab and tell the AI the 6-digit code it shows.
