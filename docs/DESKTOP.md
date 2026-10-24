# OpenBand desktop app

🇬🇧 English · 🇮🇹 [Italiano](DESKTOP.it.md) · [← README](../README.md)

The same studio as the [online demo](https://iltempe.github.io/openband/), in its own window, for macOS,
Windows and Linux, with the MCP server built in: no browser, no Node, no commands.

<img src="desktop.png" alt="The desktop app with the AI apps tab" width="720">

## Download

| System | File |
|---|---|
| macOS, Apple Silicon (M1 and later) | [OpenBand-mac-arm64.dmg](https://github.com/iltempe/openband/releases/latest/download/OpenBand-mac-arm64.dmg) |
| macOS, Intel | [OpenBand-mac-x64.dmg](https://github.com/iltempe/openband/releases/latest/download/OpenBand-mac-x64.dmg) |
| Windows 10 and 11 (x64) | [OpenBand-win-x64.exe](https://github.com/iltempe/openband/releases/latest/download/OpenBand-win-x64.exe) |
| Windows on ARM | [OpenBand-win-arm64.exe](https://github.com/iltempe/openband/releases/latest/download/OpenBand-win-arm64.exe) |
| Linux (Ubuntu, Debian…) | [OpenBand-linux-amd64.deb](https://github.com/iltempe/openband/releases/latest/download/OpenBand-linux-amd64.deb) · [AppImage](https://github.com/iltempe/openband/releases/latest/download/OpenBand-linux-x86_64.AppImage) (also `arm64`) |

All files are on the [releases page](https://github.com/iltempe/openband/releases/latest).

## Opening it the first time

The app is not signed yet (signing costs a yearly fee to Apple and a certificate for Windows), so the
system asks you to confirm once:

- **macOS**: open the `.dmg` and drag OpenBand to *Applications* (the disk image also holds these steps,
  in *If it won't open*). Double-click OpenBand: macOS says *“OpenBand.app” was not opened… Apple could
  not verify…* — press *Done*. Then *System Settings → Privacy & Security*, scroll down to *“OpenBand.app”
  was blocked* and press **Open Anyway**, confirming with your password. From then on it opens normally.
  (On macOS 15 and later right-click → *Open* no longer skips this.) The same in one Terminal command:
  `xattr -dr com.apple.quarantine /Applications/OpenBand.app`. The app is not broken: macOS blocks any
  downloaded app that isn't notarized by Apple, which needs a paid developer account.
- **Windows**: run the installer; if SmartScreen says *Windows protected your PC*, click *More info* →
  *Run anyway*.
- **Linux**: `sudo apt install ./OpenBand-linux-amd64.deb`, or make the AppImage executable
  (`chmod +x OpenBand-*.AppImage`) and run it. On Ubuntu 24.04 and later the AppImage may not start
  because of AppArmor's sandbox rules: use the `.deb`, or start it with `--no-sandbox`.

## Connect your AI

Open the **AI** panel → **AI apps** → *Add OpenBand to my AI apps* (or *File → Connect to Claude and
other AI apps…*). The app adds itself to Claude Desktop, Claude Code, Cursor and VS Code where it finds
them, keeping a backup of each file it changes. Restart Claude Desktop and ask for a song: the studio
opens in the app.

How it works: the AI app starts OpenBand's executable in Node mode on the MCP server inside the app
(`server/mcp-server.mjs`, the same one as `npx` and the `.mcpb`), and when that server needs the studio
it opens the app instead of a browser. On macOS, move the app to *Applications* before connecting: AI
apps remember where it is. Use either the app or the Claude Desktop extension (`.mcpb`), not both: they
would both add the OpenBand tools.

## What's different from the browser

- **Files**: `.openband`, `.mid` and `.dawproject` files open with a double-click, from *File → Open*
  (⌘O / Ctrl+O) and from *Open Recent*; saving and exporting ask where to put the file.
- **Menus**: *File* (new song, open, save, export WAV / MIDI / DAWproject, connect AI apps), *Edit*,
  *View*, *Window*, *Help*. The studio's shortcuts work as in the browser.
- **Songs** are kept in the app's own storage, separate from the browser's: to move a song between the
  two, save it as `.openband` and open it on the other side.
- **Updates**: the app checks GitHub for a new version once a day and offers the download (*Check for
  Updates…* in the menu). Installing over the old version keeps your songs.
- **Plugins**: the web plugins (WAM) work as in the browser. Native VST3 / CLAP / AU plugins are being
  built in phases ([SPEC v0.6, G8](SPEC-v0.6.md), [ADR 0001](adr/0001-desktop.md)); see
  [Native plugins](#native-plugins) below.

## Native plugins

**CLAP, VST3 and Audio Unit instruments and effects** installed on your computer work in the app: *Plugins* (in the library, or *+ Plugin* in a
track's effects) lists them under *Installed on this computer*, next to the web plugins. OpenBand looks in
the standard folders: CLAP in macOS `~/Library/Audio/Plug-Ins/CLAP` and `/Library/Audio/Plug-Ins/CLAP`, Windows
`Common Files\CLAP`, Linux `~/.clap`, `/usr/lib/clap`; VST3 in macOS `~/Library/Audio/Plug-Ins/VST3` and
`/Library/Audio/Plug-Ins/VST3`, Windows `Common Files\VST3`, Linux `~/.vst3`, `/usr/lib/vst3`. On a Mac, the Audio
Units are the ones the system knows (as in Logic or GarageBand), Apple's own included. Each folder is scanned plugin by plugin in a
separate process: one that hangs or crashes while being scanned is set aside (*Ignored*, with *Retry*).
Each plugin shows its format (CLAP, VST3, AU); a plugin installed in more than one format is listed once per
format — any of them works, and everything below holds for all of them.

![Installed CLAP and VST3 plugins in the plugin browser](native-plugins.png)

- **Each plugin runs in its own process** (`openband-plughost`): if it crashes, only it stops. The track
  keeps playing without it, in time, the slot says *Closed*, and **Restart** starts it again with the state
  saved in the song.
- **In time with everything else**: the audio goes to the plugin and back in blocks, about 16 ms plus the
  plugin's own latency, and OpenBand delays the other tracks by as much (plugin delay compensation), live
  and in exports. The slot shows the latency.
- **Instruments**: add one from *Plugins* (a new track, or the instrument track the browser was opened
  for); it plays the notes of the timeline, a MIDI keyboard and the AI's parts. **Edit** (or *Open plugin*
  in Smart Controls) shows its parameters, searchable, and **Open the plugin window** opens the plugin's own
  interface, floating above the studio (macOS and Windows; on Linux the parameters for now).
- **Automation** of any plugin parameter lands on its exact sample inside the audio block, and moving a
  control in the plugin's own window is recorded in Touch / Latch like any knob of the studio. Every change
  you make in the plugin's window is one undo step, and its settings are saved with the song.

![Vital, a CLAP synth, on a track: its parameters and its own window](native-instrument.png)

- Plugins are programs that run with your permissions: OpenBand says so before the first one, and only
  loads them from the plugin folders, never from the internet.
- **Exports** include native plugins: the export runs them in their offline mode, block by block through
  their host — two exports of the same song are identical to the bit, and sound like what you heard.
- **Songs travel**: when you save a song as `.openband`, each track that plays a native plugin keeps its
  audio "frozen" inside the file. Opened in the browser, in the online studio or on a computer without
  that plugin, the track plays the frozen audio (**❄ Frozen** next to its name) and you can still mix it;
  if you change its notes there, the badge says **Out of date** — open the song in the desktop app to freeze
  it again, or click the badge to choose another instrument.
- Coming next: native windows on Linux; Audio Units v3 that only run as app extensions are not tested yet.

## Building it

```bash
npm ci && npm ci --prefix desktop   # the app's build tools (Electron) live in desktop/
npm run build                       # the studio
npm run desktop:dev                 # run the app from the checkout ("OpenBand (dev)" profile)
npm run desktop:build               # installers for this system in build/desktop/ (--dir: unpacked only)
npm run desktop:smoke               # test the unpacked app: it plays, and an MCP client drives it
```

The *Release* workflow builds the installers on macOS, Windows and Linux and adds them to the GitHub
Release. To sign them later, add the repository secrets `CSC_LINK` (the certificate, base64) and
`CSC_KEY_PASSWORD`; on macOS notarization also needs `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID` (see electron-builder's code-signing guide).
