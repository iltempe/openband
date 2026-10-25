# OpenBand relay for online engines

🇬🇧 English · 🇮🇹 [Italiano](#italiano)

The online studio can use music models hosted by **fal.ai** (ACE-Step, Demucs…) without your fal key ever
being in the browser: a small **relay** you deploy on your own account keeps the key as a secret and
forwards the studio's requests. It stores and logs nothing. In the desktop app, or with OpenBand's local
server, you don't need it: put the key in `~/.openband/engines.json` instead (see below).

## Deploy on Cloudflare (free plan)

```bash
git clone https://github.com/iltempe/openband && cd openband/deploy/relay
npx wrangler login
npx wrangler secret put FAL_KEY        # your key from https://fal.ai/dashboard/keys
npx wrangler secret put RELAY_TOKEN    # a long random password you make up
npx wrangler deploy                    # prints https://openband-relay.<you>.workers.dev
```

`wrangler.toml` allows the official studios (`iltempe.github.io`, `www.openband.it`); add yours to
`ALLOWED_ORIGINS` if you self-host.

## Deploy on Vercel

Import `deploy/relay` as a project, then in *Settings → Environment Variables* add `FAL_KEY`,
`RELAY_TOKEN` and (optionally) `ALLOWED_ORIGINS`, and deploy.

## Connect the studio

In the studio: **Ensemble → Policy → Online engines** on, then in *Online engines* paste the relay's
address and your `RELAY_TOKEN`, and save. The fal models appear in the engine list with their price, what
they send and their terms; set a budget per session and per month. Every run shows a quote first, and past
the budget nothing starts without your OK.

## Without a relay: desktop app or local server

```jsonc
// ~/.openband/engines.json
{ "engines": {
    "fal-ace-step": { "builtin": "omep-fal", "model": "ace-step", "env": { "FAL_KEY": "…" } },
    "fal-demucs":   { "builtin": "omep-fal", "model": "demucs",   "env": { "FAL_KEY": "…" } }
} }
```

## What it does

- `POST|GET|PUT /fal/<path>` → `https://queue.fal.run/<path>`, with `Authorization: Key <FAL_KEY>` added.
- `GET /media?url=<fal media URL>` → the audio fal produced (only `*.fal.media` and fal's storage).
- Only requests with header `x-relay-token: <RELAY_TOKEN>` from an allowed origin are answered.
- No logs, no storage, no cookies; upstream headers are not passed back.

---

## Italiano

Lo studio online può usare i modelli musicali ospitati da **fal.ai** (ACE-Step, Demucs…) senza che la tua
chiave fal sia mai nel browser: un piccolo **relay** che pubblichi sul tuo account tiene la chiave come
segreto e inoltra le richieste dello studio. Non salva e non registra nulla. Nell'app desktop, o con il
server locale di OpenBand, non serve: metti la chiave in `~/.openband/engines.json` (vedi sopra).

**Cloudflare (piano gratuito)**: gli stessi comandi della sezione inglese (`wrangler login`,
`wrangler secret put FAL_KEY`, `wrangler secret put RELAY_TOKEN` con una password lunga inventata da te,
`wrangler deploy`). **Vercel**: importa `deploy/relay` come progetto e aggiungi `FAL_KEY`, `RELAY_TOKEN`
(e se serve `ALLOWED_ORIGINS`) nelle variabili d'ambiente.

**Collega lo studio**: in **Ensemble → Politica** attiva *Motori online*, poi in *Motori online* incolla
l'indirizzo del relay e il tuo `RELAY_TOKEN` e salva. I modelli di fal compaiono con il prezzo, cosa
inviano e i termini; imposta un budget per sessione e al mese. Ogni esecuzione mostra prima un preventivo,
e oltre il budget non parte nulla senza il tuo ok.
