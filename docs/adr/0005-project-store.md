# ADR 0005: the project store is a folder, not a database

Status: accepted (v0.7).

## Context
Songs lived in the browser: clearing its data lost everything, there was no shared archive, and the rehearsal Box had nowhere to write. The server side needs a library for desktop, npx, Docker and a Raspberry Pi, with no native build step on any of them.

## Decision
A folder of plain files (`server/store/fs.mjs`), written with Node's standard modules: `project.json`, gzipped versions and journal entries, one file per sample.

- **Atomic writes**: temporary file, fsync, rename, fsync of the folder.
- **Etags** are hashes of the canonical song, so a browser and a server agree on when two songs are the same.
- **No overwrites**: a stale etag is a 409, and the client keeps its work on a branch.
- **The browser stays the working copy**: writes land in its cache first, and an outbox delivers them.
- **On the desktop**, the MCP server only runs when an AI client starts it, so the app's main process runs its own loopback store.

## Why not SQLite
It would add a native dependency to every package and architecture, or a Node version floor with `node:sqlite`. A backup would need the database's own tools, where here it is a copy of a folder, and the songs stay readable without OpenBand. One library per instance with few writers does not need a query engine.

## Consequences
- Listing reads every `project.json`, which is fine for hundreds of songs and not for millions.
- One writer process per library. Desktop and an `openband mcp` keep separate libraries by default (`userData/library` and `~/.openband/library`).
- Multi-user is out of scope; a `/libraries/:lib/` prefix remains possible later.
