# ADR 0001 — A desktop app that hosts VST3 / CLAP plugins

Status: proposed (F26, exploratory) · 2026-10-20 · branch `spike/desktop-clap`, not merged

## Context

OpenBand runs in the browser: its instruments are Tone.js and Web Audio Modules (WAM). Most musicians'
plugins are native — VST3, CLAP, AU — and a browser can't load them. A desktop app could, while keeping
the same UI, the same songs and the same MCP server. Three questions decide how:

1. **Shell**: Tauri or Electron.
2. **Where plugin audio runs**: plugins must run in a native process; the question is how audio gets
   there and back from the web engine, and whether the whole audio engine should move to native.
3. **Plugin formats**: CLAP first (open, MIT, C ABI), VST3 (the SDK is MIT since 2025), AU on macOS later.

## Options

| | **Tauri 2** | **Electron** |
|---|---|---|
| Size of an installer | ~5–15 MB (system WebView) | ~90–150 MB (bundles Chromium) |
| Web engine | WKWebView (macOS), WebView2 (Windows), WebKitGTK (Linux) — three engines to test | the same Chromium everywhere |
| Web Audio / AudioWorklet | yes on all three, with differences (Safari's WebKit lags on some APIs) | Chromium's, identical to the browser version |
| Native side | Rust: plugin hosting via `clack` (CLAP), `vst3` bindings, CPAL for audio devices | Node: native addons (C++/N-API) for hosting, more glue |
| Security model | capability-based, small surface | full Node in the main process; needs care |
| Fit with OpenBand | the MCP server can stay Node (sidecar) or move to Rust; the UI is the same build | the MCP server can live in the main process as it is |

Electron is the lower-risk shell for audio parity (one engine everywhere, the one OpenBand is already
tested on); Tauri is smaller, more secure, and puts the plugin host in Rust, which is where the hard part
lives anyway.

## The audio bridge (the real problem)

Two architectures:

- **A. Web engine + native plugin island**: OpenBand's engine stays in the WebView; a track with a native
  plugin sends its audio, block by block, to the native host and gets it back.
- **B. Native engine**: the whole mixer and transport move to native (CPAL); the WebView keeps the UI and
  the scheduling (it sends notes, automation and clip data, not audio).

### What the spike measured (architecture A)

`desktop-spike/` on this branch:

- `clap-host.c` — a minimal CLAP host (the C ABI that the Rust crate `clack` wraps): loads a `.clap`
  bundle, sends notes, processes 128-frame blocks. With **Vital 1.5.5** (a real CLAP instrument installed
  on the test machine) it renders a C-major chord: peak 0.88, −13.8 dBFS RMS — **a plugin that plays**.
  3 s of audio render in 0.11 s including loading the plugin (Apple M1 Pro).
- `bridge.mjs` + `measure.mjs` — the bridge as it would be in the app: an AudioWorklet in the page hands
  each render quantum (128 frames, 2.67 ms at 48 kHz) to the page, the page sends it over a local
  WebSocket, a relay pipes it to the native host running the plugin, and the result travels back to the
  worklet, which measures the round trip in audio frames. Chrome headless, 60 s, 22 474 blocks:

| round trip | p50 | p90 | p99 | p99.9 | max |
|---|---|---|---|---|---|
| ms | 5.33 | 5.33 | 8.0 | 10.67 | 21.3 |

  (20 s run: p99 10.67, p99.9 13.33, max 16.) Resolution is one render quantum (2.67 ms).

Reading it: the round trip is usually two quanta, so a glitch-free island needs a jitter buffer of
**about 4–6 blocks (11–16 ms)** on top of the device's own output latency — and the occasional 20 ms
outlier means a real-time player either buffers more or drops a block now and then. That is acceptable
for **effects on mixing tracks and for playback of plugin instruments from the timeline** (the engine can
schedule ahead, and plugin delay compensation absorbs the constant part), and **not good enough for
playing a plugin instrument live** from a keyboard, where 15–20 ms extra is noticeable.

What was **not** measured: Tauri's own IPC (instead of a WebSocket; likely similar or better, but it is
a guess), WebView2 and WebKitGTK (only Chrome here), and architecture B — which by construction has only
the device buffer (CPAL can run at 64–128 frames), but requires rewriting the engine, the automation, the
offline render and the analysis around native code.

The spike is in C, not Rust, because the machine's Rust toolchain was broken (a Homebrew Rust/LLVM
version mismatch) and repairing it would have changed the system; the CLAP calls are the same ones
`clack` makes, so the finding about the bridge does not depend on the language.

## Decision (proposed)

1. **Tauri**, with a **Rust sidecar** that hosts plugins in its own process (a crashing plugin must not
   take the app down): `clack` for CLAP first, the `vst3` bindings next; native plugin GUIs in their own
   native windows.
2. **Start with architecture A** (web engine + native plugin islands), with a per-track jitter buffer
   sized from measurements on each platform (start at 6 blocks), reported to the engine as plugin
   latency so the timeline stays in sync; it reuses everything OpenBand has.
3. **Plan for B for live playing**: route the audio device through the native side when a native
   instrument is armed or monitored, so live playing has only the device buffer. Measure on WebView2 and
   WebKitGTK before committing; if their Web Audio diverges too much, B becomes the default.
4. The **MCP server moves inside the app** with the same WebSocket and stdio API (Node sidecar first, so
   nothing in `server/` has to change).
5. Electron remains the fallback if the three WebViews' Web Audio turns out to be too different.

## Next steps (a separate project)

- Rebuild the host in Rust with `clack`, as a Tauri sidecar; replace the WebSocket with Tauri IPC (or a
  shared-memory ring buffer) and measure again on macOS, Windows and Linux.
- An effect plugin on a track end to end (spec's prototype), with plugin delay compensation.
- VST3 hosting; plugin GUIs in native windows; plugin state in the project (like WAM state today).
- Crash isolation (one process per plugin or per track), and a scan of installed plugins.
