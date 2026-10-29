# __NAME__

An [OMEP 1.0](https://github.com/iltempe/openband/tree/main/omep) music engine: an MCP server that any studio
speaking OMEP (such as [OpenBand](https://github.com/iltempe/openband)) can use as a performer.

Made from `omep-template`. Out of the box it plays `symbolic.drums`, a simple groove, so that everything
around it — the manifest, the tool, the Contribution — already passes conformance. Put your model in
`makeDrums()` in [`engine.mjs`](engine.mjs), or add tools for other capabilities (`music.add_layer`,
`voice.sing`, `audio.separate`…: the catalog is in OMEP §4).

```bash
npm install
npm run conformance     # protocol, manifest, schemas, determinism, licence, adherence to the song
npm start               # the engine on stdio (a studio starts it for you)
```

## Use it in OpenBand

In `~/.openband/engines.json`:

```json
{ "engines": { "__ID__": { "command": "node", "args": ["/absolute/path/to/__ID__/engine.mjs"] } } }
```

It then appears in *Ensemble*, and `create` can route parts to it.

## What to change

- **The manifest** (`MANIFEST` in `engine.mjs`): name, version, homepage; the **licence** of the code and of
  the weights, whether commercial use is allowed (`yes`, `no`, `conditional` with `conditions`), and the
  attribution text CC BY weights require; where it runs (`local`, `lan`, `cloud` — cloud engines must also
  state pricing and data policy); which parts of the context the model uses (`conditioning`).
- **Long jobs**: a model that takes more than a few seconds should support MCP tasks (see the mock engine in
  OpenBand's `omep/mock-engine.mjs`); conformance then also checks a task run and a cancellation.
- **Audio**: return `files` with `file://` URIs of WAV/FLAC files you wrote (or signed `https` URLs),
  with their `role` (`layer`, `full`, `drums`…) and sample rate.
- **Real time** (`stream.jam`): see OMEP §8 and `omep/lib/stream-server.mjs`.

Any language works: OMEP is MCP plus a manifest and a few schemas. This template is in JavaScript because
it is the smallest complete example; a Python engine uses the official MCP Python SDK the same way.
