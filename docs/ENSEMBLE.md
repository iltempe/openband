# Ensemble: engines that play in OpenBand

🇬🇧 English · 🇮🇹 [Italiano](ENSEMBLE.it.md) · [← README](../README.md)

OpenBand is where the song lives; **engines** play parts of it. An engine can be one of OpenBand's own
algorithms, a music model on your computer, one on another computer on your network, or (soon) an online
service. They all speak the same open standard, the [Open Music Engine Profile](../omep/README.md) (OMEP),
so OpenBand never calls a model by name: you ask for a part, OpenBand picks who plays it.

## Create a part

Press **✦ Create** in the toolbar (or *Ensemble → Create a part*), describe what you want — *“funk drums,
busy”*, *“arpeggiated piano, intimate”*, *“a lo-fi keys loop”* — and choose where (the whole song, the
cycle, a section, some bars). OpenBand:

1. works out the **part**: drums (notes), an accompaniment (notes) or an audio layer — from your words, or
   pick it;
2. picks the **engine** with the router (see below), or the one you choose;
3. sends it the song's **context**: tempo, key, sections, the chords it reads from your parts — only what
   that engine says it uses;
4. **conforms** what comes back to the song: notes in the song's key and range and inside the bars; audio
   stretched to the tempo, moved to the key, repeated or trimmed to the bars. Every correction is written
   down (*“stretch 12.2% (82 → 92 BPM) · repeated ×4”*);
5. puts it in the song as **one undo step**. With **variants** (up to 4, from different engines when
   several can play) the results become takes of one region: compare them, or run a blind test.

<img src="ensemble-create.png" alt="The Create dialog" width="420">

No AI is needed. With one connected, it can do the same with the `create` tool.

## The engines

| Engine | Part | Where | Licence |
|---|---|---|---|
| **OpenBand Drummer** | drums (10 styles, follows the sections) | in OpenBand | MIT |
| **OpenBand Chords** | accompaniment: block, stabs or arpeggio, on the song's chords | in OpenBand | MIT |
| **OpenBand CC0 loops** | an audio layer from the CC0 loop library | in OpenBand | MIT + CC0 audio |
| your engines | whatever they declare | your computer, your network | theirs |

### Adding engines

Engines you install run through the OpenBand server on your computer — the desktop app, `npx …` or the
Claude Desktop extension. List them in `~/.openband/engines.json` (or point `OPENBAND_ENGINES` to another
file), in the same format MCP clients use:

```json
{
  "engines": {
    "ace-step":  { "command": "uvx", "args": ["omep-ace-step"], "env": { "DEVICE": "cuda" } },
    "studio-pc": { "url": "https://192.168.1.20:8765/mcp", "token": "…" },
    "mock":      { "builtin": "omep-mock" }
  }
}
```

then press *Refresh* in *Ensemble*. OpenBand only ever starts what is in that file. `"builtin": "omep-mock"`
is the reference engine of the OMEP repository, handy to try the whole chain. Before installing an engine,
check it with `openband omep-conformance -- <its command>`.

## Your policy and the router

*Ensemble → Your policy*:

- **Commercial use only** (on by default): engines whose licence — of the code, the weights or, online,
  the output — forbids commercial use are not used. Engines with *conditional* licences ask once.
- **Only engines on this computer**: nothing goes over the network.
- **Allow online engines** (off by default): they cost money and send data to their provider.

Among the engines left, the router prefers the ones that respect songs best (adherence measured by
conformance and by the corrections OpenBand had to make), then the faster ones; OpenBand's own engines go
first unless another does better. Every engine it skips is listed with the reason (*“its licence doesn't
allow commercial use”*).

## Who played what

Every part an engine made carries a ✦ on its region and an entry in the **contribution ledger**: engine,
version, seed, licence, your request, the context it was made from (a hash of the song) and the corrections.
*Ensemble → Who played what* shows the human / AI share of each track: a region counts as AI while one of the
engine's takes is the active one; record or write your own take and pick it, and it is yours again. The
ledger travels inside the song (`.openband`, exports) and will feed release credits and AI disclosure.

## For AI clients

`create` (describe the part; `variants`, `engine` only when asked), `list_engines` (engines, routes and
exclusions under the policy), `get_ledger` (contributions and shares), `set_engine_policy`.
