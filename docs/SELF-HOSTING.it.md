# Ospitare il proprio OpenBand

🇬🇧 [English](SELF-HOSTING.md) · 🇮🇹 Italiano · [← README](../README.it.md)

Lo studio è un'app statica, quindi gira ovunque: per una scuola, una community o per te:

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/iltempe/openband) [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/iltempe/openband)

- **GitHub Pages dal tuo fork:** fork → *Settings → Pages → Source: GitHub Actions* → *Settings → Secrets and variables → Actions → Variables*: `OPENBAND_DEPLOY = true`. I fork non pubblicano finché non lo attivi.
- **Cloudflare Pages:** collega il repository con il preset *Vite* (build `npm run build`, output `dist`), oppure `wrangler pages deploy dist`.
- **Docker** (NAS, Raspberry Pi, server della scuola; amd64 e arm64): da un clone, `docker compose up -d --build` con il `docker-compose.yml` incluso, oppure `docker build -t openband . && docker run -p 8080:7777 openband` (stanze multiplayer attive, healthcheck su `/version.json`).
- **Impostazioni senza ricompilare:** metti un `config.json` accanto a `index.html` (o indica con `OPENBAND_CONFIG` un file in Docker): nome dell'istanza, lingua predefinita, funzioni da disattivare (chat nel browser, plugin, stanze), URL del catalogo plugin, server di collaborazione. Vedi [`config.example.json`](../config.example.json).
- Ogni host riceve gli stessi header: asset in cache per sempre, pagina e service worker mai, e una Content-Security-Policy (`server/csp.mjs`) che permette alla pagina di raggiungere solo il bridge sul computer dell'utente, l'API Anthropic, il catalogo plugin e i server di collaborazione. Un'istanza statica non salva nulla: le canzoni restano nel browser di chi la usa. L'isolamento cross-origin (COOP/COEP, per un futuro uso di `SharedArrayBuffer`) non è ancora attivo.

## Suonare insieme

- **Nella stessa rete** (il modo più veloce): avvia il server MCP con `OPENBAND_COLLAB=1`; servirà anche lo studio e un relay per le stanze sul tuo indirizzo di rete locale (stampato all'avvio; il bridge dell'AI resta raggiungibile solo da questo computer). Apri una stanza con *In questa rete* e manda il link.
- **Peer to peer**: *Peer to peer* collega direttamente i browser con WebRTC; il link apre la demo online. I partecipanti si trovano tramite un server di signaling: quello di OpenBand (`/signal` su un server avviato con `OPENBAND_COLLAB=1`) o quello pubblico di y-webrtc, e puoi indicarne uno tuo con `?signal=wss://…` (viaggia con il link). I server di signaling pubblici vanno e vengono: per sessioni affidabili via internet usane uno sotto il tuo controllo.
- La password cifra il traffico peer to peer e separa stanze con lo stesso nome; mandala a parte rispetto al link.

## claude.ai come client (MCP remoto)

Un OpenBand self-hosted avviato con `OPENBAND_REMOTE_MCP=1` parla MCP anche via Streamable HTTP su `/mcp`, quindi si può aggiungere in claude.ai da *Impostazioni → Connettori → Aggiungi connettore personalizzato* (anche dal telefono):

```
claude.ai ──HTTPS · MCP──▶ https://music.example/mcp ──WebSocket──▶ la scheda OpenBand dell'utente
```

1. Avvialo: `docker run -p 8080:7777 -e OPENBAND_REMOTE_MCP=1 -e OPENBAND_REMOTE_TOKEN=<una stringa casuale lunga> openband` (l'immagine costruita sopra), dietro HTTPS (Caddy, nginx… che inoltrano l'header `Host`).
2. In claude.ai aggiungi il connettore `https://music.example/mcp?token=<il token>`.
3. Apri lo studio → **AI** → scheda *Claude (remoto)*: la scheda mostra un codice di 6 cifre. Di' a Claude «abbinati a OpenBand, codice 395 337» (oppure aggiungi `&pair=<codice>` all'URL del connettore).

<img src="remote-mcp.png" alt="La scheda Claude (remoto) con l'URL del connettore e il codice di abbinamento" width="300">

Il server fa solo da ponte e non conserva nulla: le canzoni restano nella scheda. Ogni sessione MCP comanda solo la scheda con cui si è abbinata — le altre schede, anche sullo stesso server, per lei non esistono — e nessuno strumento funziona prima dell'abbinamento (`pair_studio`). I codici cambiano ogni 10 minuti e valgono una volta sola; 5 codici sbagliati per sessione in un minuto (30 fra tutte le sessioni) bloccano l'abbinamento per un minuto; le chiamate sono limitate per sessione (60 ogni 10 s) e le sessioni inattive finiscono dopo 30 minuti. In questa modalità i file si importano solo da URL http(s) pubblici (mai percorsi locali, mai indirizzi della rete del server) e gli export non hanno `save_to`: il file si scarica nella scheda. Chiudere o ricaricare la scheda chiude l'abbinamento. `OPENBAND_REMOTE_TOKEN` è facoltativo ma caldamente consigliato su un indirizzo pubblico: senza, chiunque conosca l'URL può aprire sessioni (gli serve comunque un codice da una scheda).
