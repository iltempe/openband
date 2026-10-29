# Ensemble: engines that play in OpenBand

🇬🇧 English · 🇮🇹 [Italiano](ENSEMBLE.it.md) · [← README](../README.md)

OpenBand is where the song lives; **engines** play parts of it. An engine can be one of OpenBand's own
algorithms, a music model in your browser or on your computer, one on another computer on your network, or
an online service. They all speak the same open standard, the [Open Music Engine Profile](../omep/README.md) (OMEP),
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
| **Demucs in the browser** | stems: drums, bass, other, vocals | in your browser | MIT (code and weights) |
| **OpenBand Guide voice** | a voice singing the melody on the lyrics (a synthetic guide vocal) | in OpenBand | MIT |
| your engines | whatever they declare | your computer, your network | theirs |

### Adding engines

Engines you install run through the OpenBand server on your computer — the desktop app, `npx …` or the
Claude Desktop extension. List them in `~/.openband/engines.json` (or point `OPENBAND_ENGINES` to another
file), in the same format MCP clients use:

```json
{
  "engines": {
    "ace-step":  { "builtin": "omep-ace-step", "model": "acestep-v15-turbo" },
    "studio-pc": { "url": "https://192.168.1.20:8765/mcp", "token": "…" },
    "mock":      { "builtin": "omep-mock" }
  }
}
```

then press *Refresh* in *Ensemble*. OpenBand only ever starts what is in that file. `"builtin": "omep-mock"`
is the reference engine of the OMEP repository, handy to try the whole chain. Before installing an engine,
check it with `openband omep-conformance -- <its command>`.

### ACE-Step on your computer

[ACE-Step 1.5](https://github.com/ACE-Step/ACE-Step-1.5) (MIT, code and weights; commercial use allowed)
makes whole songs, layers, repaints and restyles locally — under 4 GB of VRAM, also on Apple Silicon (MPS)
or the CPU. OpenBand talks to the REST server ACE-Step ships; you install and start it yourself (OpenBand
doesn't install Python or download weights for you):

```bash
git clone https://github.com/ACE-Step/ACE-Step-1.5 && cd ACE-Step-1.5
uv sync
uv run acestep-api            # http://127.0.0.1:8001; downloads its weights the first time
```

and in `~/.openband/engines.json`: `"ace-step": { "builtin": "omep-ace-step", "model": "acestep-v15-turbo" }`
(add `"url"` if it runs elsewhere, `"env": { "ACESTEP_API_KEY": "…" }` if you set a key). What OpenBand asks:

| You ask | ACE-Step does | What it hears |
|---|---|---|
| a song (`music.song`) | `text2music`: your words, lyrics, tempo, key, length | nothing but the words |
| a layer (`music.add_layer`) | `lego`: the instrument you named (strings, guitar, keys…) — **base models only** (`"model": "acestep-v15-base"`) | the song's mix of those bars |
| a repaint (`transform`) | `repaint` of those bars | that part, with two bars around it |
| a restyle (`transform`, *"make it a bossa nova"*) | `cover` | that part |

What comes back is cut to the bars and conformed like any engine's (tempo, key, level), in the ledger.

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

## Online engines (no GPU needed)

Music models hosted by **fal.ai** work as engines too — the same router, conformance and ledger — for the
price fal charges (ACE-Step: about 0.0002 USD per second of music, so a 30-second layer is about 0.006 USD;
Demucs stem separation: 0.0007 USD per second). The models are listed in `omep/fal-catalog.json`; adding
one is adding an entry there.

- **With the desktop app or the local server**: put your fal key in `~/.openband/engines.json`, it never
  leaves your computer:
  ```json
  { "engines": { "fal-ace-step": { "builtin": "omep-fal", "model": "ace-step", "env": { "FAL_KEY": "…" } } } }
  ```
- **In the online studio**: deploy your own **relay** (a free Cloudflare Worker or Vercel function, a few
  minutes: [deploy/relay](../deploy/relay/README.md)); it keeps the key, the page only knows the relay's
  address and your relay token. Then *Ensemble → Online engines*: the relay, and the models appear.

Before every run you see a **quote** (*"About 0.0032 USD (1 × ACE-Step on fal), from your budget"*);
set a **budget per session and per month** — past it nothing online starts without your OK (the AI has to
ask you, then retry with `confirm_spend`). What each engine cost is logged. Each online engine shows what it
sends (only text, or your song's audio), what the provider keeps, whether inputs are used for training, its
terms and when they were checked; fal's terms for the output are *conditional*, so you accept them once
per engine. OpenBand also brings what an engine returns to a working level (−20 dBFS RMS, as a region gain)
and doesn't place audio that is silent or just noise; clipping is reported.

## Separate stems

Select an audio region and press **Separate stems** in its editor (or ask the AI: `separate`). OpenBand puts
**drums, bass, other and vocals** on their own tracks, right under the original, which is muted — never
removed — and it is one undo step. Stems with nothing in them (a song without vocals) are left out.

<img src="stems.png" alt="A song separated into stems" width="720">

It runs **in your browser** with [HT-Demucs](https://github.com/facebookresearch/demucs) (Meta, MIT):
free, private — the audio never leaves your computer — and offline. The model (166 MB, the
[ONNX export by StemSplit](https://huggingface.co/StemSplitio/htdemucs-onnx), MIT) is downloaded **once,
when you agree**, from Hugging Face; OpenBand checks it against its SHA-256 and keeps it in the browser
(*Ensemble → Stem separation* shows it, and removes it). It takes two to three times the length of the audio
on a typical computer, in the background. With online engines allowed, Demucs on fal can do it too, for its
price; the browser one is always tried first.

**A layer that comes back as a whole mix.** Some audio engines asked for one new layer answer the full mix —
your song plus the new part. OpenBand separates that answer and your song's same bars into stems, keeps the
stems where the answer has something your song doesn't (a spectral difference, stem by stem) and subtracts
what is still your song: the new part lands alone on its track, and the correction says which stems it
kept (*"isolated the new part from the full mix: kept other 82 % new; dropped drums, bass"*).

## Sing

In the **Lyrics** panel, *Sing it* (or the AI: `sing`): a voice sings the melody track on the lyrics aligned
to it, on a new vocal track, as one undo step. OpenBand hands the singer the notes, the syllables on them
with their beats, and — for Italian — their **phonemes**, by rule (*notte‿a Trastevere* → `n o t | t e a |
t r a | s t e | v e | r e`: soft and hard *c* and *g*, *gn*, *gli*, *sc*, voiced *s*, *z*, doubled consonants,
open *è* and *ò*), so singing engines need no language knowledge of their own. Today **OpenBand's guide
voice** sings: a small formant synthesizer, instant and offline — a guide vocal to hear a topline with its
words, not a finished voice. A real singing engine takes over when you install one: the router always puts it first.

### Sing with DiffSinger

[DiffSinger](https://github.com/openvpi/DiffSinger) (openvpi, Apache-2.0) sings with a **voicebank** — you
install both (DiffSinger's own guide; a voicebank is an experiment folder under its `checkpoints/`), then:

```json
"diffsinger": { "builtin": "omep-diffsinger", "repo": "~/DiffSinger", "exp": "my_voice",
                "python": "~/DiffSinger/.venv/bin/python", "languages": ["it"],
                "phonemes": { "E": "e", "O": "o" },
                "voicebank": { "name": "My voice", "license": "CC-BY-4.0", "commercial": "yes", "url": "…" } }
```

OpenBand writes the song as a DiffSinger `.ds` file — phrases, the phonemes with durations that add up to
each note (consonants lead into the note, the vowel sits on it), the pitch curve — and runs the acoustic
model (`scripts/infer.py acoustic`). `phonemes` maps OpenBand's symbols to your voicebank's where they differ
(`lang_prefix` for multilingual banks, `spk` for a speaker). The voicebank's licence is in the engine's
manifest and in the ledger of every part it sings: check it before you release. No Italian voicebank was
found published; any voicebank whose phonemes you can map will do. Without a GPU, run it on a rented one:
[deploy/diffsinger](../deploy/diffsinger/README.md).


## Jam live (real time)

An engine that **plays in real time** — Magenta RealTime 2, or any OMEP engine with `stream.jam` — streams
its audio into an audio track while the transport runs: *AI panel → Live jam*, or `start_live_jam`. It
starts on the next bar, in time with the song, and you steer it as it plays (*style* in words, *intensity*,
the chords — by default the song's own). *Stop and keep* turns what it played into a region from that bar;
another jam from the same bar becomes a **take** of it, to compare and comp. The ledger records the engine
and its licence (Magenta's weights are CC BY 4.0: the attribution goes in the credits by itself).

It keeps time whatever the network does: every 40 ms frame carries the beat it belongs to and is played
exactly there; the latency only decides how far ahead the engine works, and OpenBand raises it at once when
frames arrive with too little margin. The panel shows the latency, the round trip, holes (underruns) and
late frames. Details of the protocol: [OMEP §8](../omep/README.md#8-streaming-streamjam).

### Magenta RealTime 2 on your computer

In a Python of your own (3.11+), as its authors explain:

```bash
uv venv --python 3.12 ~/mrt/.venv && source ~/mrt/.venv/bin/activate
uv pip install "magenta-rt[mlx]"            # Apple Silicon (real time)
# uv pip install magenta-rt "jax[cuda13]"   # NVIDIA
mrt models init && mrt models download mrt2_small
```

and in `~/.openband/engines.json`:
`"mrt": { "builtin": "omep-magenta-rt", "python": "~/mrt/.venv/bin/python", "model": "mrt2_small" }`
(`"backend": "jax"` on NVIDIA; `mrt2_base` needs a Pro/Max-class chip to keep up). MRT2 has no tempo
input: OpenBand gives it the beat as drum onsets (eighths at high intensity; below 0.15 it keeps its own
time) and the chords as a piano roll with an onset on every bar, so it plays along — how tight it sounds is
the model's; the stream itself is always on the beat. If the model is slower than real time on your
machine the panel says so. **Status**: the adapter is tested against a stand-in of the model's worker,
written from magenta-rt 2.0.3's sources; it has not yet been run with the real model.

Online (no OpenBand on this computer) there is no live stream — the network latency of hosted APIs doesn't
allow a jam: use *Jam with the AI* instead, where the AI answers your phrases with MIDI.

## Your taste

Ask for **variants** (2–4) and they come from **different engines** when several can play, as takes of one
region — audio ones too. Compare them in a **blind test**: you hear A, B, C without knowing who played what,
rank them, and only then see the names. What you choose teaches OpenBand: each ranking becomes comparisons
between engines, and a Bradley–Terry model (kept in this browser, never sent) gives each engine a score per
kind of part — and per style once there are enough comparisons for it. The router weighs it more as
comparisons add up: after about ten, *"make drums"* goes to the engine **your** ears prefer for drums, which
can be another than for vocals; two listens or a split decision don't move it. *Ensemble → Your engines*
shows the ranking with the number of comparisons and an interval, and forgets it on request.

## The GPU

Engines on your computer that need a graphics card take turns: one heavy model runs at a time per GPU,
the studio's requests go before background jobs, and when another model has to load the least recently
used one is unloaded (its process stopped, which frees the memory). Tell OpenBand your card's memory in
`~/.openband/engines.json` — `"gpu": { "vram_gb": 12 }` — and models that fit stay loaded together; without
it, one stays loaded at a time. *Ensemble* shows which are loaded, running or waiting, and the router
prefers one already loaded.

## Who played what

Every part an engine made carries a ✦ on its region and an entry in the **contribution ledger**: engine,
version, seed, licence, your request, the context it was made from (a hash of the song) and the corrections.
*Ensemble → Who played what* shows the human / AI share of each track: a region counts as AI while one of the
engine's takes is the active one; record or write your own take and pick it, and it is yours again. The
ledger travels inside the song (`.openband`, exports) and will feed release credits and AI disclosure.

## For AI clients

`create` (describe the part; `variants`, `engine` only when asked), `separate` (an audio region into stems; `confirm_download` only after the user agreed to the one-time download), `list_engines` (engines, routes and
exclusions under the policy), `get_ledger` (contributions and shares), `set_engine_policy`.
