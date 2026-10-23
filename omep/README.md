# Open Music Engine Profile (OMEP) 1.0

An open profile of the [Model Context Protocol](https://modelcontextprotocol.io) (MCP) that lets **any music
model become a performer** in any studio that speaks it: a server MCP that declares OMEP, describes itself
in a manifest, and exposes one tool per *capability* ("add a layer", "sing this melody", "separate the
stems"). The studio sends a **Song Context Package** (what there is and what is wanted) and gets back a
**Contribution** (notes, audio, stems, parameters) with its provenance and licence.

OMEP is MIT-licensed and model-agnostic. [OpenBand](../README.md) is its first studio; the profile does not
depend on it.

- JSON Schemas (2020-12): [`schemas/`](schemas/) — `manifest`, `scp` (Song Context Package), `contribution`,
  `tool-input`.
- Reference mock engine: [`mock-engine.mjs`](mock-engine.mjs).
- Conformance suite: [`conformance.mjs`](conformance.mjs) (`omep-conformance`).
- Example context: [`examples/context.json`](examples/context.json).

## 1. Roles

| Role | Who | Does |
|---|---|---|
| **Conductor** | any LLM (through the studio's own MCP tools) | understands intent, plans |
| **Studio** | e.g. OpenBand | the source of truth for the song: context, constraints, conformance, undo, versions, the contribution ledger |
| **Performer** (engine) | an OMEP server: a local model, a hosted API, or an algorithm | makes music |

The studio is an MCP **client** of performers. Performers never talk to the conductor directly.

## 2. Declaring OMEP

An engine is an MCP server (any transport: stdio, Streamable HTTP) that:

1. declares the capability `experimental["io.openband/music-engine"] = { "version": "1.0" }` in its
   `initialize` result (servers on an MCP revision with *extensions* may declare it there too);
2. serves the **manifest** as the resource `omep://manifest` (`application/json`, schema
   [`manifest.schema.json`](schemas/manifest.schema.json));
3. registers **one tool per capability**, named exactly like the capability (`music.add_layer`).

## 3. Manifest

```jsonc
{
  "omep": "1.0",
  "engine": { "id": "ace-step-1.5", "name": "ACE-Step 1.5", "version": "1.5.0", "homepage": "https://…" },
  "license": { "code": "MIT", "weights": "MIT", "commercial": "yes", "attribution": null, "conditions": null, "url": "https://…" },
  "runtime": { "where": "local", "device": ["cuda", "mps", "cpu"], "vram_gb": 4, "realtime": false },
  "capabilities": {
    "music.add_layer": { "conditioning": ["bpm", "key", "chords", "sections", "context_audio", "text"], "max_seconds": 240 },
    "music.song":      { "conditioning": ["lyrics", "text", "bpm", "key", "sections"] }
  },
  "outputs": ["audio/wav"],
  "languages": ["it", "en"],
  "determinism": "seeded"
}
```

- `license.commercial`: `yes`, `no` or `conditional` (then `conditions` is required). Weights under a CC BY
  licence require the `attribution` text, which studios add to the credits by themselves.
- `runtime.where`: `builtin` (inside the studio), `browser`, `local`, `lan` or `cloud`. **Cloud engines must
  state** `provider`, `pricing` (unit and USD, with the date it was checked), `data_policy` (whether audio is
  uploaded, retention, training on inputs, terms URL, verification date) and `output_rights`.
- `capabilities.<name>.conditioning`: the parts of the Song Context Package the engine actually uses. A
  studio sends only those (privacy), and enforces the rest itself.
- `determinism`: `seeded` (same seed → same output), `deterministic`, or `stochastic`.
- `voices` (for `voice.sing`): voicebanks with licences of their own.

## 4. Capabilities (catalog 1.0)

| Capability | Meaning | Contribution `kind` |
|---|---|---|
| `music.song` | a whole piece from text / style | `audio` (or `stems`) |
| `music.add_layer` | one new part over the existing context | `audio` |
| `music.repaint` | regenerate a range | `audio` |
| `music.extend` | continue past the end | `audio` |
| `music.restyle` | same piece, another style | `audio` (or `stems`) |
| `music.arrange` | an arrangement plan (sections, layers, transitions) | `notes` or `params` |
| `symbolic.continue` / `harmonize` / `accompany` / `drums` | MIDI generation | `notes` |
| `voice.sing` | singing from notes + syllables / phonemes | `audio` (+ `alignment.syllables`) |
| `audio.separate` | stems | `stems` |
| `audio.transcribe` | audio → notes / timed text | `notes` |
| `audio.match_sound` | from a sound to a patch | `params` |
| `mix.assist` | a mix proposal | `params` |
| `stream.jam` | real-time generation | `stream` |

Engines may add capabilities under `x-<vendor>.<name>`; studios show them as experimental.

## 5. Tools

Input ([`tool-input.schema.json`](schemas/tool-input.schema.json)):

```jsonc
{ "context": { /* Song Context Package */ } | "file://…/context.json",
  "request": { "text": "soft arpeggiated keys", "role": "harmony", "instrument": "piano" },
  "seed": 1234, "variants": 1 }
```

Output: a `CallToolResult` whose **`structuredContent` is a Contribution**
([`contribution.schema.json`](schemas/contribution.schema.json)); files are referenced by URI —
`file://` for local engines, signed and expiring `https://` for remote ones — and also listed as
`resource_link` content items. Never base64 for large files.

### Long jobs: MCP tasks

Generative tools should declare `execution.taskSupport: "optional"`: clients that negotiate *tasks* (MCP
2025-11-25, experimental) get a `CreateTaskResult` at once and poll `tasks/get`, read `tasks/result` and may
`tasks/cancel`; clients that don't get a synchronous answer with progress notifications. `"required"` is
allowed but excludes clients without tasks. Because tasks are still experimental, studios must always
handle the synchronous path.

### Gated weights, prompts

- If weights need an accepted licence (e.g. on Hugging Face), the engine uses **URL-mode elicitation**: the
  user completes the step in their browser, the studio never sees secrets.
- An engine may use **sampling** to ask the conductor (through the studio, with the user's consent) to
  rewrite a prompt into the tags its model understands.

## 6. Song Context Package (SCP) 1.0

The model-independent description of the song and of the request
([`scp.schema.json`](schemas/scp.schema.json)): `song` (bpm, tempo map, meter, key, length), `scope` (bars),
`sections`, `harmony`, `melody`, `lyrics` (with syllables, stress, phonemes), `tracks` (roles, summaries,
stems), `context_audio`, `references`, `intent`, `constraints` (hard: key, bpm, length, sections, range;
soft: style, avoid, density), `policy`, and `context_hash` (SHA-256 of the canonical song the request was
made from). Note positions are in beats from `scope.from_bar`.

## 7. Contribution

```jsonc
{
  "kind": "audio",
  "files": [{ "uri": "file:///…/layer.wav", "role": "layer", "format": "wav", "sample_rate": 48000 }],
  "alignment": { "start_bar": 9, "bpm_detected": 92.0, "downbeat_offset_ms": 12 },
  "claims": { "key": "Dm", "bpm": 92, "length_bars": 8 },
  "provenance": { "engine": "ace-step-1.5", "model_hash": "sha256:…", "seed": 1234, "context_hash": "sha256:…" },
  "license": { /* copied from the manifest */ }
}
```

`claims` is what the engine *says* it respected. The studio **measures** (tempo, key, length), corrects
(time-stretch, pitch-shift, trim) and records each correction in `provenance.conform`.

## 8. Streaming (`stream.jam`)

MCP is not for continuous audio. The tool returns a stream descriptor (`ws-pcm`: binary PCM 48 kHz over
WebSocket, or `webrtc-opus` on a LAN) and a clock channel on which the studio sends transport beats
(position, BPM, high-resolution timestamps) and the engine answers with measured offset and latency.
Control messages (chords, style, intensity) travel on the same channel. (Detailed in OMEP 1.1.)

## 9. Conformance

```bash
node omep/conformance.mjs -- <command that starts your engine> [args…]
node omep/conformance.mjs --url https://host/mcp --token <token>
node omep/conformance.mjs --json --min-adherence 0.8 -- uvx my-omep-engine
```

It checks: the OMEP declaration; the manifest against its schema; a tool per declared capability that
requires `context`; for each capability, a call with a test context whose Contribution must validate, have
the right `kind`, name the engine and copy the licence; same seed → same result for seeded engines; a run
as an MCP task and a cancellation, when tasks are declared. Then it **measures** each output against the
context — notes inside the scope, in key and in range; audio duration, tempo (onset autocorrelation) and key
(chroma, Krumhansl–Kessler) — and prints an **adherence** score. A low score is not a failure: studios
correct more, and their routers know.

Exit code `0` when every required check passes (and adherence ≥ `--min-adherence`, when given).

## 10. Versioning

`omep` in the manifest is the profile version. Minor versions only add optional fields and capabilities;
studios ignore what they don't know. A new major version changes required fields.
