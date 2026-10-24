# Mixing and mastering: the Mix Pilot, the master chain, export for platforms

🇬🇧 English · 🇮🇹 [Italiano](MIXING.it.md) · [← README](../README.md)

OpenBand takes a song from "I've recorded and programmed it" to "it sounds like a record and is ready
for Spotify" with **one button and one knob**. You can also do every step by hand. Each choice is
explained, can be undone, and can be compared at the same loudness.

![The Mix Pilot after a run: −19.8 → −14.0 LUFS, the roles and the 18 changes with their reasons](pilot.png)

## The Mix Pilot

Open the **Mix Pilot** tab (next to *Mixer*, or *Mix Pilot* in the master chain). Pick a **genre** (pop,
rock, hip-hop, lo-fi, EDM, acoustic / singer-songwriter, ambient, jazz) and a **target platform**, then
press **Run pilot**. OpenBand renders each track, listens to it and decides:

1. **Roles**: each track is the kick, drums, bass, harmony, lead, vocal, texture or fx. OpenBand works
   this out from the name ("voce", "vox", "basso"…), the instrument, the notes (register, chords or single
   notes) and, for audio, the band that dominates it. If it gets one wrong, correct it in the *Role* column
   or on the mixer strip. Your choice is kept for every run after that.
2. **Gain staging**: a trim (not the fader) brings every track to the same working level, −18 LUFS
   short-term.
3. **Balance**: the faders follow the genre's table (in pop the vocal leads and the harmony sits 8 dB
   under it, for example). With several tracks in one role, each gets a little less.
4. **Room in frequency**: where two tracks cover each other, the less important one gets a 1–4 dB cut
   at that band (Q 1.2). *"Cut 1.5 dB at 354 Hz on Pad: it was covering Drums."* Everything except the
   kick, drums and bass gets a high-pass an octave under its lowest note.
5. **Sidechain**: in pop, hip-hop and EDM the bass ducks under the kick when they fight over the low end.
6. **Pan**: the kick, bass, lead and vocal stay in the middle. Harmony and texture are spread in mirrored
   pairs, wider or narrower depending on the genre.
7. **Space**: reverb and echo sends by role and genre (wetter in ambient, drier in hip-hop).
8. **Master**: a tilt EQ towards the genre's tonal balance (or the reference's, if *Match the reference*
   is ticked), light glue, width with mono lows, and the limiter at the platform's loudness.

Then it checks the result: if the true peak passes the ceiling it lowers the limiter gain and checks again.

**How much** doses the result: 0 is the song as it was, 100% is the full proposal. The knob **stays
live** after the run. Turn it and the mix follows; when you let go, OpenBand finds the limiter gain for
the target again. The loudness target is a specification, not a taste, so it applies at any dose above 0.
**Listen before** plays the song as it was, raised to the same loudness, so a louder mix can't win just
because it is louder. **Fix** keeps the result, and the knob stops being live. The whole run is a single
undo step. The changes that aren't obvious are also left as comments on the tracks.

Running the pilot again always starts from the song as it was before the last run. It never stacks:
the same settings give the same mix.

## The master chain

The *Master chain* in the mixer runs **EQ** (tilt, shelves, bands) → **glue** compressor → **width**
(mid/side, with everything below *Mono below* in mono) → **true-peak limiter** (4× oversampled, 5 ms
lookahead). The chain is the same live and in every export.

![The master chain in the mixer at −14 LUFS, −1 dBTP](master-chain.png)

**Set loudness** picks a platform and renders the song to find the limiter gain that lands within
±0.3 LU of its target, without passing the ceiling:

| Platform | Loudness | Ceiling |
|---|---|---|
| Spotify, YouTube | −14 LUFS | −1 dBTP |
| Apple Music | −16 LUFS | −1 dBTP |
| SoundCloud | −11 LUFS | −1 dBTP |
| Club | −8 LUFS | −1 dBTP |
| CD | −9 LUFS | −0.5 dBTP |

When a target can't be reached without crushing the music (a sparse song at −9 LUFS, for example),
OpenBand says so and stops at the ceiling.

## Per track: high-pass, cuts, sidechain

In **Effects**, every track has a **high-pass** filter (12 dB/oct) and a **compressor** with
*Sidechain from*: the compressor listens to another track (before its fader, even when that track is
muted), so the bass ducks under the kick. The cuts the pilot makes are peaking bands after the EQ. Like
the high-pass, they work with the EQ off.

![Bass effects with the high-pass and the compressor keyed by the drums](sidechain.png)

## Export for platforms

*Menu → Export for platforms…* produces one zip:

- a **master per platform** at its loudness and true peak, as a 24-bit WAV at 48 kHz. The CD master is
  16-bit at 44.1 kHz with TPDF dither;
- the **instrumental** (everything but the vocal role) and the **a cappella**;
- **stems by role** (drums, bass, harmony, lead, vocal, fx);
- `report.txt`, with LUFS, true peak, LRA and compliance for each platform.

The versions and stems go through the same master chain, with the glue and the limiter **linked** to the
full mix: they apply the same gain reduction as on the master. Add the stems up and you get the master
back, with a residual under −60 dB (−131 dB on the demo song).

![Export for platforms](export-platforms.png)

## For AI clients

| Tool | What it does |
|---|---|
| `mix_pilot` | `amount 0..1, genre, platform, use_reference, scope: mix / master / both` → each change with its reason, the loudness before and after |
| `set_pilot_amount` | turns the dose up or down after a run |
| `fix_pilot` | keeps the result |
| `set_track_role` | `track_id, role` (null = automatic) |
| `set_master_chain` | `eq, glue, width, limiter, platform` |
| `set_track_effects` | adds `eq.hpf` and `compressor.sidechain` |
| `export_for_platforms` | `platforms[], stems, versions: instrumental / acapella, save_to` |

The pilot is also an OMEP engine, *OpenBand Mix Pilot* (`mix.assist`). From the song context alone it
proposes faders, pan, sends and the master target by role, for directors outside OpenBand. See
[Ensemble](ENSEMBLE.md).
