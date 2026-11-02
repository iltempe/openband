# The rehearsal Box

🇬🇧 English · 🇮🇹 [Italiano](BOX.it.md) · [← README](../README.md)

A computer left on in the rehearsal room, with a USB audio interface. It records every rehearsal by itself, cuts it into songs, and keeps it as a version of your song. The next day you open it from a phone.

**It records everyone in the room.** Tell people. Turn it off with `openband box off`, or in the *Rehearsal room* panel.

## Raspberry Pi or Linux

```sh
curl -fsSL https://raw.githubusercontent.com/iltempe/openband/main/scripts/box/install.sh | sudo sh
```

It installs Node, ffmpeg and avahi, creates an `openband` user and a service, and prints the address and PIN. Then open `http://openband.local:7777` from a phone on the same network, and enter the PIN in *Projects → Archive*.

## Any computer

```sh
openband box devices                                  # find your input
openband box --device hw:1 --channels 2 --names "Voice,Guitar" --project "My band"
openband box install                                  # as a service: systemd, launchd or Task Scheduler
openband box status
openband box off
```

You need ffmpeg (`apt install ffmpeg`, `brew install ffmpeg`, `winget install ffmpeg`). OpenBand does not include it. On Linux, `arecord` also works.

## How it decides

- It starts after 2 s of sound over the threshold (`--threshold`, default −42 dB), keeping the 5 s before.
- A pause over 8 s separates two songs. 90 s of silence ends the session.
- Each channel is written in 5-minute segments. After a power cut, the session is recovered at the next start.
- A session becomes tracks, sections "Brano 1…n" and a version on the branch `prove`. The main branch stays what the band arranges.
- Old sessions go first, when there are more than 50. Starred ones never do. Your song keeps the audio already imported.

Docker on Linux: `docker compose -f docker-compose.box.yml up -d`.

## Buttons, LED and footswitch

On a Pi, set the pins in `box.json`: `"gpio": { "rec": 17, "mark": 27, "led": 22 }`. It uses the `gpiomon` and `gpioset` commands from `gpiod`.

- **REC**: start or stop. A long press turns the Box off or on.
- **MARK**: "there's a mistake here", at this instant.
- **LED**: off = stopped, steady = armed, blinking = recording, fast = error or disk full.

A USB-MIDI footswitch does the same on Linux: `"midi": { "port": "hw:1,0", "rec": { "note": 60 }, "mark": { "cc": 64 } }`.

## On a laptop, and in the browser

**Desktop app**: *File → Rehearsal Mode* records the room while the app is open, with an icon in the system tray. *Start at Login* is optional. Settings are in `box/box.json` in the app's data folder.

**Browser**: *Rehearsal room → Record the rehearsal* works without a Box, best effort: keep the tab open and the screen on. One microphone, one track.

**Not tested yet on real hardware**: a Raspberry Pi and a real USB interface. Tell us how it goes.
