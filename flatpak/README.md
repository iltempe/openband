# OpenBand as a Flatpak

`it.openband.OpenBand` (the id follows the project's domain, openband.it). It is built from the `.deb` files
of each GitHub release, unchanged, on the Electron base app, with `zypak` as Electron's sandbox.

| File | What it is |
|---|---|
| `it.openband.OpenBand.desktop` | The launcher, with the file types it opens (`.openband`, MIDI, DAWproject) |
| `it.openband.OpenBand.metainfo.xml` | AppStream: description, screenshots, links; releases are added per version |
| `it.openband.OpenBand.yml` | The manifest, **generated** for a release by `node scripts/flatpak-manifest.mjs vX.Y.Z` (URLs and SHA-256 of the `.deb` files from GitHub) |

## Install the bundle of a release

Every release from v0.6.35 has `OpenBand-linux-x86_64.flatpak`:

```bash
flatpak install --user https://github.com/iltempe/openband/releases/latest/download/OpenBand-linux-x86_64.flatpak
flatpak run it.openband.OpenBand
```

The bundle needs Flathub as a remote for its runtime (`flatpak remote-add --if-not-exists --user flathub
https://dl.flathub.org/repo/flathub.flatpakrepo`). Inside a Flatpak the app doesn't update itself: *About
OpenBand* says so; `flatpak update it.openband.OpenBand` (or the software center) does it.

## Build it yourself

```bash
node scripts/flatpak-manifest.mjs v0.6.35 --out build/flatpak
flatpak-builder --user --install-deps-from=flathub --force-clean --install build/flatpak-app build/flatpak/it.openband.OpenBand.yml
```

## Permissions, and why

| Permission | Why |
|---|---|
| `--socket=wayland`, `--socket=fallback-x11` | The window: Wayland where there is one (Electron with `--ozone-platform-hint=auto`), X11 otherwise |
| `--socket=pulseaudio` | Playback, recording, the microphone |
| `--device=all` | MIDI keyboards and controllers (the ALSA sequencer, `/dev/snd/seq`) and audio interfaces |
| `--share=network` | Online engines, the relay, publishing with the user's own accounts, update checks |
| `--filesystem=xdg-music`, `xdg-download` | Songs and samples where people keep them, exports |
| `~/.clap`, `~/.vst3` (read-only) | The user's CLAP and VST3 plugins. `/usr` belongs to Flatpak, so plugins installed system-wide (`/usr/lib/vst3`) aren't reachable: install them in `~/.vst3` / `~/.clap` |
| `--talk-name=org.freedesktop.Notifications` | "A new version is available", "export done" |

## On Flathub

Submitting is a pull request to [flathub/flathub](https://github.com/flathub/flathub) (branch `new-pr`),
made by the maintainer, with the generated manifest, the metainfo and the desktop file; Flathub then
verifies the app id against openband.it and creates the `flathub/it.openband.OpenBand` repository, where
each new version is a pull request with the new manifest. Flathub's linter (`flatpak run --command=flatpak-builder-lint
org.flatpak.Builder manifest …`) should pass first. Reviewers may ask about `--device=all`: it is there for
MIDI devices, which have no narrower permission.
