# Releasing OpenBand

One tag publishes everything at the same version: the npm package (`npx openband`), the Claude Desktop
extension (`.mcpb`, attached to the GitHub Release, also as `openband.mcpb` for the README's "latest" link),
the release notes and the online demo.

## Once

- Add the repository secret **`NPM_TOKEN`**: an npm *automation* token of an account that can publish
  `openband` (Settings → Secrets and variables → Actions). Provenance is signed with the workflow's OIDC
  identity (`id-token: write`), nothing else to configure.

## Each release

1. Move the `## Unreleased` section of `CHANGELOG.md` under a heading for the version, e.g. `## v0.3.0 — "What no DAW has"`.
2. `npm version 0.3.0 --no-git-tag-version` (semver: breaking → major, features → minor, fixes → patch).
3. `npm run build && node scripts/release-dry-run.mjs` — the tarball, the `.mcpb` and the demo carry the same version and there are notes for it (CI runs this on every push too).
4. Run the [manual .mcpb checklist](checklists/mcpb.md) on macOS and Windows with the bundle from the dry run.
5. Commit, then `git tag v0.3.0 && git push origin main v0.3.0`. The *Release* workflow verifies that the tag matches `package.json`, runs the tests, smoke-tests the npm tarball, publishes it with provenance, builds and tests the `.mcpb`, creates the GitHub Release and deploys the demo.

## Compatibility between versions

The app and the server exchange a bridge **protocol** number in `hello` (`src/protocol.ts`, `PROTOCOL` in
`server/mcp-server.mjs`). The online demo is always the newest app, while the server on someone's computer
may be older: bump the protocol only for changes the other side can't handle, and keep unknown commands
failing with a message rather than silently. A mismatch is explained in the AI panel.

The server asks the npm registry for the latest version at most once a day (cached in
`~/.openband/update-check.json`; `OPENBAND_NO_UPDATE_CHECK=1` turns it off) and reports it in its log, in
`get_status` (`server.update`) and in the AI panel.
