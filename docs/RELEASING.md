# Releasing OpenBand

One tag publishes everything at the same version, as a GitHub Release:

- `openband.tgz` (and `openband-X.Y.Z.tgz`): the built package, the one people run with
  `npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz`;
  `setup` writes the version-pinned URL into MCP client configs;
- `openband.mcpb` (and `openband-X.Y.Z.mcpb`): the Claude Desktop extension, for the README's "latest" link;
- the release notes (the version's section of `CHANGELOG.md`) and the online demo.

> **npm name:** `openband` on npm belongs to someone else (a reserved 0.0.0 package), so OpenBand is not
> published to npm and `npx openband` must never be suggested (`server/package.mjs` explains it; `doctor`
> flags configs that use it). To publish to npm one day, pick a name OpenBand owns (for example
> `@iltempe/openband`), set it in `package.json`, `server/package.mjs` and `src/install.ts`, add the
> `NPM_TOKEN` secret and set the repository variable `NPM_PUBLISH=true`.

Opt-in steps of the *Release* workflow (repository variables, Settings → Secrets and variables → Actions):

- `NPM_PUBLISH=true`: also `npm publish --provenance` (needs `NPM_TOKEN`, an npm automation token).
- `PUBLISH_DOCKER=true`: also push the image to `ghcr.io/iltempe/openband` (amd64 and arm64).

## Each release

1. Move the `## Unreleased` section of `CHANGELOG.md` under a heading for the version, e.g. `## v0.3.0 "What no DAW has"`.
2. `npm version 0.3.0 --no-git-tag-version` (semver: breaking → major, features → minor, fixes → patch).
3. `npm run build && node scripts/release-dry-run.mjs`: the package, the `.mcpb` and the demo carry the same version and there are notes for it (CI runs this on every push too).
4. Run the [manual .mcpb checklist](checklists/mcpb.md) on macOS and Windows with the bundle from the dry run.
5. Commit, then `git tag v0.3.0 && git push origin main v0.3.0`. The *Release* workflow verifies that the tag matches `package.json`, runs the tests, smoke-tests the package, builds and tests the `.mcpb`, creates the GitHub Release with both attached and deploys the demo.
6. From an empty folder: `npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz --version` prints the new version.

## Compatibility between versions

The app and the server exchange a bridge **protocol** number in `hello` (`src/protocol.ts`, `PROTOCOL` in
`server/mcp-server.mjs`). The online demo is always the newest app, while the server on someone's computer
may be older: bump the protocol only for changes the other side can't handle, and keep unknown commands
failing with a message rather than silently. A mismatch is explained in the AI panel.

The server asks GitHub for the latest release at most once a day (cached in
`~/.openband/update-check.json`; `OPENBAND_NO_UPDATE_CHECK=1` turns it off) and reports it in its log, in
`get_status` (`server.update`) and in the AI panel.
