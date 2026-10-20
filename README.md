# OpenBand

🇬🇧 English · 🇮🇹 [Italiano](README.it.md)

**An open-source, GarageBand-style music studio that runs in your browser — and that your AI can play too, through the Model Context Protocol (MCP).**

![OpenBand playing a song](docs/demo.gif)

Ask Claude *“make a lo-fi beat at 82 BPM in D minor with drums, bass and Rhodes, then loop it”* and watch the tracks, notes and mixer move in real time. Or just play: tracks, piano roll, step sequencer, 15 synthesized instruments, mixer, effects, plugins, microphone recording.

## Get started

Pick the way that suits you. None of them needs a clone or a build.

| | You have | Do this |
|---|---|---|
| 🎹 **Just try it** | a browser | Open the **[live demo](https://iltempe.github.io/openband/)** and press **🎲 Surprise me** |
| 🖥 **Desktop app** | macOS, Windows or Linux | **[Download it](docs/DESKTOP.md#download)**: the studio in its own window, connected to Claude in one click |
| 🤖 **Claude Desktop** | Claude Desktop | **[⬇ Download openband.mcpb](https://github.com/iltempe/openband/releases/latest/download/openband.mcpb)**, double-click it, choose *Install* |
| 💻 **Claude Code, Cursor, VS Code** | [Node 18+](https://nodejs.org) | Run the command below |
| 🔑 **An Anthropic API key** | a browser | [Demo](https://iltempe.github.io/openband/) → **AI** panel → *API key* tab |

**The command** (Claude Code, Cursor, VS Code, or Claude Desktop without the extension) — it finds the AI clients on your computer and adds OpenBand to them, asking first and keeping a backup of each file it changes:

```bash
npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz setup
```

Then restart your AI client and ask it for a song: the studio opens in your browser by itself. Prefer to do it by hand? For Claude Code it is `claude mcp add openband -- npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz mcp`; the JSON for other clients is in [docs/CONNECT.md](docs/CONNECT.md). The same command without `setup` just opens the studio, and with `doctor` checks that everything is in place.

> **Why not `npx openband`?** The npm name `openband` belongs to someone else, so OpenBand is installed from its GitHub Releases. `--allow-remote=all` lets npm 12 (Node 26) download a package from a URL; older npm versions ignore it.

**With an API key** Claude runs inside the page and plays the studio with the same tools it gets over MCP. The key stays in your browser and requests go straight to Anthropic; the cost of each answer is shown.

## Your first song

1. **Start from music.** On the first screen press **🎲 Surprise me** (an 8-bar loop with drums and bass, no AI needed), **🎤 Hum an idea** (sing 4 bars, get a melody with chords and a beat) or pick one of 8 *Example songs*. A 5-step tour shows you around, and `?` lists every shortcut.
2. **Ask your AI.** Try:
   > Make a lo-fi beat at 82 BPM in D minor with drums, bass and Rhodes, then start the loop.

   > Add a warm tube overdrive to the bass and a wide reverb to the pad, then open the overdrive so I can tweak it.

   > Give me 4 bass lines as takes and start a blind test.
3. **Change anything by hand.** Drag regions, edit notes in the piano roll (**E**), mix (**X**), add effects (**F**). Everything the AI did for one request is a single undo step.
4. **Keep it.** Your songs are saved in the browser as you go. Export a **WAV**, a **MIDI** file, a `.dawproject` for Bitwig, Studio One or Cubase, or a `.openband` file with your sounds inside.

<img src="docs/welcome.png" alt="Welcome screen: Surprise me, Hum an idea, Ask the AI, Open a file" width="640">

## What it does

- **A complete small studio**: instrument, drum and audio tracks, piano roll, step sequencer, mixer with sends, effects (amp, EQ, compressor), automation of any parameter, open-standard [WAM](https://www.webaudiomodules.com) plugins, your own samples and SoundFonts, MIDI controllers and musical typing.
- **The AI plays, listens and explains**: 129 MCP tools to compose, arrange, mix and export; `analyze_mix` measures loudness, balance and masking and suggests fixes; *Explain* pins comments to the song; a drummer that follows your sections.
- **Jam with the AI**: play a phrase and it answers on the next bar, as ghost notes you can keep.
- **Record like a studio**: microphone or interface, several inputs at once, punch-in with pre-roll, takes and comping, blind A/B tests, flub markers, hum-to-MIDI.
- **Never lose work**: versions and branches like git for songs (with merge and a compare view), a 30-day time machine and crash recovery.
- **Play together**: share a link and edit the same song live, with the AI as the third musician.
- **Works offline** once installed as an app (Chrome/Edge: *Install OpenBand*; Safari: *Add to Dock*), in English and Italian.

**→ [All the features](docs/FEATURES.md)** · [all the MCP tools](docs/MCP-TOOLS.md)

| Arrangement and mixer | Chat with Claude in the page | Versions and compare view |
|---|---|---|
| ![Mixer with effects on two tracks](docs/mixer.png) | ![Chatting with Claude inside the studio](docs/chat.png) | ![Versions panel with branches and the compare view](docs/versions.png) |
| **Piano roll** | **What the AI hears** | **Loops and drummer** |
| ![Piano roll](docs/editor.png) | ![Analysis panel](docs/analysis.png) | ![Loops tab, a drummer part and loops in the song](docs/loops.png) |

## Shortcuts

| Key | Action |
|---|---|
| Space / Enter | Play/Stop · Back to start |
| R · C · M | Record · Cycle · Metronome |
| K | Musical typing (Esc to close) |
| Y · B · E · X · F · N | Library · Smart Controls · Editor · Mixer · Effects · Analysis |
| ⌘Z / ⇧⌘Z | Undo / Redo |
| ? | All keyboard shortcuts |

## More

- **[Desktop app](docs/DESKTOP.md)**: downloads, first opening, connecting your AI apps, building it.
- **[Connect an AI](docs/CONNECT.md)**: how it works, every client, pairing the online demo with your computer, environment variables, troubleshooting.
- **[Host your own](docs/SELF-HOSTING.md)**: Netlify, Vercel, Cloudflare, GitHub Pages, Docker; rooms on your network; OpenBand as a claude.ai connector (also from your phone).
- **[Development](docs/DEVELOPMENT.md)**: build from source, tests, code structure. Changes: [CHANGELOG.md](CHANGELOG.md).
- Something wrong? In the studio, *⋯ → Diagnostics → Report a problem* opens a pre-filled issue (nothing from your songs, never your keys).

OpenBand is a *clean-room* implementation: it reproduces the workflow of a consumer DAW with code and sounds written from scratch, and contains no Apple code, samples, loops or artwork — every instrument is synthesized in real time. Contributions are welcome: open an issue or a pull request. If you like the project, a ⭐ helps others find it.

## License

MIT. “GarageBand” is a trademark of Apple Inc.; OpenBand is an independent project, not affiliated with or endorsed by Apple.
