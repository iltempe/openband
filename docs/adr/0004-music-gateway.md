# ADR 0004 — A music generation gateway for cloud services and local engines

Status: accepted · 2026-10-30 · implemented in v0.6.43:
- the runtime (`omep/cloud/runtime.mjs`) and the engine (`omep/cloud-engine.mjs`);
- the drivers for Stable Audio (2.5 and 3), ElevenLabs Music, Mureka, Lyria 3.5 / 3 Clip, and declarative
  local model servers;
- each user's keys from the studio, and plan-based rights in the release checks;
- ✦ Generate on every track.

Not yet: fal ported onto it, Lyria RealTime, Lyria 2 on Vertex, the relay for every driver, keys in the
system keychain.

## Context

People who subscribe to a music generation service want to use it from OpenBand, with their own account. We
looked at four services: Mureka, ElevenLabs Music, Stable Audio and Google Lyria. More will follow, and they
should sit next to the engines on the user's own computer (ACE-Step, HeartMuLa, Magenta RealTime 2,
ComfyUI).

**Half of the gateway already exists**, because OMEP (SPEC v0.6 §2) was designed for exactly this:

| Already there | Where |
|---|---|
| One protocol for every engine: manifest, capabilities, Song Context Package in, Contribution out, MCP tasks for long jobs, `stream.jam` for real time | `omep/`, [omep/README.md](../../omep/README.md) |
| Starting and talking to the engines the user configured, the GPU queue | `server/engines.mjs`, `server/scheduler.mjs` |
| Choosing an engine (capability, the user's policy: local first, commercial only, cost; taste), the budget and its confirmation, the ledger | `src/ensemble/` |
| Conforming what comes back (tempo, key, length), as takes, the A/B blind test | `src/ensemble/create.ts`, `conform.ts` |
| One cloud provider done by hand: fal (catalog of models, queue, quote, keys that stay with the user) | `omep/lib/fal.mjs`, `omep/fal-catalog.json` |
| The online studio without a local server: a relay the user deploys on their own account, holding their key | `deploy/relay/` |
| Checking an engine | `omep-conformance` |

What is missing is the layer that makes the fal pattern **generic**: one engine that can speak to many
providers, each with its own auth, request format, sync or queued jobs, audio formats, errors, prices and
licences.

What the providers' own documentation says (read on 2026-10-30; *unconfirmed* marks what their pages didn't
show):

| | Stable Audio | ElevenLabs Music | Mureka | Google Lyria |
|---|---|---|---|---|
| Auth | `Authorization: Bearer` | `xi-api-key` | `Authorization: Bearer` | Gemini API: `x-goog-api-key`; Vertex (Lyria 2): a Google Cloud project with OAuth |
| Jobs | 2.x **synchronous** (multipart → audio bytes); 3.0 **queued** (202 + `GET /v2beta/audio/results/{id}`, kept 24 h) | **synchronous** (`POST /v1/music` → audio bytes); a streaming variant | **queued** (`/v1/song/generate` → task id, `GET /v1/song/query/{id}`), status `preparing → queued → running → (streaming) → succeeded` (or `failed`, `timeouted`, `cancelled`) | Lyria 3 / 3.5: one request (`/v1beta/interactions`), base64 MP3; **RealTime: WebSocket**, 16-bit PCM 48 kHz stereo |
| Can do | text-to-audio (≤190 s; 3.0 ≤380 s), **audio-to-audio** (`strength`), **inpaint** (`mask_start`/`mask_end`) | songs from a prompt or a **composition plan** (sections with durations, styles, lyric lines), inpainting and extending through a stored `song_id` | songs from lyrics and prompt, instrumentals, extend, **stems**, reference/vocal ids; many models (`mureka-7.5`…`9.5`, `o1`, `o2`) | Lyria 3.5: full songs; 3 Clip: 30 s; Lyria 2: 32.8 s instrumental clips; **RealTime**: bpm, scale, density, brightness, mute bass/drums, weighted prompts |
| Output | mp3 or wav, 44.1 kHz stereo | mp3, pcm (`pcm_48000`), opus; WAV through this endpoint unconfirmed | `url`, `flac_url`, `wav_url`, valid for 30 days; `lyrics_sections` with the timings of every line and word | MP3 (WAV option for 3.5 unconfirmed); Lyria 2 WAV 48 kHz |
| Price | 8 credits = $0.08 per generation (2.5 and 3.0); failures not charged | ~900 credits per minute, from the user's plan; API from Starter up | prepaid API balance, separate from the website; per-song price not published; `n` defaults to 2 and each song is charged | Lyria 3.5 / 3 Pro $0.08 per song, 3 Clip $0.04; RealTime and Vertex prices not found |
| Rights | outputs owned by the user; don't present them as human-made; keep provenance | commercial use except film/TV/radio on self-serve plans; **streaming distribution not allowed on Free and Starter**; attribution on Free; no artist names, song titles or lyrics in prompts | commercial use for paid API calls; terms of service not located | always watermarked (SynthID) for RealTime and Lyria 3; commercial terms not checked |
| Limits worth knowing | **English prompts only** (422); **rejects audio it recognizes as copyrighted** (422); 150 requests / 10 s | concurrency 2 on Starter–Pro; `bad_prompt` with a suggested prompt | 403 from unsupported regions; concurrency by top-up tier | RealTime: changing bpm or scale needs a context reset (a hard transition); instrumental only |

## Decision

Build the gateway as **one OMEP engine, `omep-cloud`, with a driver per provider**, and keep everything
above it as it is. To the studio, a cloud service is one more OMEP engine. It is routed, budgeted,
conformed and recorded in the ledger like a local one. The router puts local and cloud engines side by
side, under the user's policy.

```
 studio (page)                         local OpenBand (Node)                          providers
 ─────────────                         ─────────────────────                          ─────────
 create / transform / live jam ──┐
 router · budget · ledger        │     EngineHost ─┬─ omep-ace-step, omep-heartmula,  (on this computer)
 conform · takes · A/B           ├────▶            │  omep-magenta-rt, omep-comfyui
                                 │     (bridge)    ├─ omep-cloud --provider stability ──▶ api.stability.ai
                                 │                 ├─ omep-cloud --provider elevenlabs ─▶ api.elevenlabs.io
                                 │                 ├─ omep-cloud --provider mureka ─────▶ api.mureka.ai
                                 │                 ├─ omep-cloud --provider lyria ──────▶ generativelanguage.googleapis.com
                                 │                 └─ omep-cloud --provider fal ────────▶ queue.fal.run   (today's omep-fal, ported)
 online studio, no local server ─┴──▶ the user's relay (deploy/relay/) ──▶ the same drivers' requests, key added by the relay
```

### The driver: what a provider is

A driver is one module, `omep/cloud/drivers/<provider>.mjs`, with no Node-only APIs (only `fetch`), so it
runs in the local engine and, through the relay, in the online studio:

```js
export default {
  id: 'stability', name: 'Stable Audio', homepage: 'https://stability.ai',
  auth: { env: 'STABILITY_API_KEY', headers: (key) => ({ authorization: `Bearer ${key}` }) },
  hosts: ['api.stability.ai'],                    // the only hosts the runtime and the relay will call
  models: [/* each: id, name, capabilities (with conditioning, max_seconds), pricing, license, output_rights, data_policy, limits */],
  rights(model, account) {},                      // licence / output rights for the user's plan (see Rights)
  quote(model, capability, scp, request) {},      // → { usd, basis, verified } before running
  plan(model, capability, scp, request, seed, ctx) {}, // → a Job: { method, path, body: json|multipart, accept, mode: 'sync'|'queued'|'stream' }
  parse(model, response) {},                      // sync: the audio; queued: { task }
  poll(model, task) {},                           // → a request; then status(response) → { state, progress?, outputs?, error? }
  cancel(model, task) {},                         // optional
  error(status, body, headers) {},                // → a GatewayError (below)
  stream: { open(), control(), close() },         // optional: real-time providers (Lyria RealTime) → OMEP stream 1.0
};
```

The **runtime** (`omep/cloud/runtime.mjs`) does what every provider needs, once:
- the MCP server and manifest, one tool per capability, and MCP tasks with progress and cancellation;
- HTTP with timeouts, retries with backoff on 429/5xx (honouring `Retry-After`), and a concurrency limit
  per provider from the plan the user declared, since ElevenLabs allows 2 at once on most plans;
- polling queued jobs, or the request itself for synchronous ones;
- normalising outputs: MP3/WAV/FLAC/OGG as files, raw PCM (ElevenLabs `pcm_48000`, Lyria) wrapped into
  WAV, every file `file://` in the Contribution, audio types only, size limits;
- provenance (provider, model, the provider's request or trace id, seed) and `cost_usd`;
- errors normalised to one shape.

Simple JSON-over-REST providers can be written **declaratively**, as the fal catalog and the ComfyUI
mapping already are: endpoint, input template, output path. Providers with composition plans, multipart
bodies or WebSockets get code. Both kinds use the same runtime.

### From the song to each provider (the "brief")

One shared builder turns the Song Context Package into what music services take, and each driver picks
what it can use:
- **style text**: the request, the intent, the soft style constraints;
- **tempo and key in words** ("92 bpm, D minor"), for providers without fields for them;
- **sections with their durations**, from the scope's bars at the song's tempo;
- **lyrics with section markers** (`[Verse]`…);
- **negative prompts**.

What each provider gets:
- **ElevenLabs**: the song's sections become a **composition plan**, one chunk per section with
  `duration_ms` from its bars, the lyric lines of that section and the styles. The parts come back the
  length the arrangement needs, instead of one long song cut afterwards. Repaint and extend use a stored
  `song_id`.
- **Stable Audio**: an English prompt, the duration, and the seed. Restyle is audio-to-audio with
  `strength`, repaint is inpaint with `mask_start`/`mask_end`.
- **Mureka**: lyrics with markers, a prompt, the model, and `n` for variants. Stems map to
  `audio.separate`.
- **Lyria 3.5**: a prompt; the length is controlled through the prompt. **Lyria RealTime**: weighted
  prompts, `bpm` from the song, `scale` from its key, density from intensity. It becomes a `stream.jam`
  engine on OMEP stream 1.0, so the live jam (E5) gets a cloud engine; the stream's beat stamping keeps
  it on time.

**Prompt rules before sending**:
- ElevenLabs forbids artist names, song and album titles and lyrics of existing songs in prompts;
- Stable Audio takes only English prompts;
- the driver checks what it can and turns the provider's refusals (`bad_prompt` with its suggested
  prompt, `content_moderation`, `copyrighted_content`) into a message that says what to change, with the
  suggestion when there is one.

### Rights, money and data

- **Rights depend on the user's plan.** In engines.json the user can say which plan they have, for example
  `"plan": "creator"`. `rights()` then gives the licence the ledger records. The release checks (G6) use
  it: a song with an ElevenLabs Starter part is flagged before publishing to streaming platforms.
  Attribution on free plans goes in the credits by itself. Without a declared plan, rights are recorded
  as `conditional`, with "check your plan" as the condition. Outputs that are always watermarked (Lyria)
  are recorded as watermarked.
- **Costs**: every model quotes before running, through the existing budget, with its confirmation and
  limits per session and per month. Prices the provider doesn't publish are marked as estimates, as fal's
  already are. What a run really cost is recorded when the provider says it.
- **Credit and quota errors** (402, Mureka's quota 429, ElevenLabs' plan caps) say "your *X* account is out
  of credits", not "request failed".
- **Data**: each model's `data_policy` says whether the song's audio is uploaded (restyle, repaint, extend,
  stems), and the router's existing rule ("no audio leaves this computer") applies. Stable Audio's
  copyright detector may refuse context audio, and the message says so.

### Keys and accounts

Each user's own, never shared, never in the code, the song or the page:
- local engines read them from `~/.openband/engines.json` (`"env": { "ELEVENLABS_API_KEY": "…" }`), on
  that computer only. Later: the system keychain (macOS Keychain, Windows Credential Manager, libsecret);
- the online studio goes through the user's own relay, which keeps the keys as its secrets and forwards
  only to the driver's `hosts`;
- WebSockets (Lyria RealTime) can be relayed on Cloudflare Workers, not on Vercel functions. The README
  says which deployment can do what;
- Vertex AI (Lyria 2) needs a Google Cloud project and OAuth or a service account, which is heavier for a
  musician. It is optional, after the Gemini API ones.

### Errors, one shape

`GatewayError { code, provider, message, retryable, retry_after_s?, suggestion?, request_id? }`, where `code`
is one of: `auth`, `credits`, `rate`, `moderation`, `copyright`, `language`, `region`, `bad_request`,
`unavailable` or `timeout`. The studio shows `message` and `suggestion`. The runtime retries only what is
`retryable`, within the budget it was given.

### Adding a provider later

Adding a provider means:
1. writing a driver file (or a declarative entry);
2. adding a fake server in `omep/fixtures/` built from the provider's documented requests and answers;
3. registering it in engines.json's builtins (`"builtin": "omep-cloud", "provider": "…"`).

It is accepted when `omep-conformance` passes against the fake server, in CI. **CI never uses real keys.**
An opt-in script, `openband gateway-check <provider>`, lets a user try their own key. It quotes first and
runs one short generation only after they confirm.

## Phases

1. **The runtime and the driver interface.**
   - Port `omep-fal` onto it. Nothing changes for users, which proves the interface.
   - Add **Stable Audio**: it is the best documented, synchronous and cheap, and covers song, restyle and
     repaint.
2. **ElevenLabs**, with composition plans from sections and plan-based rights; then **Mureka**, after
   reading its OpenAPI spec, which the documentation renders with JavaScript (status values and output
   fields are still unconfirmed).
3. **Lyria 3.5** through the Gemini API; **Lyria RealTime** as a `stream.jam` engine; Lyria 2 on Vertex if
   asked.
4. **The relay**, generalized to every driver's hosts, for the online studio; keys in the system keychain.

Each phase is a release, with docs, a UI for the keys and the plan (in *Ensemble → Online engines*), and
fake servers in the tests.

## To verify before building each driver

- **Stable Audio**: whether 2.x can also answer with a job id (its FAQ hints at it, its API reference
  doesn't); 3.0's audio-to-audio and inpaint pages; deprecations of 2.x.
- **ElevenLabs**: the REST paths of the detailed, stream, plan and upload variants; WAV output; the real
  maximum length (5 or 10 minutes); the response header with the song id; which limit binds, credits or
  the plan's minutes.
- **Mureka**: prices and the terms of service. The operation pages were read rendered: `song/generate`
  (lyrics ≤5000, model `auto`, `mureka-7.6`, `o2`, `8`, `9`, `9.5`; `n` ≤3; `duration` 120–300 s for 9.5 only),
  `song/query` (statuses, choices), `instrumental`, `song/extend`, `song/stem` (mp3/m4a, ≤10 MB) and
  `files/upload` (purposes and lengths).
- **Lyria**: the commercial terms of the Gemini API and Vertex; RealTime's real sample rate (the docs say
  48 kHz, an example uses 44.1); WAV for 3.5; prices of RealTime and Vertex; error shapes; EU
  availability.

## Consequences

- The studio doesn't change. Routing, budget, conformance, takes, A/B, ledger, release checks and the live
  jam apply to every provider as soon as its driver exists.
- Provider differences live in one file each. A provider changing its API breaks one driver, which its fake
  server and conformance catch.
- Using these services costs the user money on their own account, under the provider's terms, which can
  change. The manifest records when prices and terms were checked, as fal's catalog already does.
- Suno and Udio fit the same interface the day they publish an official API. Unofficial wrappers based on
  session cookies are out: they break the services' terms and put the user's account at risk.
