# Desktop spike (F26) — native CLAP plugins and the audio bridge

Exploratory, on branch `spike/desktop-clap`, **not merged**. The decision record is
[docs/adr/0001-desktop.md](../docs/adr/0001-desktop.md).

- `clap-host.c` — a minimal CLAP host: list the plugins in a bundle, render a chord to WAV, or serve
  128-frame blocks over stdin/stdout.
- `bridge.mjs` — a page whose AudioWorklet streams audio blocks over a local WebSocket to the native host
  and back.
- `measure.mjs` — runs the bridge in headless Chrome and reports the round-trip latency distribution.

```bash
# the CLAP headers (MIT): https://github.com/free-audio/clap
git clone --depth 1 --branch 1.2.6 https://github.com/free-audio/clap /tmp/clap
clang -O2 -I/tmp/clap/include desktop-spike/clap-host.c -o /tmp/clap-host

/tmp/clap-host /Library/Audio/Plug-Ins/CLAP/Vital.clap --list
/tmp/clap-host /Library/Audio/Plug-Ins/CLAP/Vital.clap --render /tmp/chord.wav 0   # a plugin that plays
node desktop-spike/measure.mjs /tmp/clap-host /Library/Audio/Plug-Ins/CLAP/Vital.clap 60
```

macOS only as written (`.clap` bundles, `dlopen`); Windows and Linux need the platform's loader.
