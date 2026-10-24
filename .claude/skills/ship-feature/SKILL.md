---
name: ship-feature
description: The way every new OpenBand feature is delivered, from code to release. Use whenever the user asks to implement one or more new features or requirements (also a spec item such as G3, E2, G8.3), or a fix that changes what users get. Covers implementation, tests, docs, GUI, the GitHub repo, a tagged release that rebuilds every distribution (npx package, .mcpb, desktop app for macOS, Windows and Linux, online studio) and the website with its download links.
---

# Shipping a feature in OpenBand

The user's standing rule (from 2026-10-24): **every new feature — or group of features — goes all the way
out**: implemented, documented, released for every platform, and visible on the website. Nothing stays
only local. Do it without asking again; ask only for things the rules below reserve to the user.

## 1. Implement

- Follow the specs in `docs/` (`SPEC.md` §0 rules: commands shared by UI and MCP in `src/commands.ts`,
  tool definitions in `server/tools.mjs`, pure testable logic, DSP in workers/worklets, i18n EN + IT).
- **One feature (or spec item) = one commit = one release.** Several features in one request: ship them one
  after the other, each with its own commit and tag, in the order the spec gives (or the user's).
- Big items may be split into parts (G1a/G1b, G8.1…G8.9), each released on its own.
- **Adapt the GUI** whenever the feature is something a person would use: panel, button, dialog, badge.
  Check it in a real Chrome (puppeteer scripts in the scratchpad, `?debug` exposes `window.openband`) and
  look at the screenshots; fix layout problems before shipping.

## 2. Test

- Unit tests next to the code (`npx vitest run`), typecheck (`npx tsc --noEmit -p .`).
- An end-to-end check in `scripts/e2e/run.mjs` for anything audible or interactive (`npm run e2e`;
  Chrome runs with a fake audio output). Acceptance criteria of the spec become checks.
- Desktop-only features: `scripts/smoke-desktop.mjs` (the packaged app, `--smoke` mode in `desktop/main.mjs`).
- Never real paid API keys or money: mocks and sandboxes. Throwaway profiles, never the user's.

## 3. Document

- `CHANGELOG.md`: a new `## vX.Y.Z "title"` section at the top — what changed for people, what is not done
  yet, deviations from the spec, and what the tests prove (with the measured numbers).
- User docs where they belong (`docs/FEATURES*.md`, `docs/MCP-TOOLS*.md`, a guide such as `docs/MIXING*.md`,
  `docs/DESKTOP*.md`), always **English and Italian**; README / README.it when it changes the pitch.
- Tool counts in README.it, docs/FEATURES*, docs/AI-MODELS* when MCP tools are added (count them:
  `smoke:pack` prints the MCP total; in-page = TOOLS of kind call/file/export/chord_sheet/image minus 2).
- Screenshots in `docs/*.png` for new UI; the INSTRUCTIONS in `server/tools.mjs` for new tools.
- Progress memory (`spec-v06-progress` or the current spec's).

## 4. Release for every platform

```bash
npm version X.Y.Z --no-git-tag-version          # patch for each requirement (v0.6.N)
npx tsc --noEmit -p . && npx vitest run
npm run build && npm run e2e
node scripts/release-dry-run.mjs && npm run smoke:pack
node scripts/build-mcpb.mjs && npm run smoke:mcpb
node scripts/build-plughost.mjs                 # the native plugin host (G8)
env -u ELECTRON_RUN_AS_NODE npm run desktop:build -- --dir && env -u ELECTRON_RUN_AS_NODE npm run desktop:smoke
git add -A && git commit                        # message "<ID>: <title>", Co-Authored-By trailer
git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z
```

- The tag starts `release.yml`: npm tarball, `.mcpb`, desktop installers for **macOS (arm64, x64),
  Windows (x64, arm64) and Linux (AppImage, .deb; x64, arm64)**, stable "latest" asset names, then the
  online studio (`pages.yml`). Every release is "latest".
- Watch Release and CI to the end (a background `gh run watch`), then check: 24 assets on the release,
  `https://iltempe.github.io/openband/version.json` reports the new version. A failing job is fixed and
  shipped as the next patch release — never leave a release without a platform.
- `ELECTRON_RUN_AS_NODE` is set in the VS Code terminal: always `env -u` it when running Electron.

## 5. Website

The site is `site/` (published at `https://iltempe.github.io/openband/about/` by `pages.yml` through
`scripts/build-site.mjs`). Update it when the feature deserves a place there:
- a feature card on `site/index.html` (with a screenshot listed in `scripts/build-site.mjs`), the facts strip
  (tool count, platforms), the AI section;
- EN text in the HTML and its IT translation in `site/site.js`;
- **download links**: they use the stable "latest" asset names (`OpenBand-mac-arm64.dmg`,
  `OpenBand-win-x64.exe`, `OpenBand-linux-x86_64.AppImage`, …). If a release adds, renames or drops an asset
  (a new architecture, a new format), update `site/index.html` and the asset list in `release.yml` together.

## Never without the user's explicit OK

npm publish (the npm name "openband" is someone else's: never suggest `npx openband`), new GitHub repos or
orgs, pushing Docker images, spending money or using real paid API keys, publishing on the user's behalf
anywhere else.
