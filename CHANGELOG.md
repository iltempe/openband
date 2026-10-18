# Changelog

All notable changes to OpenBand. The v0.2 work follows [docs/SPEC.md](docs/SPEC.md).

## Unreleased — v0.2 "The AI that listens"

### F3 · Studio → AI event channel
- The browser now reports what the user does: live phrases (split after a bar of silence, notes quantized to 1/16 with the raw start kept), selection (throttled to one event per 500 ms), play/stop/loop, finished user edits, recorded regions and questions from the new *Ask the AI* box.
- MCP server: a 500-event ring buffer with the new tools `get_events` (since_id, kinds, limit) and `wait_for_event` (long-poll up to 60 s, `{timeout:true}` otherwise).
- MCP resource `openband://project` (the `get_project` JSON) with subscriptions: subscribers get `notifications/resources/updated` after every change.
- Privacy: *Share my activity with the AI* in the AI panel (on by default on localhost); when off only explicit events (questions, A/B results) are sent.
- Pure modules with tests: `src/phrases.ts` (phrase segmenter) and `server/events.mjs` (event buffer).

### F4 · Reusable renderer
- `renderBuffer(project, options)` renders the song or a range (`fromBeat`/`toBeat`), only some tracks (stems, ignoring mute/solo), with or without the master volume, at any sample rate and with a configurable tail; notes and audio clips already sounding at the start of the range are rendered from the right point.
- `renderStems()` renders tracks one at a time over the same range; `renderProject()` (WAV export) is built on top and unchanged for users.
- An LRU cache of the last 3 renders keyed on project + options.
- Renders are now deterministic: the reverb impulse is generated from a fixed seed and noise sources are seeded during offline renders, so stems add up exactly to the mix and analyses are repeatable. Verified: the demo's WAV export differs from the pre-refactor one by at most 1 LSB (−90.3 dBFS, the same as between two exports of the old code).

### F2 · Project schema v2 and migrations
- Projects are now schema v2: the same content plus optional fields for the coming features (sections, lyrics, annotations, reference track, linter settings, takes) and `meta` (`projectId`, `createdAt`, `updatedAt`).
- `src/migrations.ts` (pure): `migrate()` accepts v1 and v2 objects or JSON, fills missing defaults, assigns a stable `projectId` and rejects non-projects with a clear message. It is used by autosave, `import_project_json`, `.openband.json` and `.openband` files.
- Autosave moved to `openband.project.v2`; the v0.1 key is still read, so existing songs open and are re-saved as v2.

### F1 · Transactions and undo by intent
- Labelled undo history: each step records its label, source (UI/AI) and how many commands it groups.
- Store transactions (`beginTransaction` / `endTransaction`, nestable): commits inside one become a single undo step; empty transactions leave no trace.
- AI commands are grouped automatically and closed after 4 s of silence, or explicitly with the new MCP tools `begin_change(label)` / `end_change()`; a user edit closes an open AI step instead of merging into it.
- New MCP tool `get_history`; `undo` / `redo` take `steps`.
- Drags and knob turns are one step each. Undo/redo tooltips show the label; the AI panel groups activity by step with an “Undo this” button.

### F0 · Test infrastructure
- Vitest (`npm test`, `npm run test:watch`) with Node as the default environment.
- Reference projects in `src/__fixtures__/`: the v0.1 demo exported as real v1 JSON, an empty project and a deliberately "dirty" one for the linter.
- CI workflow (`.github/workflows/ci.yml`): typecheck and tests on every push and pull request.
- The WAM SDK is now loaded lazily so the command and store modules can be imported in Node.

## 0.1.0

First public version: arrangement, piano roll, step sequencer, synthesized instruments, imported sounds (sampler, drum kits, SoundFont, audio tracks), per-track effects, automation, MIDI import/export, WAM plugins, WAV export, English/Italian UI and AI control over MCP.
