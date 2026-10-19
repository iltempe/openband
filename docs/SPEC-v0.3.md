# OpenBand — Specifica v0.3 "Quello che nessuna DAW ha"

> Per Claude Code. Salvala in `docs/SPEC-v0.3.md`. Si appoggia a quanto già implementato fino a **F14 + F13** (commit `78fcfbd`): transazioni, schema v2, eventi, renderer, analisi, lint, struttura, armonia, lyrics, mic/hum-to-MIDI, take/A-B, versioni, annotazioni.
> **Valgono tutte le regole della sezione 0 di `docs/SPEC.md`**: comandi in `commands.ts` condivisi tra UI e MCP, logica pura testabile separata, DSP nei worker, i18n IT/EN, Definition of Done, una feature per PR.
> Numerazione in continuità: F15–F16 sono le due rimaste dalla v0.2, da F17 in poi sono nuove. Le nuove nascono dalla ricerca sulle richieste degli utenti che nessuna DAW soddisfa. Il **blocco D** (D1–D8) riguarda deploy e primo uso, e va fatto per primo.

## Ordine consigliato

> **Prima di tutto il blocco D (deploy e primo uso)**: ogni altra feature vale zero se l'utente si arrende all'installazione. D1, D2, D3 e D6 vanno fatti prima del lancio sui gruppi.

| # | Feature | Perché | Peso |
|---|---|---|---|
| D1 | `npx openband`: zero clone, zero build | Oggi servono git, npm install e un percorso assoluto nel JSON di config | M |
| D2 | Bundle `.mcpb` per Claude Desktop (installazione con un doppio clic) | Niente JSON da modificare a mano, Node incluso in Claude Desktop | S |
| D3 | La demo online può parlare con l'AI (pairing sicuro) | Oggi la demo su GitHub Pages è "muta" verso l'AI | M |
| D4 | AI integrata con la propria API key (zero installazione) | Usare l'AI senza installare nulla | M |
| D5 | PWA installabile e offline | Si apre come un'app, si associa ai file `.openband` | S |
| D6 | Primo avvio guidato: "la tua prima canzone in 60 secondi" | Il primo uso decide se l'utente torna | M |
| D7 | Diagnostica, `doctor` e segnalazione bug con un clic | Meno issue del tipo "non funziona" | S |
| D8 | Release, versioning e avviso di aggiornamento | Per chi usa npx o `.mcpb` | S |
| D9 | Self-hosting con un clic (Pages per i fork, Netlify/Vercel/Cloudflare, Docker) | Scuole, community, chi vuole la propria istanza | S |
| D10 | Server MCP remoto (Streamable HTTP) con pairing: claude.ai web e mobile come client | L'AI senza nessuna installazione locale | L |
| F18 | Marcatori di errore in registrazione | Richiesta classica, fattibile in mezza giornata | S |
| F19 | Undo totale (stato dei plugin incluso) | Nessuna DAW lo fa per i parametri non automatizzabili | M |
| F20 | Essenziali di monitoring (LUFS live, mono, polarità, bypass a volume pareggiato) | Le DAW lo lasciano ai plugin di terze parti | M |
| F21 | Rete di sicurezza (journal, recupero, "macchina del tempo") | Nessuno perde lavoro, mai | M |
| F17 | Import/export DAWproject | Ponte con Bitwig, Studio One/Fender Studio Pro, Cubase | L |
| F22 | Automazione dei parametri di effetti e plugin | Roadmap | M |
| F15 | Call-and-response live (jam) | Rimasta dalla v0.2 | M |
| F23 | Time-stretch e pitch-shift delle clip audio | Roadmap | L |
| F24 | Drummer generativo + libreria loop CC0 | Roadmap | L |
| F25 | Registrazione multi-input, punch-in e pre-roll | Roadmap | M |
| F16 | Multiplayer Yjs con l'AI come peer | Rimasta dalla v0.2. Audiotool 3.0 lo fa già nel browser, qui la differenza la fanno versioni e AI che ascolta | XL |
| F26 | App desktop Tauri con host VST3/CLAP (esplorativa) | Roadmap | XL |

---

# Blocco D — Deploy e primo uso

**Oggi** per far suonare OpenBand all'AI servono: git clone → npm install → npm run dev (oppure build) → modificare `claude_desktop_config.json` con un percorso assoluto → riavviare Claude → cliccare "Enter the studio". Sono sei passaggi e almeno due sono da sviluppatore.
**Obiettivo**: con l'AI, **massimo 2 passaggi**; senza AI, **0 passaggi** (link alla demo).

I percorsi da offrire, in ordine di semplicità:

| Utente | Percorso | Passaggi |
|---|---|---|
| Curioso | Apre la demo online | 0 |
| Ha una API key | Demo online → "Collega Claude" → incolla la chiave (D4) | 1 |
| Usa Claude Desktop | Scarica `openband.mcpb` → doppio clic (D2) | 2 |
| Usa Claude Code, Cursor o altri | `claude mcp add openband -- npx -y openband mcp` (D1) | 1 |
| Sviluppatore | git clone (come oggi) | n |

## D1 · `npx openband`: niente clone, niente build

- **Pubblica su npm** il pacchetto `openband`, con `dist/` già buildato dentro (`files: ["dist", "server", "scripts", "bin"]`) e un `prepublishOnly` che esegue typecheck, test e build.
- **Un solo binario** `bin/openband.mjs` con sottocomandi:
  - `npx openband` (o `openband start`): avvia server HTTP + bridge sulla porta 7777 (se occupata cerca automaticamente la successiva libera e la passa all'app con `?mcp=`), serve `dist/` e apre il browser.
  - `openband mcp`: modalità stdio per i client MCP (quella di oggi), con studio servito da `dist/` e aperto automaticamente alla prima chiamata a un tool, senza bisogno di `open_studio`.
  - `openband setup`: rileva i client installati (Claude Desktop, Claude Code, Cursor, VS Code) e **scrive la configurazione al posto dell'utente**, dopo conferma interattiva, con backup del file originale (`.bak`). Per Claude Code esegue `claude mcp add` se la CLI è presente.
  - `openband doctor`: vedi D7.
  - `openband --version`.
- **Config MCP senza percorsi assoluti**:
  ```json
  { "mcpServers": { "openband": { "command": "npx", "args": ["-y", "openband", "mcp"] } } }
  ```
- **Requisiti**: Node ≥ 18, controllato all'avvio con un messaggio chiaro ("Serve Node 18+. Scaricalo da nodejs.org, oppure usa l'estensione .mcpb che non richiede nulla").
- **Dipendenze di runtime minime**: solo `@modelcontextprotocol/sdk`, `ws`, `zod`. React, Tone e il resto finiscono nel bundle di `dist/`, quindi tra le devDependencies. `npx` deve partire in pochi secondi.
- README: la Quick start diventa una riga sola; il git clone scende nella sezione "Contribuire".

**Accettazione**: in CI, su una matrice ubuntu/macos/windows con Node 18/20/22, `npm pack` → install del tarball in una cartella vuota → `openband mcp` risponde a `initialize` e `tools/list` via stdio (test con il client dell'SDK MCP) e `openband start` serve `index.html` con 200.

## D2 · Estensione Claude Desktop (`.mcpb`)

Il formato MCP Bundle (`.mcpb`) è uno zip con il server MCP e un `manifest.json`. Si installa in Claude Desktop con un doppio clic, trascinandolo nella finestra o da Settings → Extensions. Per i server Node, Node è già incluso in Claude Desktop su macOS e Windows.

- `mcpb/manifest.json`: nome, descrizione, icona 512×512 (`icon.png`), `server.type: "node"`, entry `server/mcp-server.mjs`, `compatibility.platforms: ["darwin","win32"]`, elenco dei tool (generato dallo script dagli stessi `tool(...)` del server, per non disallinearli), più `user_config`:
  - `port` (numero, default 7777);
  - `open_browser` (boolean, default true): apre lo studio alla prima chiamata;
  - `samples_folder` (directory, opzionale): cartella da cui l'AI può importare suoni con percorsi relativi.
- Il bundle include `dist/` già buildato e `node_modules` di produzione. Il server serve lo studio da `http://127.0.0.1:<port>`.
- Script `npm run pack:mcpb` → `npx @anthropic-ai/mcpb pack` → `openband-<version>.mcpb`.
- La GitHub Action di release (D8) allega il `.mcpb` alla Release. Nel README c'è un grande pulsante "⬇ Scarica per Claude Desktop" con la GIF dei due passaggi.
- Tutti i tool devono avere le annotations corrette (`readOnlyHint`, `destructiveHint` per delete/new_project/import con replace, `openWorldHint` per l'import da URL e il catalogo plugin). Serve sia alla qualità sia a un'eventuale futura sottomissione alla directory.

**Accettazione**: `mcpb pack` senza errori; un test automatico estrae il bundle, lancia il server con `node` e verifica `tools/list`; test manuale documentato su macOS e Windows (checklist nella PR).

## D3 · La demo online parla con l'AI locale (pairing sicuro)

Oggi il bridge accetta solo pagine servite da localhost, quindi la demo su GitHub Pages non può collegarsi all'AI. Si sblocca **senza aprire il bridge a qualunque sito**:

- **Allowlist di origin**: oltre a localhost, il server accetta l'origin ufficiale `https://iltempe.github.io` (configurabile con `OPENBAND_ALLOWED_ORIGINS`), **solo con pairing**.
- **Pairing a codice**: all'avvio il server genera un codice di 6 cifre valido 10 minuti e lo stampa nel log stderr. In Claude Desktop lo restituisce anche il tool `open_studio` ("Inserisci il codice 482-913 nella demo"). La pagina invia `{type:'hello', pair:'482913'}`; se il codice è giusto il server risponde con un **token di sessione** (32 byte casuali) che la pagina salva in `sessionStorage`. Le riconnessioni usano il token, e il token viene revocato quando il server si riavvia. Da localhost il pairing non serve (comportamento di oggi).
- **Rate limit**: 5 tentativi di pairing al minuto, poi blocco per 5 minuti.
- **Compatibilità dei browser** (va gestita in UI, non ignorata):
  - Chrome sta introducendo il permesso "Local Network Access" per le richieste da siti pubblici verso localhost e la rete locale: il prompt arriva con Chrome 142 e i WebSocket saranno sottoposti allo stesso controllo in una fase successiva. L'UI deve dire prima all'utente "il browser ti chiederà il permesso di accedere ai dispositivi locali: rispondi Consenti". Se la connessione fallisce, mostra le istruzioni per riattivarlo dalle impostazioni del sito.
  - Safari e Firefox vanno verificati sul campo. Se un browser blocca `ws://127.0.0.1` da HTTPS, fallback: pulsante "Apri lo studio locale" che porta a `http://127.0.0.1:<port>` (servito da D1/D2), **con il progetto corrente passato nell'URL fragment** (compresso con `fflate`, base64url, o via `postMessage` se troppo grande) per non perdere il lavoro.
- **UI "Collega AI"** nel pannello AI della demo: wizard a 3 schede (Claude Desktop → scarica `.mcpb`; Claude Code/Cursor → comando da copiare; API key → D4). Lo stato della connessione è sempre visibile e ogni errore è diagnosticato in linguaggio umano (server non avviato, porta diversa, permesso negato, codice scaduto).

**Accettazione**: test del server: un origin non in allowlist viene rifiutato; un origin in allowlist senza codice viene rifiutato; codice sbagliato 5 volte → blocco; codice giusto → token; token valido alla riconnessione e invalido dopo il riavvio.

## D4 · AI integrata con la propria API key (zero installazione)

Per chi non vuole installare nulla: l'agente gira **nel browser** e chiama direttamente i comandi (`runCommand`), senza bridge né server.

- **Provider**: Anthropic Messages API chiamata dal browser. L'API supporta le richieste CORS dal client con l'header `anthropic-dangerous-direct-browser-access: true`. Il nome "dangerous" è un avvertimento esplicito: la chiave è visibile a chi controlla il browser, ed è accettabile solo perché è dell'utente stesso, sul suo dispositivo. Interfaccia astratta `LLMProvider` per aggiungere altri provider in seguito (OpenAI-compatibile, modelli locali con Ollama su localhost).
- **Strumenti**: gli stessi del server MCP. Estrai le definizioni (nome, descrizione, schema zod) in `src/ai/tools.ts`, condiviso da `mcp-server.mjs` e dall'agente in-browser, così c'è **una sola fonte**. Gli `INSTRUCTIONS` diventano il system prompt.
- **Loop agentico** (`src/ai/agent.ts`): messaggio utente → risposta con `tool_use` → `runCommand` → `tool_result` → … fino a `end_turn`. Ogni turno utente è una transazione F1 (`begin_change` automatico con il testo della richiesta come label). Limiti: massimo 40 tool call per turno e un pulsante **Stop** sempre visibile. Le immagini (spettrogramma) passano come blocchi immagine.
- **Chiave**: salvata solo in locale (IndexedDB, mai nel progetto né nei bundle `.openband`), con il pulsante "Dimentica chiave". Avviso chiaro che le richieste vanno da browser a provider e che OpenBand non vede nulla. Stima del costo per turno (token in/out) mostrata nella UI.
- **Chat UI** nel pannello AI: input testuale, streaming delle risposte, comandi eseguiti raggruppati sotto ogni messaggio (riusa il log del bridge), suggerimenti di prompt iniziali ("Fammi un beat lo-fi a 82 BPM", "Analizza il mio mix", "Scrivi un ritornello su questo giro").
- La modalità MCP esterna resta quella principale e "pro". D4 è la porta d'ingresso.

**Accettazione**: test dell'agente con un provider mock (sequenza di tool_use → comandi eseguiti → una sola entry di history); la chiave non compare mai in export e localStorage del progetto (test che fa grep sull'export).

## D5 · PWA installabile e offline

- `manifest.webmanifest` (nome, icone, `display: standalone`, colori del tema) + service worker (Workbox o uno scritto a mano, piccolo): precache di `dist/` con strategia cache-first per gli asset versionati e network-first per l'index. I plugin WAM e i loop sono in cache runtime dopo il primo uso.
- **File Handling API** (`file_handlers`) per aprire `.openband`, `.mid` e `.dawproject` con doppio clic dove supportato (Chrome/Edge desktop); **Launch Handler** per riusare la finestra già aperta.
- Pulsante "Installa OpenBand" discreto nel menu ⋯ (evento `beforeinstallprompt`), con istruzioni per Safari ("Condividi → Aggiungi al Dock").
- Funzionamento completo offline per tutto ciò che non richiede la rete (synth, editing, export, analisi).

**Accettazione**: Lighthouse PWA installabile; test Playwright offline (contesto con `offline: true` dopo il primo caricamento) → l'app si apre e suona la demo.

## D6 · Primo avvio guidato: "la tua prima canzone in 60 secondi"

Lo schermo iniziale di oggi ("Enter the studio") diventa un **onboarding che è già musica**:

1. **Benvenuto con una scelta, non con un tutorial.** Lo stesso clic sblocca anche l'audio (gesto utente) con 4 card grandi:
   - 🎲 **"Sorprendimi"**: genera all'istante, senza AI, un loop di 8 battute (Drummer F24 se c'è, altrimenti pattern dai preset + `add_chord_progression` su un giro casuale tra 12 in tonalità casuale) e lo fa partire. Il primo suono arriva in meno di 2 secondi.
   - 🎤 **"Canticchia un'idea"**: hum-to-MIDI (F11) → melodia con accompagnamento automatico.
   - 🤖 **"Chiedi all'AI"**: apre il wizard "Collega AI" (D3/D4) con un prompt d'esempio già scritto.
   - 📂 **"Apri un file"**: `.openband`, MIDI, DAWproject, oppure drag&drop.
   In più: "Riprendi l'ultimo progetto" se c'è un autosave, e "Progetti d'esempio".
2. **Galleria di template** (`src/templates/`): 8 progetti piccoli e curati (lo-fi, pop ballad, trap, house, rock, bossa, cantautore chitarra+voce, colonna sonora ambient). Ognuno ha sezioni, testo segnaposto e annotazioni F14 che spiegano le scelte. Così il teach mode diventa anche il tutorial.
3. **Tour contestuale leggero** (massimo 5 tappe, saltabile, non bloccante): Play/Loop → doppio clic per creare una regione → piano roll → mixer → pannello AI. Si basa su **azioni reali** (la tappa successiva parte quando l'utente compie l'azione), non su "Avanti, Avanti". Lo stato del tour è salvato in localStorage, con la voce "Rivedi il tour" nel menu.
4. **Empty state utili ovunque**: arrangiamento vuoto con 3 pulsanti (Aggiungi batteria / Aggiungi strumento / Trascina un file); pannello Problemi vuoto con "Nessun problema 🎉"; pannello AI non collegato con il wizard.
5. **Controllo dispositivi al primo avvio** (non bloccante): latenza dell'output stimata, MIDI collegato ("Ho trovato: Arturia KeyLab 49 ✓"), microfono solo quando serve. Avvisi in chiaro ("Latenza alta: chiudi le altre schede audio o usa Chrome").
6. **Scorciatoie scopribili**: `?` apre il cheat sheet; ogni tooltip mostra la propria scorciatoia.
7. **Metriche di successo misurate solo in locale** (nessuna telemetria): tempo dal caricamento al primo suono e al primo export. Mostrate nella pagina "Diagnostica" per i tuoi test, mai inviate.

**Accettazione**: test Playwright: dalla pagina vuota a "Sorprendimi" all'audio in riproduzione (transport `playing`) in meno di 3 s su CI; il tour avanza solo con le azioni giuste; tutte le stringhe in IT ed EN.

## D7 · Diagnostica, `doctor` e bug report con un clic

- `openband doctor` (CLI): versione di Node, porta libera o occupata (e da chi, se rilevabile), presenza di `dist/`, client MCP configurati e se puntano a una versione valida, test di connessione al bridge, versioni dei pacchetti. Output con ✓/✗ e una correzione suggerita per ogni ✗.
- **Pagina "Diagnostica"** nell'app (menu ⋯): browser e versione, stato dell'AudioContext, sample rate, latenza base/output, stato del bridge con l'ultimo errore, permessi (microfono, MIDI, LNA), spazio IndexedDB usato/disponibile, plugin WAM caricati e falliti, ultime 50 voci del log degli errori JS.
- **"Segnala un problema"**: apre una issue GitHub precompilata (URL `issues/new?template=bug.yml&…`) con la diagnostica in un blocco `<details>`, **senza** dati del progetto né chiavi, e un'anteprima di cosa verrà inviato. Template `.github/ISSUE_TEMPLATE/bug.yml` e `feature.yml`.
- **Error boundary React** con "Qualcosa è andato storto — il tuo lavoro è salvo (journal F21)", pulsanti "Ricarica" e "Segnala".

**Accettazione**: `doctor` testato con porta occupata simulata e config mancante; il bug report non contiene mai chiavi né contenuti del progetto (test).

## D8 · Release, versioning e aggiornamenti

- **Semver** e **Changesets** (oppure Conventional Commits + `release-please`) per CHANGELOG e versioni.
- **Workflow `release.yml`** su tag `v*`: test → build → `npm publish --provenance` → `mcpb pack` → GitHub Release con il `.mcpb` allegato e le note dal CHANGELOG → deploy della demo (Pages) **della stessa versione**.
- **Compatibilità bridge**: nel messaggio `hello` app e server si scambiano `protocol: <int>`. Se non coincidono, l'app mostra "Il server OpenBand è più vecchio dell'app: aggiorna con `npx openband@latest` o scarica il nuovo .mcpb". In questo caso la demo online (sempre aggiornata) e il server locale (magari vecchio) possono convivere, perché i comandi non supportati falliscono con un messaggio chiaro, non in silenzio.
- **Avviso di aggiornamento**: il server controlla al massimo 1 volta al giorno la versione `latest` sul registry npm (disattivabile con `OPENBAND_NO_UPDATE_CHECK=1`) e la riporta in `get_status` e nella UI.
- La demo pubblica la propria versione in `/version.json`. Opzionale: anteprime delle PR con deploy su URL separati per farle provare a chi fa review.

**Accettazione**: una release dry-run in CI produce tarball npm e `.mcpb` con la stessa versione; il mismatch di protocollo è testato.

## D9 · Self-hosting con un clic

L'app è statica (`base: './'` in `vite.config.ts` funziona già da qualsiasi sottocartella), quindi pubblicarla ovunque costa pochissimo. Va reso **esplicito e a prova di principiante**.

1. **GitHub Pages per i fork, senza toccare nulla**
   - `pages.yml` funziona già su `main`. Aggiungi la guardia `if: github.event.repository.fork == false || vars.OPENBAND_DEPLOY == 'true'`, così i fork non partono a vuoto, e scrivi nel README "Fork → Settings → Pages → Source: GitHub Actions → imposta la variabile `OPENBAND_DEPLOY=true`".
   - Rendi il repo un **template** ("Use this template") per chi vuole la propria istanza senza la storia dei commit.
   - Il deploy di Pages pubblica anche `/version.json` (D8) e un `404.html` = `index.html`, per i link profondi.
2. **Deploy button** nel README, uno per provider, con file di config versionati:
   - Netlify: `netlify.toml` (build `npm run build`, publish `dist`, header di cache), pulsante "Deploy to Netlify".
   - Vercel: `vercel.json` (framework `vite`, output `dist`), pulsante "Deploy with Vercel".
   - Cloudflare Pages: istruzioni + `wrangler.toml` opzionale.
   - Gli header sono gli stessi ovunque: `Cache-Control: immutable` sugli asset con hash, `no-cache` su `index.html` e sul service worker (D5), e una CSP di base (vedi sotto).
3. **Docker** (`Dockerfile` multi-stage + `docker-compose.yml`, immagine pubblicata su GHCR dalla release D8):
   - L'immagine contiene `dist/` + `server/` e parte con `node server/http.mjs`: serve l'app e, se abilitati, il bridge D10 e il collab F16 (`OPENBAND_COLLAB=1`).
   - `docker run -p 8080:7777 ghcr.io/iltempe/openband` è la riga per NAS, Raspberry Pi e server di scuola. Build multi-arch amd64/arm64.
   - Healthcheck su `/version.json`.
4. **Configurazione runtime senza ribuild**: un file `config.json` letto all'avvio dall'app (fallback ai default) con `instanceName`, `allowedBridgeOrigins` (lato server: `OPENBAND_ALLOWED_ORIGINS`), `defaultLanguage`, `features` (per esempio disattivare D4 o il catalogo plugin in una scuola), `collabServer`, `pluginCatalogUrl`. Così chi fa self-hosting configura senza saper buildare.
5. **Isolamento cross-origin, preparato prima che serva**: se un giorno userai `SharedArrayBuffer` (worklet di registrazione F25, time-stretch F23 in WASM con thread), servono gli header `COOP`/`COEP`. GitHub Pages non permette header personalizzati, quindi prevedi l'opzione `coi-serviceworker` (MIT) integrata nel service worker di D5, e i corrispondenti header in `netlify.toml`/`vercel.json`/Docker. Finché non serve, resta disattivata.
6. **Sicurezza delle istanze pubbliche**: CSP che permette `connect-src` solo verso localhost (bridge), `api.anthropic.com` (D4), il catalogo WAM e il collab server configurato. Nessun dato utente lato server: l'istanza statica non salva nulla, tutto resta in IndexedDB.

**Accettazione**: workflow CI che builda e lancia l'immagine Docker e fa smoke test (`curl /version.json` → 200, `index.html` servito); un fork di test con `OPENBAND_DEPLOY=true` si pubblica da solo; `config.json` con `features.byoKey=false` nasconde D4 (test).

## D10 · Server MCP remoto con pairing (opzionale, il più ambizioso)

**Obiettivo**: usare OpenBand come **connettore remoto** da claude.ai web/mobile o da altri client che supportano MCP via HTTP, **senza installare nulla**. È l'estensione naturale di D9: chi fa self-hosting (o tu, su un'istanza ufficiale) espone anche l'endpoint MCP.

- **Trasporto**: `StreamableHTTPServerTransport` dell'SDK MCP su `/mcp`, nello stesso processo di `server/http.mjs`.
- **Instradamento multi-utente**: ogni sessione MCP va abbinata a **una** scheda browser. Flusso: l'utente apre lo studio → "Collega a Claude (remoto)" → lo studio si collega via `wss://<istanza>/bridge` e riceve un codice di pairing → l'utente lo dice all'AI, o lo inserisce nel connettore come parametro → il server lega la sessione MCP a quel WebSocket. Senza pairing nessun tool funziona (errore che spiega cosa fare).
- **Auth**: per l'istanza personale basta un token segreto nell'URL del connettore. Per un'istanza pubblica serve OAuth 2.1 come da specifica MCP (fase 2, separata). Rate limit per sessione, timeout di inattività e nessuna persistenza lato server dei progetti: il server è solo un **relay** tra AI e browser, i dati restano nel browser.
- **Tool di file** (`import_sample`, `save_to` …): in modalità remota i percorsi locali non hanno senso. Si accettano solo URL http(s), e il `save_to` diventa "scarica nel browser dell'utente". La descrizione dei tool cambia in base alla modalità.
- **Costi e abusi**: il relay è leggero (solo JSON, niente audio), ma va documentato che un'istanza pubblica va protetta. Default: disattivato (`OPENBAND_REMOTE_MCP=1` per attivarlo).

**Accettazione**: test end-to-end con il client HTTP dell'SDK MCP: `initialize` → tool senza pairing = errore → pairing → `get_project` restituisce il progetto della scheda giusta; due schede con pairing diversi non si vedono a vicenda.

---

## F15 · Call-and-response live (jam) — rimasta dalla v0.2

Il segmentatore di frasi (`phrases.ts`) e gli eventi `phrase` ci sono già. Manca la metà "risposta".

**Engine** (`audio/engine.ts`): `schedulePhrase(trackId, notes, startBeat): phraseId` usa `Tone.Part` temporanei sul transport live, senza commit nello store. `cancelPhrase(id)`; allo stop si ripulisce tutto.

**Finestra** (`src/jam.ts`, puro + test): `nextWindow(nowBeat, mode, loop) → startBeat`, con `mode` = `next_bar | next_loop | {bar}`. Se la risposta arriva dopo l'inizio della finestra, slitta alla successiva: mai a metà battuta.

**Tool**
| Tool | Args | Note |
|---|---|---|
| `set_jam_mode` | `enabled, response_track_id, window` | Esposto in `get_status` |
| `play_phrase` | `track_id, notes, at?, commit?=false` | Ritorna `{phrase_id, start_bar}`. Con `commit:true` crea la regione in una transazione |
| `keep_phrase` | `phrase_id` | Commit a posteriori |

**UI**: pannello AI in modalità "Jam" con stato "Ascolto… / Risposta alla battuta 9". Le frasi dell'AI compaiono come note fantasma nel piano roll, con il pulsante "Tieni".

**INSTRUCTIONS**: *"In jam mode loop: wait_for_event({kinds:['phrase']}) → answer with play_phrase in the same key, contrasting rhythm, ≤ 2 bars."*

**Accettazione**: test di `nextWindow` (limiti, loop, ritardo); le note effimere non entrano mai in history né nell'autosave.

---

## F16 · Multiplayer con l'AI come peer — rimasta dalla v0.2

Resta valida la sezione F16 della v0.2 (Yjs, binding store↔Y.Doc, `y-webrtc` + `y-websocket` opzionale nel server MCP, awareness, `Y.UndoManager` per utente, sample content-addressed, AI come peer). Due aggiunte:
- **Integrazione con F13**: ogni peer può fare `save_version` sulla stanza. Le versioni vivono nel Y.Doc (`Y.Array` di metadati, con gli snapshot sotto forma di Y.Doc update compressi), così la storia è condivisa.
- **Integrazione con F14**: le annotazioni diventano un thread multi-utente con `author: {kind:'user'|'ai', name}`.

**Accettazione**: come nella v0.2, più un test di convergenza su versioni e annotazioni concorrenti.

---

## F17 · Import/export DAWproject

**Obiettivo**: aprire e salvare progetti nel formato aperto `.dawproject` (zip con `project.xml`, `metadata.xml` e i file audio), già supportato da Bitwig, Studio One/Fender Studio Pro e Cubase 14+. OpenBand diventa un ponte tra le DAW e l'unica DAW web compatibile.

**Riferimento**: specifica e XSD pubblici nel repo `bitwig/dawproject` (licenza MIT). Leggi lo schema da lì; non copiare codice Java.

### Modulo puro `src/interop/dawproject/`
- `xml.ts`: lettura/scrittura XML minimale (DOMParser nel browser; in Node per i test usa `@xmldom/xmldom`, MIT, solo devDependency).
- `import.ts`: `dawprojectToProject(zip: Uint8Array) → { project: Project; samples: {name, data}[]; report: ImportReport }`.
- `export.ts`: `projectToDawproject(p, samples) → Uint8Array`.
- `report.ts`: tutto quello che non si traduce va in un report leggibile, mai perso in silenzio.

### Mappatura
| DAWproject | OpenBand | Note |
|---|---|---|
| `Transport/Tempo`, `TimeSignature` | `bpm` (4/4 obbligato) | Tempo variabile: il primo valore va importato, il resto nel report. Metro ≠ 4/4: importa e avvisa |
| `Track` + `Channel` (volume, pan, mute, solo) | `Track` | Conversione dB ↔ fader con `faderToDb` inverso |
| `Lanes/Clips/Clip/Notes/Note` (time e duration in beat, key, vel) | `Region.notes` | Velocity 0..1 su entrambi i lati |
| `Clip` con `Audio`/`Warps` | `Region.audio` | Warp ignorati finché non c'è F23 (poi mappali) |
| `Markers` | `Section` (kind `custom`, nome dal marker) | |
| `Points` (automazione volume/pan) | `automation.volume/pan` | Altri target: report |
| `Device` (plugin VST/CLAP/AU) | — | Non portabili: report con nome e formato. Lo strumento si sostituisce con il preset più vicino per nome/categoria (`piano`, `bass`, `drums`…) |
| `Channel role="effect"` (send/return) | `reverb`/`delay` send | Approssimazione: se c'è una return, il send più grande va su `reverb` |

Ciò che resta specifico di OpenBand (lyrics, take, annotazioni, versioni) in export va in un file `openband.json` dentro lo zip. È ignorato dalle altre DAW e ripristinato al reimport, quindi il giro OpenBand → DAWproject → OpenBand è senza perdite.

### Comandi/tool
| Tool | Args |
|---|---|
| `import_dawproject` | `source` (fileTool), `replace?=true` → `{tracks, regions, report}` |
| `export_dawproject` | `save_to?` → come `export_midi` |

UI: voci nel menu ⋯ e drag&drop del file `.dawproject`. Dopo l'import si apre un pannello "Cosa non è stato importato" alimentato dal report.

**Accettazione**
- Fixture: almeno 2 `.dawproject` reali esportati da Bitwig e da Studio One (generali a mano e mettili in `__fixtures__`), importati senza eccezioni con report coerente.
- Round-trip OpenBand → DAWproject → OpenBand: uguaglianza su `canonical.ts`.
- Validazione dell'XML esportato contro l'XSD ufficiale in test (`xmllint` in CI, se disponibile; altrimenti controllo strutturale).

---

## F18 · Marcatori di errore in registrazione ("flub markers")

**Obiettivo**: mentre registri premi un tasto (o un pedale) quando sbagli. Dopo trovi la lista dei punti da sistemare, con un clic sul punto esatto.

### Modello
```ts
interface Flub { id: string; beat: number; trackId?: string; takeId?: string; kind: 'flub'|'good'|'note'; text?: string; createdAt: number; resolved?: boolean }
// Project.flubs?: Flub[]   (migrazione: campo opzionale, niente bump di versione)
```

### Input
- Tastiera: **`F`** durante la registrazione marca un errore (oggi F apre gli effetti, quindi in registrazione F = flub e fuori registrazione resta Effetti), **`G`** marca una parte buona.
- **Pedale MIDI**: in `input.ts` va mappato un CC configurabile (default CC64 sustain, o "learn" dalle impostazioni) a `flub`, solo in registrazione.
- Voce (opzionale, dietro flag): Web Speech API con "errore"/"buona".

### Comandi/tool
`add_flub({beat?|bar?, kind, text?})` (senza posizione usa il playhead), `list_flubs({unresolved_only?})`, `resolve_flub({flub_id})`, `delete_flub`.
L'evento `flub` va in F3, così l'AI sa che lì c'è qualcosa da sistemare. Con le take (F12), il flub si lega alla take corrente e il comping ha un'azione **"sostituisci con la take migliore in questo punto"**: sceglie, tra le take che non hanno flub nell'intorno di ±1 beat, quella con più marcatori `good`.

### UI
Bandierine rosse e verdi sul righello e sulla take. Pannello "Da sistemare" con salto rapido: **`]`** e **`[`** portano al flub successivo/precedente con loop di 2 battute attorno.

**Accettazione**: test dell'algoritmo di scelta della take; il CC learn funziona; un flub dentro una take segue la take quando questa viene spostata.

---

## F19 · Undo totale, stato dei plugin incluso

**Problema** (noto in tutte le DAW): l'undo copre solo i parametri automatizzabili, e se un plugin cambia stato interno l'undo produce stati mai esistiti. In OpenBand oggi lo stato WAM finisce nel progetto solo quando `captureWamStates()` gira (salvataggio/export), quindi l'undo non lo vede proprio.

### Design
- **Snapshot di stato plugin dentro le transazioni**: `beginTransaction` cattura in modo asincrono `getState()` di tutti i WAM vivi; `endTransaction` lo ricattura. Se lo stato è cambiato, la `HistoryEntry` riceve `pluginStates: { before: Record<slotOrInstId, unknown>, after: … }`.
- **Rilevamento delle modifiche fatte nella GUI del plugin**: polling a basso costo mentre la finestra del plugin è aperta (ogni 750 ms: `getState()` + hash con `fflate`/`crc32` del JSON). A un cambiamento si apre/estende una transazione UI automatica "Modifica <nome plugin>", chiusa dopo 1,5 s di quiete. Se il WAM emette eventi di parametro (`wam-automation`/`onParamChange`), usali al posto del polling.
- **Undo/redo**: oltre al `project`, si applica `setState(before|after)` ai plugin interessati, in modo asincrono. Durante l'applicazione la UI resta bloccata con uno spinner e il polling è sospeso, per non generare transazioni fantasma.
- **Limiti di memoria**: gli stati dei plugin nella history sono compressi; se il totale supera 50 MB si eliminano gli `pluginStates` più vecchi (l'entry resta, con il flag `pluginStateDropped`, e la UI lo dice).
- `set_plugin_params` dall'AI rientra nella stessa logica, quindi diventa annullabile.

**Tool**: nessun tool nuovo. `get_history` mostra `plugins_changed: string[]` per ogni entry.

**Accettazione**
- Test con un WAM finto (mock di `getState`/`setState` con stato non automatizzabile): modifica GUI → undo → stato originale esatto; redo → stato modificato.
- Nessuna transazione generata dal solo aprire o chiudere la finestra del plugin.

---

## F20 · Essenziali di monitoring

Ciò che le DAW lasciano ai plugin di terze parti. Il DSP per la loudness c'è già in `src/analysis/loudness.ts`: va riusato in tempo reale.

1. **Meter LUFS live sul master**: un `AudioWorklet` (`src/audio/worklets/loudness.worklet.ts`) con filtro K e momentary/short-term/integrated, true-peak con oversampling 4× e reset. Target selezionabile (Streaming -14, Apple -16, Broadcast -23, Club -8) con indicatore verde/giallo/rosso.
2. **Mono sum e polarità**: pulsante **Mono** sul master (ascolto L+R, solo in monitoring, mai nell'export); pulsante **Ø** per traccia (inversione di polarità, salvata in `Track.polarity?: boolean`, inclusa nel render).
3. **Bypass a volume pareggiato**: su ogni catena FX e su ogni plugin, "A/B level-matched". Misura la loudness short-term prima e dopo la catena per 3 s, applica una compensazione di guadagno temporanea durante il confronto, poi mostra "Questa catena aggiunge +2,1 dB: senza compensazione ti stai facendo ingannare dal volume". Su richiesta può applicare il guadagno di compensazione in modo permanente.
4. **Solo sicuro**: dim del master a -20 dB invece del mute totale (opzionale).

**Tool**: `get_meters` (readOnly, valori LUFS/true-peak live del master e delle tracce), `set_monitoring({mono?, dim?})`, `update_track({polarity})`, `level_match({track_id, slot_id?}) → {gain_change_db}`.

**Accettazione**: il worklet LUFS su segnali sintetici coincide con `loudness.ts` offline (±0,3 LU); mono e dim non influenzano mai l'export (test sul render).

---

## F21 · Rete di sicurezza: journal, recupero e "macchina del tempo"

**Obiettivo**: nessun lavoro perso, e "tornare a com'era 20 minuti fa" senza aver salvato versioni.

- **Journal dei comandi** (IndexedDB, store `journal`, per `projectId`): ogni transazione chiusa appende `{at, label, source, patch}`, dove `patch` è il diff strutturale prodotto da `versions/diff.ts` (riusa F13). Ogni 50 entry o 10 minuti si scrive un checkpoint completo.
- **Recupero dopo crash**: all'avvio, se il journal è più avanti dell'autosave, compare il banner "Ho recuperato 14 modifiche fatte dopo l'ultimo salvataggio" con le azioni Ripristina / Ignora.
- **Macchina del tempo**: un cursore temporale nel pannello Versioni ricostruisce il progetto a un istante qualsiasi (checkpoint + patch) in anteprima, in sola lettura. Puoi ascoltarlo, fare il confronto A/B con lo stato attuale e da lì "ripristina" o "crea branch".
- **Versioni automatiche**: `save_version` automatico con label generata ("Prima di: Mix del ritornello") prima delle operazioni distruttive: `new_project`, `import_project_json`, `import_dawproject` con replace, `merge`, `checkout`, `delete_track` con regioni, transazioni AI con più di 20 comandi.
- **Protezione da sovrascrittura**: `.openband` esportato due volte con lo stesso nome → il nome riceve un suffisso di versione (`song v3.openband`), mai una sovrascrittura silenziosa.
- **Retention**: journal limitato a 30 giorni o 200 MB per progetto (configurabile), con compattazione dei checkpoint.

**Tool**: `get_timeline({from?, to?})` (lista di checkpoint e transazioni), `preview_at({time})` (ritorna un riepilogo come `get_project`, senza applicare), `restore_at({time, as_branch?})`.

**Accettazione**: test di ricostruzione (sequenza casuale di 500 comandi → stato ricostruito a ogni istante = stato reale registrato); simulazione di crash (journal più avanti dell'autosave) → recupero esatto.

---

## F22 · Automazione dei parametri di effetti e plugin

Estende `AutoParam` da enum chiusa a target aperti:
```ts
type AutoTarget =
  | { kind: 'mix'; param: 'volume'|'pan'|'tone'|'reverb'|'echo' }
  | { kind: 'fx'; unit: 'amp'|'eq'|'comp'; param: string }          // es. eq.midFreq, comp.threshold
  | { kind: 'plugin'; slotId: string | null; paramId: string };       // null = strumento plugin
// Track.automation diventa: Array<{ target: AutoTarget; points: AutoPoint[] }>  (migrazione v2→v3 dalla Record attuale)
```
- Valori sempre nel range nativo del parametro (per i WAM dai `getParameterInfo`).
- Engine live e render offline: per i WAM usa `scheduleEvents({type:'wam-automation', …})` dove è supportato, altrimenti `setParameterValues` a ogni tick di 32n, come oggi.
- **Registrazione dell'automazione** (latch/touch) muovendo knob e fader durante il play.
- Tool: `set_automation` accetta `target` (le firme vecchie restano retrocompatibili); `list_automatable({track_id})`.
- UI: il selettore della lane mostra tutti i parametri per gruppo (Mix / Amp / EQ / Comp / plugin…).

**Accettazione**: migrazione v2→v3 testata; un filter sweep automatizzato su un WAM si sente uguale nel live e nell'export (confronto RMS per finestra < 1 dB).

---

## F23 · Time-stretch e pitch-shift delle clip audio

- Libreria: **Rubber Band** in WASM è GPL, quindi **non va usata**. Va implementato un **WSOLA** proprio per lo stretch (buono su voce e loop) e un **phase vocoder** con phase locking per il pitch-shift, oppure va valutata `signalsmith-stretch` (MIT, ha una build WASM). Decidi in una PR esplorativa con un confronto di ascolto su 3 materiali (voce, batteria, pad).
- Elaborazione in un worker, con cache dei buffer stirati per `(sampleId, ratio, semitones)`.
- `AudioClip` riceve `stretch?: { mode: 'off'|'follow_tempo'|'fixed'; ratio?: number; originalBpm?: number }` e `pitch?: number` (semitoni, in centesimi).
- `follow_tempo`: la clip si adatta al cambio di BPM del progetto. All'import di un loop viene stimato `originalBpm` (onset + autocorrelazione, oppure dal nome file "loop_92bpm").
- Pitch delle clip audio quando l'AI o l'utente cambia tonalità: azione "Trasponi anche le clip audio".
- Tool: `update_region({stretch_mode, ratio, pitch})`, `detect_tempo({sample_id})`.

**Accettazione**: stretch 0,8×/1,25× senza click ai bordi; il cambio di BPM con `follow_tempo` mantiene gli onset allineati alla griglia (±10 ms).

---

## F24 · Drummer generativo + libreria loop CC0

**Drummer** (deterministico, niente LLM: veloce e ripetibile):
- `src/generate/drummer.ts` (puro): genera pattern da `{style, complexity 0..1, loudness 0..1, swing, fills: 'none'|'end_of_section'|'every_4', seed}`.
- Stili v1: rock, pop, funk, hip-hop/boom-bap, trap, lo-fi, house, bossa, ballad, shuffle.
- Il modello è una grammatica per stile: una base a probabilità per step + variazioni + fill alla fine della sezione (usa `Section` di F8), con ghost note e velocity umanizzate.
- Si adatta alla struttura: più semplice in strofa, più pieno nel ritornello (profilo di energia di F8).
- Tool: `add_drummer({track_id?, section_id? | from_bar,to_bar, style, complexity, loudness, swing, fills, seed?})`, `regenerate_drummer({region_id, seed?})`. Le alternative possono diventare take (F12).

**Libreria loop CC0**:
- Manifest `public/loops/index.json` (`{id, name, bpm, key?, tags, license:'CC0', author, url}`). Gli audio vengono scaricati on-demand da una sorgente CC0 verificata, mai inclusi nel repo se pesano più di 5 MB in totale.
- Browser nella Library con filtri per BPM, tonalità, tag e anteprima sincronizzata al tempo (richiede F23).
- Tool: `search_loops({query, bpm?, key?})`, `add_loop({loop_id, track_id?, start_bar})`.

**Accettazione**: stesso seed → stesso pattern (snapshot test); ogni loop nel manifest ha licenza CC0 e fonte tracciata (test che valida il manifest).

---

## F25 · Registrazione multi-input, punch-in e pre-roll

- Selezione del dispositivo di input (`enumerateDevices`) e dei canali: per esempio, sulle interfacce 2-in, ingresso 1 sulla traccia Voce e ingresso 2 sulla traccia Chitarra, con `getUserMedia({channelCount})` e uno split con `ChannelSplitter` nel worklet di registrazione.
- **Arm** per traccia (pulsante R), più tracce armate registrano insieme.
- **Punch-in/out** automatico su un range (in/out marker); **pre-roll** di N battute; **loop recording** in cui ogni giro diventa una take (F12, già pronto lato modello).
- Monitoraggio input opzionale con avviso di latenza.
- Tool: `arm_track({track_id, input_channel})`, `set_punch({in_bar, out_bar, pre_roll_bars})`, `record_audio` esteso.

**Accettazione**: un punch su 2 battute sostituisce solo quel range come take nuova, con crossfade di 5 ms ai bordi.

---

## F26 · App desktop con host VST3/CLAP (esplorativa)

Va trattata come un **progetto a parte**, preceduto da un ADR (`docs/adr/0001-desktop.md`) che confronti Tauri ed Electron.
- Raccomandazione di partenza: **Tauri** con un sidecar Rust che fa l'host dei plugin (crate `clack` per CLAP; per VST3 il binding all'SDK, che oggi è anche MIT), con l'audio dei plugin processato **nel processo nativo**. Il WebView resta la UI e il motore Tone per gli strumenti interni.
- Il problema vero è il **ponte audio** WebView ↔ nativo a bassa latenza: va valutato se spostare tutto il motore audio nel nativo (CPAL) lasciando al web solo UI e scheduling. Il prototipo da fare è un VST3 di effetto su una traccia, misurando la latenza round-trip.
- Le GUI dei plugin nativi vanno in finestre native separate.
- Il server MCP diventa interno all'app (stessa API WebSocket/stdio).

**Deliverable della prima PR**: solo l'ADR + uno spike con un plugin che suona, senza merge in main.

---

## Appendice — INSTRUCTIONS del server da aggiungere

```
- Flubs: list_flubs shows where the user marked mistakes while recording; offer to fix them (comp from takes, re-record, or edit notes).
- Every plugin tweak is undoable; still wrap edits in begin_change/end_change.
- Use get_meters for live loudness, level_match before judging whether an effect chain helps.
- Before destructive operations a version is saved automatically; preview_at/restore_at can bring back any earlier moment.
- add_drummer creates human-like drums that follow the song sections; regenerate with a new seed for alternatives.
- import_dawproject/export_dawproject move songs to and from Bitwig, Studio One and Cubase; report what could not be converted.
```
