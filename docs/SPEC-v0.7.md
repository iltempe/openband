# OpenBand — Specifica v0.7 "Sala prove"

**Parte 1** — R1 Project store · R2 `openband box` · R3 OMEP device  
**Parte 2** — C1 Pull request musicali · C2 Test di regressione del mix · C3 Clip verticali per i social  
**Parte 3** — D1 La Cassetta · D2 Il nastro di ritorno · D3 Consegna senza server centrale · D4 La cassetta delle parti (cori)

> **Per Claude Code.** Base: `main` v0.6.43. Valgono le regole e la Definition of Done della **sezione 0 di `docs/SPEC.md`** (comandi in `src/commands.ts`, tool in `server/tools.mjs`, logica pura testabile, i18n IT/EN, una feature per PR, CHANGELOG). Ogni rilascio passa dalla skill `ship-feature` (npx, `.mcpb`, desktop macOS/Windows/Linux, studio online, sito).
>
> **Obiettivo della release**: OpenBand smette di vivere solo dentro una scheda del browser. I progetti possono stare su un server (R1). Un Raspberry Pi, o un qualunque computer, diventa un registratore di sala prove sempre acceso (R2). Sensori e strumenti fatti in casa entrano nel brano con lo stesso protocollo dei motori AI (R3).

---

## 0. Distribuzioni e cosa ottiene ciascuna

| Distribuzione | Come gira oggi | R1 Project store | R2 Box (registrazione nativa) | R3 OMEP device |
|---|---|---|---|---|
| **Desktop** macOS / Windows / Linux (x64, arm64) | Electron con il server MCP integrato | ✅ backend su disco, **attivo di default** | ✅ "Modalità sala prove" finché l'app è aperta (con icona nel tray) | ✅ connessione diretta dal processo main |
| **npx** `openband start` / `openband mcp` | Node ≥ 18 su localhost | ✅ backend su disco, attivo di default su localhost | ✅ `openband box` (servizio systemd/launchd/Task Scheduler) | ✅ connessione diretta |
| **Raspberry Pi / Linux headless** | npx o Docker arm64 | ✅ | ✅ **target principale** (servizio, GPIO, mDNS) | ✅ (anche come nodo device) |
| **Web self-hosted** (Docker / `openband start` in LAN) | studio statico + room + MCP remoto | ✅ `OPENBAND_STORE=1` + volume `/data` | ⚠️ solo se il container ha `--device /dev/snd` (Linux) | ✅ tramite il server, che fa da proxy |
| **Web online** (`iltempe.github.io`) | statico, dati in IndexedDB | ⚠️ opzionale: "Collega a un server" **HTTPS** | ❌ cattura nativa impossibile → **fallback nel browser**: "Registra la prova" a scheda aperta (§R2.8) | ⚠️ solo con un server HTTPS che fa da proxy, oppure via Web Serial per device USB (R3.7, Chromium e Firefox ≥ 151; mai Safari) |

**Vincolo da ricordare sempre**: una pagina servita in HTTPS (la demo online) non può aprire `http://`/`ws://` verso la LAN (mixed content, Private Network Access). Per questo **il Box serve anche lo studio** (`http://openband.local:7777`): chi è in sala prove apre lo studio dal Box e non dalla demo. La demo online si collega soltanto a server HTTPS.

---

# R1 · Project store server-side

## R1.1 Obiettivo
Oggi i dati del brano stanno nel browser: progetto corrente in `localStorage` (`store.ts`), sample, versioni, branch e journal in IndexedDB (`audio/samples.ts`, `journal/idb.ts`). Se si pulisce la cache si perde tutto, non c'è un archivio condiviso e il Box non ha dove scrivere. R1 aggiunge un **archivio dei progetti su disco lato server** e lascia il browser come **copia di lavoro offline-first**.

## R1.2 Astrazione (nel client)
Nuovo modulo puro `src/storage/` con le interfacce, sul modello di `JournalStore` (`journal/timeline.ts`), che esiste già:

```ts
interface ProjectStore  { list(): Promise<ProjectSummary[]>; get(id): Promise<Stored<Project> | null>;
                          put(p: Project, ifMatch?: string): Promise<{ etag: string }>; trash(id): Promise<void>; }
interface VersionStore  { list(projectId); get(id); put(v); branches(projectId); putBranch(b); }
interface SampleStore   { has(id); get(id): Promise<StoredSample | null>; put(id, data, name, type); }
// JournalStore: invariato
interface Backend { kind: 'local' | 'server'; projects; versions; samples; journal; status(): BackendStatus; }
```

- `LocalBackend` = il codice IndexedDB/localStorage attuale, **spostato dietro le interfacce, senza cambiarne il comportamento**.
- `ServerBackend` = client HTTP verso §R1.4, con una cache IndexedDB davanti: lavori offline e al ritorno della rete l'outbox si svuota.
- `MemoryBackend` per i test.
- `store.ts`, `versions/*`, `journal/*` e `audio/samples.ts` parlano solo con le interfacce.

`ProjectSummary = { id, name, bpm, key, updatedAt, versions, sizeBytes, source: 'local'|'server', box?: { sessions } }`.

## R1.3 Backend su disco (Node)
`server/store/fs.mjs`, solo moduli Node standard. Layout:

```
<dataDir>/
  projects/<projectId>/
    project.json            # stato corrente (meta.projectId = nome della cartella)
    meta.json               # etag, updatedAt, trashedAt?
    versions/<id>.json.gz   # gli stessi byte che oggi finiscono in IndexedDB / Y.Doc (gzip del JSON)
    branches.json
    journal/<seq>-<id>.json.gz
  samples/<sampleId>.<ext>  # condivisi tra progetti, contati per riferimento con projectSampleIds()
  trash/…                   # cestino, svuotato dopo 30 giorni
```

- Scritture **atomiche** (file temporaneo, `fsync`, `rename`). L'etag è uno sha256 del `project.json` normalizzato (usa `versions/canonical.ts` portato in `.mjs`, oppure condiviso).
- `dataDir` di default: desktop `app.getPath('userData')/library`; npx `~/.openband/library`; Docker `/data`; Box `/var/lib/openband`. Si sovrascrive con `OPENBAND_DATA`.
- Limiti: `OPENBAND_STORE_QUOTA` (default 80% del disco libero all'avvio); se si supera, il PUT dei sample risponde 507 e la UI lo mostra chiaramente.

## R1.4 API HTTP (montata in `server/http.mjs` e nel server del desktop)
Prefisso `/api/store/v1`, JSON, CSP aggiornata in `server/csp.mjs`.

| Metodo | Percorso | Note |
|---|---|---|
| GET | `/projects` | elenco `ProjectSummary` |
| GET / PUT | `/projects/:id` | il PUT richiede `If-Match` (etag) tranne alla creazione; se è vecchio → **409** con l'etag corrente |
| DELETE | `/projects/:id` | sposta nel cestino |
| GET / PUT | `/projects/:id/versions[/:vid]`, `/projects/:id/branches` | append-only per le versioni |
| GET / POST | `/projects/:id/journal` | POST = append di un lotto |
| HEAD / GET / PUT | `/samples/:id` | binario; `Content-Type` del sample |
| WS | `/api/store/v1/events` | `project_changed {id, etag, by}`, `box_session {…}` (R2); riusa `server/events.mjs` |

**Accesso**, riusando `server/pairing.mjs`:
- origin locale (`classifyOrigin` → `local`): nessun codice;
- LAN o origin permessi: pairing una volta sola → token salvato nel browser (`secrets`). Sul Box senza schermo il codice è **fisso**, generato da `openband box install` e stampato sull'etichetta (`Pairing({ code })`, che esiste già);
- pubblico: `OPENBAND_STORE_TOKEN` obbligatorio più il pairing. Nella v0.7 una sola libreria per istanza: niente account (fuori scope).

## R1.5 Sincronizzazione e conflitti
- Salvataggio automatico come oggi (debounce) → PUT con `If-Match`. Se risponde 409, **non si sovrascrive mai**: lo stato locale si salva come branch F13 `conflitto-<dispositivo>-<data>` e compare un avviso con "Confronta" (compare view esistente) e "Unisci" (`merge`).
- **Con le room (F16) attive** la room è la fonte di verità durante la sessione. Se il server ha sia `OPENBAND_COLLAB` sia lo store, `server/collab.mjs` persiste nello store le `versions`/`branches` della mappa Y (sono già snapshot gzip, vedi `collab/shared.ts`) e allo stato idle (30 s senza update) l'ultimo stato della room.
- Sample: upload pigro, prima un HEAD; il client chiede soltanto quelli che mancano (stessa logica di `ensureSamples`).

## R1.6 UI
- Pannello **Progetti**: due sezioni, "In questo browser" e "Su <nome server>" (il nome viene da `config.json`), con badge di stato (sincronizzato / in attesa / offline / conflitto).
- Azioni: "Sposta sul server", "Tieni una copia in questo browser", "Scarica `.openband`" (invariato).
- Impostazioni → Archivio: URL del server, stato, spazio usato e quota.
- **Desktop, primo avvio dopo l'aggiornamento**: migrazione automatica IndexedDB → libreria su disco, con riepilogo e senza cancellare l'originale.

## R1.7 Comandi e tool MCP
Nuovi, se non esistono già in `server/tools.mjs`, nel toolset `versions`: `list_projects` (readOnly), `open_project {id}`, `move_project {id, to: 'server'|'local'}`, `store_status` (readOnly). In modalità MCP remoto `open_project` resta legato al tab abbinato (regola di `remote.mjs`).

## R1.8 Test e accettazione
- Test: backend FS su una cartella temporanea (atomicità con crash simulato, etag, 409, quota, cestino); `ServerBackend` contro il server in-process; migrazione da `MemoryBackend`; non regressione `LocalBackend` (i test esistenti verdi senza modifiche).
- **Accettazione**:
  1. Desktop: chiudo l'app, pulisco i dati web, riapro → i progetti ci sono.
  2. Docker con il volume `/data`: due browser vedono la stessa libreria; una modifica concorrente produce un branch di conflitto, non una perdita.
  3. Demo online + server HTTPS abbinato: apro un progetto del server, lavoro offline, ritorno online → sincronizzato.
  4. I progetti `.openband` / `.openband.json` v1–v3 si aprono come prima.
- ADR: `docs/adr/0005-project-store.md` (perché filesystem e non SQLite: niente dipendenze native, backup = copiare una cartella).

---

# R2 · `openband box` — registrazione nativa per la sala prove

## R2.1 Obiettivo
Un dispositivo sempre acceso (Pi 4 da 4 GB come minimo, Pi 5 consigliato, oppure un mini-PC o un laptop) collegato a un'interfaccia audio USB class-compliant. **Registra da solo ogni prova**, la divide in brani, la salva in R1 come progetto con versioni. La band la riapre dal telefono il giorno dopo.

## R2.2 CLI
```
openband box                     # avvia: store R1 + room LAN + registratore + mDNS
openband box devices             # elenca gli ingressi audio (ALSA / CoreAudio / WASAPI)
openband box install [--pin]     # servizio di sistema + PIN fisso; stampa URL e PIN
openband box uninstall
openband box status              # stato, livelli, ultima sessione, disco
  --device <id>  --channels 1-8  --names "Voce,Chitarra,Basso,Batteria L,Batteria R"
  --project "Sala prove <band>"  --threshold -42  --data <dir>  --port 7777
```
La configurazione persiste in `<dataDir>/box.json`. `openband doctor` controlla ffmpeg, ingressi, disco, servizio e porta.

## R2.3 Cattura nativa
- **ffmpeg come processo figlio** (`server/box/capture.mjs`): `-f alsa` su Linux, `-f avfoundation` su macOS, `-f dshow`/`wasapi` su Windows. Esce PCM s24le 48 kHz verso Node, che fa la gate (§R2.4) e scrive i WAV.
- ffmpeg **non va incluso nei pacchetti** (licenza LGPL/GPL a seconda della build). Si rileva nel PATH e, se manca, la UI e `doctor` spiegano come installarlo (`apt install ffmpeg`, `brew install ffmpeg`, `winget install ffmpeg`). Su Linux, se ffmpeg manca, c'è il fallback `arecord`.
- Un file WAV per canale, **segmentato ogni 5 minuti** e ricucito alla fine: se manca la corrente si perdono al massimo 5 minuti. L'header si aggiorna a ogni segmento.
- Pre-roll: buffer circolare di 5 s, così l'attacco del brano non si perde.

## R2.4 Rilevamento delle sessioni (puro, `server/box/gate.mjs`)
- RMS a finestra di 50 ms su tutti i canali. **Avvio**: più di 2 s sopra `threshold`. **Fine sessione**: 90 s sotto soglia (configurabile).
- **Separazione dei brani** dentro la sessione: pause oltre 8 s → punti di taglio → `Section` "Brano 1…n" (kind `custom`). L'utente le rinomina dopo.
- Test con buffer sintetici: avvio, isteresi, pause brevi che non tagliano, pre-roll, sessioni che attraversano più segmenti.

## R2.5 Import nel progetto
A fine sessione, lato server, senza browser:
1. carica i WAV come sample in R1 (`samples/`);
2. nel progetto della band (o nel nuovo progetto `--project`) aggiunge, sotto un marker di sessione, **una traccia audio per ogni canale** con i nomi di `--names` e una regione per brano;
3. salva una **versione** `Prova 2026-11-03 21:14` sul branch `prove` (il main resta quello che la band arrangia);
4. emette `box_session` sul canale eventi R1.

Il JSON di progetto va scritto con gli stessi tipi di `src/types.ts`: estrai le funzioni necessarie (`emptyProject`, `makeTrack`, creazione delle regioni audio) in un modulo puro condiviso, oppure dupliscile in `server/box/project.mjs` con un test di equivalenza.

**L'analisi pesante resta nel client**: alla prima apertura di una sessione lo studio propone "Analizza la prova", che lancia tempo, tonalità, `auto_sections` e il confronto delle take tra prove dello stesso brano (`comp_takes`, `replace_with_best_take`). Nuovo comando `analyze_rehearsal {session_id}` che concatena quelli esistenti in una transazione F1.

## R2.6 Controlli fisici (solo Linux / Pi, opzionali)
- Via `libgpiod` (i comandi `gpiomon`/`gpioset` come processi figli, **niente dipendenze native Node**). Pin configurabili in `box.json`.
- **Pulsante REC**: forza l'avvio o lo stop. **Pulsante MARK**: aggiunge un `Flub` (F18) all'istante corrente, il "c'è un errore qui" di chi suona senza toccare un telefono. **LED**: spento = fermo, fisso = armato, lampeggiante = in registrazione, veloce = errore o disco pieno.
- Un footswitch USB-MIDI fa le stesse cose sulla nota o CC configurati (vale su tutte le piattaforme).

## R2.7 Rete e UI
- mDNS `openband.local` + `_openband._tcp`: sul Pi con avahi (installato dallo script); altrove con `bonjour-service` (MIT), da giustificare nella PR, altrimenti si usa l'IP mostrato da `status`.
- Lo **studio è servito dal Box**. Pannello **Sala prove**: stato e meter in tempo reale (WS), elenco sessioni → "Apri", "Analizza", "Scarica i WAV", spazio su disco e retention (`keep: { sessions: 50 } | { gb: 40 }`, si cancellano prima le sessioni più vecchie non marcate ⭐).
- Room LAN già attive: più musicisti aprono la stessa prova insieme (F16).

## R2.8 Per distribuzione
- **Pi / Linux headless**: tutto. `scripts/box/install.sh` (curl-able): Node 22, ffmpeg, avahi, utente `openband`, unit systemd `openband-box.service`, gruppo `audio`/`gpio`. L'immagine SD pronta (pi-gen) è fuori scope e va in un issue separato.
- **Docker**: `docker-compose.box.yml` con `--device /dev/snd`, volume `/data`, `network_mode: host` per mDNS. Solo Linux.
- **Desktop macOS / Windows / Linux**: impostazione "Modalità sala prove" nel processo main; stessa cattura con ffmpeg di sistema; icona nel tray con lo stato; "Avvia all'accesso" opzionale (login item). Vive finché l'app è aperta. È il caso del laptop lasciato in sala.
- **Web (online e self-hosted)**: niente cattura nativa. Fallback **"Registra la prova" nel browser**: usa la registrazione già esistente (F11 `record_audio`) più la gate R2.4 eseguita in un worker, la Wake Lock API e un avviso "tieni la scheda aperta e lo schermo acceso". Salva in R1 se c'è un server, altrimenti in IndexedDB. Dichiarato come "best effort" nella UI.

## R2.9 Accettazione
1. Pi 5 + Scarlett 2i2 (o un'interfaccia class-compliant equivalente): `install.sh`, riavvio, si suonano tre brani con pause → al termine c'è una versione con 2 tracce e 3 sezioni, apribile da `http://openband.local:7777` dal telefono.
2. Si toglie la corrente a metà brano → al riavvio la sessione è recuperata fino all'ultimo segmento.
3. MARK durante il secondo brano → c'è un flub al punto giusto (±0,5 s).
4. Desktop macOS e Windows: la modalità sala prove registra e importa come sul Pi.
5. Web: il fallback registra una prova di 20 minuti a scheda aperta su Chrome desktop.
6. Pi 4 da 4 GB: 4 canali per 2 ore senza dropout, CPU media sotto il 40%.

---

# R3 · OMEP device profile e nodo d'esempio (Pi + un sensore)

## R3.1 Obiettivo
Uno strumento o un sensore fatto in casa entra in OpenBand **come oggi entra un motore AI**: un server MCP che si descrive con un manifest. Il protocollo non si inventa da capo: è un **profilo di OMEP** (`omep/README.md`) che riusa manifest, capability come tool, conformance, template e streaming (§8).

## R3.2 Dichiarazione
Un device è un server MCP (stdio o Streamable HTTP) che dichiara `experimental["io.openband/device"] = { "version": "0.1" }`. Può dichiarare anche `io.openband/music-engine`, se genera pure contributi. Serve `omep://manifest` con un blocco nuovo, `device`. Va aggiornato `omep/schemas/manifest.schema.json` (minor: OMEP 1.1, §10 Versioning).

```jsonc
{
  "omep": "1.1",
  "engine": { "id": "pi-tof-theremin", "name": "Theremin ToF", "version": "0.1.0" },
  "license": { "code": "MIT", "commercial": "yes" },
  "runtime": { "where": "lan", "device": ["cpu"], "realtime": true },
  "device": {
    "hardware": "Raspberry Pi 5 + VL53L1X (I²C)",
    "latency_ms": 15,
    "controls": [
      { "id": "distance", "label": "Distanza mano", "kind": "continuous", "range": [0, 1], "unit": "norm",
        "rate_hz": 100, "curve": "linear", "raw": { "min": 40, "max": 600, "unit": "mm" } },
      { "id": "present", "label": "Mano presente", "kind": "toggle" }
    ],
    "audio_inputs": [],
    "outputs": [ { "id": "led", "kind": "light", "range": [0, 1] } ],
    "midi_fallback": { "port": "Theremin ToF", "map": { "distance": { "cc": 74 } } }
  },
  "capabilities": {
    "device.read":   {},
    "device.stream": { "max_rate_hz": 200 },
    "device.set":    {},
    "device.record": { "max_seconds": 600 }
  },
  "outputs": ["application/json"],
  "determinism": "deterministic"
}
```

`kind` dei controlli: `continuous | toggle | trigger | xy | pressure`. `curve`: `linear | log | exp`.

## R3.3 Capability (si aggiungono al catalogo, §4)
| Capability | Cosa fa | Risultato |
|---|---|---|
| `device.read` | istantanea dei controlli | Contribution `params` `{ values: {id: v} }` |
| `device.stream` | flusso dei controlli; **MCP apre e chiude, i dati viaggiano sul trasporto di §8** (`omep-stream`, frame JSON `{beat, t, values}`; nuovo `transport: "ws-ctl"`) | Contribution `stream` |
| `device.set` | pilota le uscite (LED, display, aptica) | ack |
| `device.record` | registra un clip dai sensori o dal microfono del nodo, con provenienza (device, ora, posizione facoltativa) e licenza | Contribution `audio` o `params` (curva) |

Come per `stream.jam`, **la pagina non raggiunge mai direttamente il device in LAN**: passa per il proxy `/stream/<id>` del server (stessa regola di §8).

## R3.4 Nello studio
- **Pannello Device** (accanto a Ensemble): device trovati (mDNS `_omep._tcp`, URL manuale, stdio dal desktop/npx), stato, latenza misurata e i controlli in tempo reale.
- **Mapping**: ogni controllo diventa una *sorgente* collegabile a qualunque target automatizzabile (`list_automatable`): parametri di plugin, volume, filtro, pitch di uno strumento, oppure nota on/off per `trigger`/`toggle`. Con curva, range e smoothing (default 20 ms).
  - Modello dati (opzionale, schema invariato v3): `Project.devices?: { id, url, manifestHash }[]`, `Project.deviceMappings?: { deviceId, control, target, curve, min, max, smoothMs }[]`.
- **Registrazione**: con traccia armata e device mappato, il movimento del controllo si scrive come automazione (touch) via `set_automation`, in una transazione F1.
- **Provenienza**: le registrazioni da `device.record` entrano nel Contribution Ledger (§6 v0.6) con il `engine.id` del device.
- **AI**: tool nuovi nel toolset `devices` (`load_toolset`): `list_devices` (readOnly), `connect_device {url}`, `map_control {device, control, target, curve?, range?}`, `unmap_control`, `device_set {device, output, value}`. Esempio: "fai che la mano più vicina apra il filtro del synth".

## R3.5 Nodo d'esempio: `omep/examples/device-pi-tof/`
- **Hardware**: Raspberry Pi (anche Zero 2 W) + sensore di distanza time-of-flight **VL53L1X** su I²C (~10 €, niente ADC, gesto espressivo da theremin) + un LED su GPIO.
- **Software**: generato da `openband omep-new --device <cartella>` (nuova variante del template). Lettura I²C via `i2c-bus` (MIT, dipendenza nativa **solo nell'esempio**, mai nel pacchetto principale). Streamable HTTP sulla porta 7788, annuncio mDNS, unit systemd.
- `--simulate`: genera un controllo sintetico (sinusoide lenta più rumore). Gira su qualunque computer e lo usa la conformance in CI.
- README IT/EN con cablaggio (foto o schema), installazione e "mappalo sul filtro in 3 passi".

## R3.6 Conformance
`omep/conformance.mjs` riconosce `io.openband/device` e verifica che il manifest sia valido rispetto allo schema 1.1, che `device.read` risponda entro `latency_ms × 3`, che `device.stream` rispetti `rate_hz` (±20%) per 4 s e chiuda pulito, che `device.set` faccia l'ack e che la modalità `--simulate` sia presente. Nuovo script `omep:conformance:device` in CI contro l'esempio in simulazione.

## R3.7 Per distribuzione
- **Desktop / npx / Box**: l'host dei device è nel server (`server/engines.mjs` esteso), con connessione diretta stdio o HTTP. Tutto supportato.
- **Web self-hosted**: il server fa da host e proxy; la pagina usa `/stream/<id>`.
- **Web online**: solo verso un server HTTPS abbinato (R1.4). In alternativa, **R3.7b (PR separata, facoltativa)**: trasporto **Web Serial** per i device USB (Pico, Arduino) che parlano lo stesso manifest in JSON-lines sulla seriale (`{"omep-device":"0.1"}` come handshake). Funziona su Chromium e su Firefox ≥ 151; su Safari la UI dice che non è supportato.
- **Sicurezza**: la prima `device.set` verso un device chiede conferma all'utente; i device in LAN richiedono un token di pairing (stesso schema di R1.4).

## R3.8 Accettazione
1. Pi + VL53L1X con il nodo d'esempio: lo studio sul desktop lo trova via mDNS, lo mappo sul cutoff e la latenza percepita resta sotto i 30 ms in LAN cablata.
2. Registro un passaggio di 8 battute muovendo la mano → c'è una corsia di automazione corretta e l'undo la toglie in un passo.
3. Claude via MCP: "collega il theremin e mappalo sul filtro" funziona con i soli tool `devices`.
4. `npm run omep:conformance:device` verde in CI con `--simulate`.

---

## Ordine di implementazione (una voce = una PR)

| # | Lavoro | Note |
|---|---|---|
| 1 | **R1.a** interfacce `src/storage/` + `LocalBackend` (refactor senza cambi di comportamento) | test esistenti verdi senza modifiche |
| 2 | **R1.b** backend FS + API `/api/store/v1` + eventi + pairing/token | `server/store/` |
| 3 | **R1.c** `ServerBackend` con cache e outbox, conflitti → branch, UI Progetti | |
| 4 | **R1.d** desktop: libreria su disco di default + migrazione; Docker `/data`; collab che persiste | ADR 0005 |
| 5 | **R2.a** `gate.mjs` + `capture.mjs` (ffmpeg / arecord) + segmentazione e recupero | logica pura testata |
| 6 | **R2.b** import nel progetto + versione sul branch `prove` + `analyze_rehearsal` | |
| 7 | **R2.c** CLI `box` + `install.sh` + systemd + mDNS + pannello Sala prove | Pi è il target di accettazione |
| 8 | **R2.d** GPIO / footswitch + modalità sala prove nel desktop + fallback web | |
| 9 | **R3.a** OMEP 1.1: schema `device`, capability `device.*`, trasporto `ws-ctl`, conformance | |
| 10 | **R3.b** host device nel server + pannello Device + mapping + automazione + toolset `devices` | |
| 11 | **R3.c** template `omep-new --device` + esempio `device-pi-tof` con `--simulate` | |
| 12 | **R3.7b** (facoltativa) trasporto Web Serial | |

## Rischi e domande aperte
- **Prestazioni del Pi 4** con più di 4 canali: va misurato in R2.a. Se non regge, il minimo diventa Pi 5.
- **ffmpeg su Windows**: i nomi dei device dshow/WASAPI cambiano da macchina a macchina. `box devices` deve restituire id stabili.
- **Multi-utente** sul Docker pubblico: fuori scope nella v0.7, ma l'API R1 non deve impedirlo (namespace `/libraries/:lib/…` prevedibile in seguito).
- **Privacy della sala prove**: il Box registra chiunque parli. UI e README devono dirlo e il LED deve essere sempre visibile. La gate si disattiva con un comando o una pressione lunga su REC.
- **OMEP 1.1**: la modifica è additiva, quindi i motori 1.0 restano conformi. Va verificato con la conformance di tutti gli adattatori esistenti.

---
---

# PARTE 2 — Collaborare, verificare, condividere

> Stesse regole della Parte 1. Le tre feature riusano pezzi che ci sono già: versioni, branch, `diffProjects`, `mergeProjects` (F13), A/B alla cieca (F12), annotazioni (F14), linter e fix (F7), `analyze_mix` (F5), ledger (v0.6 §6), video di release (G6 `src/publish/video.ts`), broker OAuth (G6 `server/publish/oauth.mjs`). **Non vanno riscritti: vanno estesi.**

## Matrice per distribuzione

| | Desktop (mac/win/linux) | npx / Box / Web self-hosted | Web online |
|---|---|---|---|
| **C1** PR musicali | ✅ tutto | ✅ tutto (PR condivise nello store R1) | ✅ via file `.openband-pr` e room P2P; con un server HTTPS abbinato, come self-hosted |
| **C2** Test del mix | ✅ tutto + CLI | ✅ tutto + CLI in CI | ✅ tutto nella pagina (la CLI no) |
| **C3** Clip verticali | ✅ render + pubblicazione diretta su TikTok / Instagram / YouTube | ✅ render + pubblicazione diretta | ✅ render; condivisione con il **Web Share API** (sul telefono apre TikTok/Instagram/YouTube), sul desktop download |

---

# C1 · Pull request musicali

## C1.1 Obiettivo
Chiunque può fare **fork** di un brano, cambiarlo (un basso nuovo, un bridge riscritto, un mix diverso) e mandare una **proposta** all'autore. L'autore la **ascolta** (A/B alla cieca, solo le modifiche, loop sulle battute cambiate), la **commenta sulle battute**, vede i **check** (C2 e linter) e fa **merge** di tutto o di una parte. Chi ha contribuito a cosa resta nel ledger.

## C1.2 Modello dati (campi opzionali, schema v3 invariato)
```ts
interface ProjectMeta { …; forkOf?: { projectId: string; versionId: string; name: string; url?: string } }

interface Proposal {
  id: string;                 // "pr_…"
  number: number;             // #1, #2… per progetto
  projectId: string;          // il progetto di destinazione
  title: string;
  description?: string;       // markdown ≤ 2000 caratteri
  author: AnnotationAuthor;   // persona o AI (riusa il tipo di F14)
  baseVersionId: string;      // la versione dell'autore da cui è partito il fork
  headVersionId: string;      // la versione proposta (portata nel progetto come branch `pr/<number>`)
  status: 'open' | 'merged' | 'closed' | 'draft';
  createdAt: number; updatedAt: number;
  reviews?: { by: AnnotationAuthor; verdict: 'approve' | 'changes' | 'comment'; at: number; text?: string }[];
  checks?: { tests?: TestRun; lint?: { added: number; removed: number } };  // C2 / F7
  mergedVersionId?: string;
}
Project.proposals?: Proposal[];
```
- I **commenti sulle battute** sono `Annotation` (F14) con un nuovo campo opzionale `proposalId` e un `target` sulla versione head (`range`, `region`, `notes`). Così la UI dei pin e dei thread si riusa.
- `LedgerEntry.source` aggiunge `'human'` con `contributor: { name: string }` per le parti arrivate via merge da un'altra persona. Serve ai crediti di G6 e, più avanti, allo split sheet.

## C1.3 Fork e trasporti
- **Fork** (`fork_project`): copia del progetto con un nuovo `projectId`, `meta.forkOf` compilato, e la **storia delle versioni conservata**. Gli id delle versioni restano gli stessi, così `commonAncestor()` funziona al ritorno.
- **Tre trasporti**, stesso formato:
  1. **Stesso store R1** (la band ha un Box o un server): la PR si salva in `/api/store/v1/projects/:id/proposals` e la versione head in `versions/`. Notifica sul canale eventi R1 (`proposal_opened`).
  2. **Room F16**: mappa Y `proposals` con gli stessi oggetti; gli snapshot passano dalla mappa `versions` che c'è già.
  3. **File `.openband-pr`** (zip): `proposal.json`, `head.json.gz`, solo i **sample nuovi**, `ledger.json` e `forkOf`. Si manda per email o WhatsApp. Aprirlo nel progetto d'origine importa la PR. Se l'origine non c'è, propone "apri come fork". Va bene per la demo online senza server.
- Il trasporto via GitHub (progetti in git con JSON canonico, che esiste già in `export_project_json canonical`) è **fuori scope**: in un issue, con un'action che commenta il diff musicale sulle PR GitHub.

## C1.4 Revisione (pannello **Proposte**, accanto a Versioni)
- **Riepilogo**: `diffProjects(base, head)` in forma leggibile ("Basso: 34 note cambiate nel Ritornello; nuova traccia Organo; tempo 92→94"), il riepilogo che `diff_versions` dà già.
- **Timeline sovrapposta**: le regioni e le note cambiate sono evidenziate (aggiunte, tolte, modificate) sulla vista arrangiamento, con navigazione "modifica successiva / precedente".
- **Ascolto** (render offline di entrambe le versioni, come nella compare view):
  - **A/B alla cieca base vs head**: estende `startABTest` dalle take alle versioni, su tutta la canzone o su una sezione. Il voto ("preferisco B") finisce nella review.
  - **Solo le modifiche**: loop sulle battute cambiate più 1 battuta di contesto prima e dopo, con le tracce non toccate abbassate di 12 dB (regolabile).
  - **Alterna**: switch istantaneo base ↔ head a playhead fermo, con level match automatico (`level_match`) così il più forte non vince sempre.
- **Commenti**: click su una battuta della head → thread (Annotation). "Risolvi" chiude il thread.
- **Check**: alla creazione e a ogni aggiornamento della PR si eseguono i test C2 sulla head (con la base come baseline) e il linter. Il pannello mostra "3 test superati, 1 fallito (la voce nel 2° ritornello è scesa di 4 dB)" e "+2 problemi del linter".
- **Verdetto**: Approva / Chiedi modifiche / Commenta.

## C1.5 Merge
- **Tutto**: `mergeProjects(base, ours, theirs)` a tre vie. I conflitti si risolvono con l'UI che c'è già (merge manuale per traccia o regione).
- **Una parte**: "Prendi solo questo" su singole tracce o regioni, tramite i `picks` di `mergeProjects`.
- Il merge è **una transazione F1** più una versione `Merge #<n>: <titolo>` con due parent (main e `pr/<n>`). La PR passa a `merged`. I nuovi elementi entrano nel ledger come `source: 'human'`.
- Il merge va **sempre confermato nello studio** (come `publish`): l'AI può proporlo ma non eseguirlo da sola.

## C1.6 Tool MCP (nuovo toolset `review`)
`fork_project {name?}`, `create_proposal {title, description?, base?, head?}`, `list_proposals {status?}` (readOnly), `get_proposal {number}` (readOnly: diff, check, review, thread), `comment_proposal {number, text, bar_from?, bar_to?, track?}`, `review_proposal {number, verdict, text?}`, `merge_proposal {number, picks?}` (con conferma nello studio), `close_proposal`, `export_proposal {number}` → `.openband-pr`, `import_proposal {file}`.
L'AI può fare da **revisore**: "fammi una review di questa PR" legge il diff, lancia `analyze_mix` su base e head e commenta battuta per battuta.

## C1.7 Accettazione
1. Matteo fa fork del brano, cambia il basso nel ritornello ed esporta `.openband-pr`. Sulla demo online un altro utente la importa nel brano d'origine e vede "Basso: N note cambiate nel Ritornello" evidenziato.
2. L'A/B alla cieca base vs head sul ritornello funziona e il voto finisce nella review.
3. Il merge parziale (solo la traccia Basso) produce una versione con due parent; l'undo la annulla in un passo.
4. Due utenti nella stessa room vedono la PR, i commenti sulle battute e il cambio di stato in tempo reale.
5. Con lo store R1: la PR sopravvive al riavvio e compare a tutti i client.

---

# C2 · Test di regressione del mix (song tests)

## C2.1 Obiettivo
Il brano si **descrive con delle asserzioni** e lo studio le verifica come una CI: "nel ritornello la voce sta almeno 3 dB sopra le chitarre", "il master sta tra -10 e -8 LUFS integrati, true peak ≤ -1 dBTP", "il basso è mono sotto i 120 Hz", "nessuna nota del basso sotto il Mi1", "rispetto alla versione *approvata* nessuna traccia cambia di più di 1,5 dB per sezione". Cambi una chitarra e il test diventa rosso, indicando la sezione in cui hai coperto la voce.

## C2.2 Modello dati
```ts
interface SongTest {
  id: string;
  name: string;               // "Voce in primo piano nei ritornelli"
  enabled: boolean;
  severity: 'error' | 'warning';
  scope?: { sections?: (SectionKind | string)[]; tracks?: string[] };   // kind ('chorus') o id
  assert: Assertion;
  source?: string;            // la riga di testo da cui è nato (C2.3), per mostrarla e modificarla
}
type Assertion =
  | { kind: 'compare'; left: Metric; op: '>=' | '<=' | '>' | '<' | 'between'; right: Metric | number | [number, number]; margin?: number }
  | { kind: 'baseline'; metric: Metric; tolerance: number; baseline: 'approved' | string /* versionId o nome */ }
  | { kind: 'symbolic'; rule: 'pitch_range' | 'no_overlap' | 'in_key' | 'max_polyphony'; track: string; args?: Record<string, number | string> };

interface Metric {
  of: 'master' | { track: string } | { role: 'vocals' | 'drums' | 'bass' | 'harmony' | 'lead' };  // ruoli da G1 roles.ts
  measure: 'lufs_i' | 'lufs_s_max' | 'true_peak' | 'rms' | 'plr' | 'band_energy' | 'masking' | 'width' | 'correlation' | 'mono_below';
  band?: [number, number];    // Hz, per band_energy / masking / mono_below
  against?: { track: string } | { role: string };  // per masking
}
Project.tests?: SongTest[];
Project.testBaseline?: string;   // versionId della versione "approvata"
interface TestRun { at: number; versionId?: string; results: { testId: string; pass: boolean; value?: number; expected?: string; where?: { section_id?: string; from_beat?: number; to_beat?: number } }[] }
```

## C2.3 Sintassi testuale (per persone e AI)
Parser puro in `src/tests/parse.ts`, che produce `SongTest`; il round-trip testo → JSON → testo è stabile:
```
in ritornello: voce.lufs >= chitarre.lufs + 3 dB
master.lufs_i tra -10 e -8
master.true_peak <= -1
basso: mono sotto 120 Hz
basso: note tra E1 e G3
voce vs chitarre: masking 1–4 kHz <= 0.3
rispetto a approvata: ogni traccia ± 1.5 dB per sezione
```
Parole chiave IT ed EN (`in chorus:`, `between`, `vs`, `compared to approved`). I ruoli (`voce`, `batteria`, `basso`…) vengono da G1 `roles.ts`. Gli errori di parsing sono messaggi chiari con la posizione.

## C2.4 Motore
- Modulo puro `src/tests/engine.ts`: dato il progetto e le **misure**, restituisce un `TestRun`.
- **Misure** (`src/tests/measure.ts`): render offline **per traccia e per sezione** con il renderer F4. LUFS/true peak/RMS li hai da F5; nel worker DSP aggiungi `band_energy`, `masking` (sovrapposizione spettrale pesata in banda tra due tracce, 0..1), `width`/`correlation` e `mono_below` (correlazione L/R filtrata sotto la frequenza data).
- **Cache**: hash della parte del progetto che conta per il render di ogni traccia (note, regioni, effetti, automazioni, strumento). Una traccia non cambiata non si ri-renderizza.
- **Quando gira**:
  - i test `symbolic` a ogni modifica, in debounce (sono istantanei);
  - i test audio in idle (5 s senza modifiche), prima di `save_version`, nei check delle PR C1 e prima di `publish` (G6: con un `error` fallito, `check_release` blocca con un messaggio chiaro, superabile con "pubblica comunque").
- I risultati si mostrano come `LintIssue` con `category: 'tests'` nel pannello Problemi, così riusano UI, navigazione e **fix**. Un fix è una proposta di comandi in una transazione, per esempio "alza la voce di 2 dB nei ritornelli" con automazione o gain, oppure "attiva il sidechain chitarre ← voce" (G1).

## C2.5 Baseline
- "Approva questa versione": la marca come `testBaseline`. I test `baseline` confrontano ogni sezione e traccia con lei.
- "Accetta come nuova baseline" sul test fallito, quando il cambiamento era voluto.
- La lista Versioni mostra un badge ✅ / ❌ per ogni versione. Lo stato si salva nei metadati della versione, non si ricalcola.

## C2.6 Set pronti
Si aggiungono con un clic e sono modificabili: **Pronto per lo streaming** (LUFS e true peak per piattaforma, letti dalla tabella degli export di G1), **Voce in primo piano**, **Basse pulite** (mono sotto 120 Hz, niente masking cassa/basso oltre una soglia), **Niente clip**, **Stabile rispetto all'approvata**.

## C2.7 CLI e CI
`openband test <file.openband|.json> [--baseline <versione>] [--format text|json|junit]` estende `scripts/openband-lint.mjs`.
- I test `symbolic` girano in Node.
- I test audio girano in Chromium headless con `puppeteer-core`, già usato in `scripts/`: cerca Chrome/Chromium nel sistema oppure usa `--chrome <percorso>`. Se non lo trova, i test audio sono **skipped** con un avviso e il codice d'uscita resta 0, a meno di `--strict`.
- Esempio di workflow GitHub nel README: brani in git con JSON canonico, `openband test` a ogni push, report JUnit.

## C2.8 Tool MCP (nuovo toolset `tests`)
`list_tests` (readOnly), `add_test {text}` oppure `{test}`, `update_test`, `remove_test`, `run_tests {only?, baseline?}` (timeout 180 s), `set_baseline {version}`, `add_test_suite {name}`.
L'AI scrive i test dal linguaggio naturale: "voglio che la voce si senta sempre nei ritornelli" → `in ritornello: voce.lufs >= mix_senza_voce.lufs - 6 dB`, che mostra e fa confermare.

## C2.9 Accettazione
1. Sul progetto demo aggiungo `in ritornello: voce.lufs >= chitarre.lufs + 3 dB` → verde. Alzo le chitarre di 5 dB → rosso, con indicazione della sezione e del valore, e il fix lo riporta verde.
2. Test baseline: dopo "Approva", cambio l'EQ del basso → rosso solo il basso, solo nelle sezioni toccate.
3. Ri-eseguire i test dopo aver cambiato una sola traccia ri-renderizza solo quella (verificato col contatore dei render).
4. `openband test demo.openband --format junit` gira in CI su Linux con Chromium; senza Chromium i test symbolic girano e quelli audio vengono saltati con un avviso.
5. Una PR C1 che rompe un test mostra il check rosso nella revisione.

---

# C3 · Clip verticali 9:16 per TikTok, Instagram Reels e YouTube Shorts

## C3.1 Obiettivo
Da **qualunque cosa** nello studio (tutto il brano, una sezione, una selezione di battute, **una sola traccia**, una take, una prova del Box, il prima/dopo di una PR) si ottiene in un gesto un **video 9:16 pronto per i social**, e lo si pubblica **direttamente**. Oggi esiste già il video di release G6 (copertina, spettro, testo, 16:9 o 9:16 dal ritornello, WebCodecs in `video.worker.ts`): C3 lo estende.

## C3.2 Sorgente (`ClipSource`)
```ts
type ClipSource =
  | { kind: 'song' } | { kind: 'section'; section_id: string } | { kind: 'range'; from_bar: number; to_bar: number }
  | { kind: 'track'; track_id: string; context: 'solo' | 'focus' }   // focus = il resto del mix a -12 dB
  | { kind: 'take'; region_id: string; take_id: string }
  | { kind: 'rehearsal'; session_id: string; section_id?: string }   // R2
  | { kind: 'before_after'; proposal: number } | { kind: 'before_after'; a: string; b: string }  // C1 o due versioni
```
Durata: la sceglie l'utente, con un **default intelligente** (§C3.5). I limiti per piattaforma stanno in una **tabella di configurazione** (`src/publish/platforms.ts`) con la data di verifica, perché cambiano spesso. L'attuale limite fisso 15–60 s di `shortsExcerpt` diventa il default "Short breve".

## C3.3 Look (template visivi, nel worker)
| Look | Cosa si vede | Ideale per |
|---|---|---|
| `spectrum` | quello attuale di G6 | tutto il brano |
| `pianoroll` | note che scorrono verso la linea di play, colorate per traccia; la traccia sorgente in primo piano | una parte MIDI, un riff, "impara il giro" |
| `waveform` | forma d'onda scorrevole della traccia o del mix, con il punto esatto illuminato | voce, chitarra registrata |
| `chords` | accordi grandi (dalla F9) più il testo karaoke (F10) | cover, "suonala con me" |
| `studio` | timeline animata del progetto: playhead, tracce che si accendono quando suonano, nomi | "come l'ho fatta", making-of |
| `before_after` | schermo diviso in due, con l'etichetta della metà che si sente | PR C1, "prima e dopo il mix" |
| `camera` (**C3.b**, PR separata) | il video della webcam registrato **insieme alla take** (F11 esteso a `getUserMedia` con video), sincronizzato, con note o accordi sopra | performance |

Comuni a tutti i look:
- **titolo/hook** in alto (testo libero o suggerito), **sottotitoli** del testo (le `lyricCues` esistenti);
- **safe area** per piattaforma: niente testo nella colonna destra e nel 20% in basso, dove le app mettono pulsanti e didascalia (anteprima con l'overlay dell'app attivabile);
- palette dalla copertina (`PALETTES`), firma artista opzionale.

## C3.4 Audio e loop
- Mix della sorgente con **normalizzazione per il telefono**: target di loudness dalla tabella piattaforme e limiter true peak (la catena master G1). È un'opzione "mono-safe" con un avviso se in mono si perde qualcosa (correlazione C2).
- **Loop perfetto**: se attivo, fine e inizio si incrociano (crossfade di 1 battuta tagliato sul downbeat), così il video ricomincia senza stacco. Sui social conta, perché i riascolti spingono la distribuzione.
- Encoding con il `video.worker.ts` esistente: H.264 + AAC 1080×1920 a 30 fps (60 opzionale), fallback VP9/Opus.

## C3.5 "Suggerisci i momenti" (puro, deterministico)
`suggestClips(project)` → le 3 finestre migliori, con un punteggio che combina: ritornello (F8), picco della curva di energia (G2), parte più ripetuta (hook), solo o fill, e flub ⭐ "parte buona" (F18). Per ogni finestra propone un look, un titolo e gli hashtag (dal genere e dai metadati di release). Con l'AI collegata i testi migliorano, ma la funzione lavora anche senza.

## C3.6 Condivisione e pubblicazione
- **Sempre una conferma nello studio** prima di pubblicare (stessa regola di `publish`), con anteprima, didascalia e visibilità.
- **Disclosure AI**: dal ledger (`aiDisclosure` di G6) si imposta il flag di contenuto generato con l'AI dove la piattaforma lo prevede.
- **Desktop, npx, Box, web self-hosted**: adapter nuovi in `server/publish/` con il broker OAuth esistente (PKCE). Come per YouTube oggi, **le credenziali dell'app sviluppatore le mette l'utente**: OpenBand non ha un'app centrale e non ha segreti.
  - **TikTok** (`tiktok.mjs`, Content Posting API): upload con `source: FILE_UPLOAD` dal file locale, senza bisogno di URL pubblici.
    - Modalità di default **"Manda alle bozze di TikTok"** (`MEDIA_UPLOAD`): il video arriva nell'inbox dell'app e l'utente lo finisce lì con l'editor di TikTok (suoni, effetti).
    - **Direct Post** opzionale: le opzioni di visibilità vanno lette da `creator_info` e mostrate come le dà TikTok. Va spiegato in UI che **le app non ancora approvate da TikTok possono pubblicare solo in privato**.
  - **Instagram Reels** (`instagram.mjs`, Instagram Platform):
    - richiede un **account professionale**;
    - flusso: container `media_type=REELS` → upload *resumable* del file locale su `rupload.facebook.com` → attesa che `status_code` dica pronto → `media_publish`;
    - campi: didascalia, copertina, `share_to_feed`, **collaboratori** (i membri della band, dalla room).
  - **YouTube Shorts**: estende `youtube.mjs`. Il video verticale entra come Short; nessun endpoint nuovo, solo metadati e titolo.
  - Facebook Reels: fuori scope v0.7, in un issue.
- **Web online (senza server)**:
  - sul telefono, **Web Share API** con il file (`navigator.share({ files })`): si apre il menu di condivisione del sistema e l'utente sceglie TikTok, Instagram o YouTube. Va controllato prima con `navigator.canShare({ files })`;
  - sul desktop: download dell'MP4 più un **QR code** che apre lo studio sul telefono (link alla room o allo store R1, se presenti) per condividerlo da lì.
- Ogni pubblicazione si registra in `Project.publications` (G6) con piattaforma, id e URL, quando disponibile.

## C3.7 UI
- Menu contestuale **"Crea clip"** su sezione, selezione, traccia, take, sessione del Box, PR e versione.
- Pannello **Clip**: anteprima 9:16 dal vivo, scelta della sorgente, look, durata e loop, titolo e sottotitoli, safe area, "Suggerisci i momenti" (3 schede), poi **Esporta** / **Condividi** / **Pubblica su…** (le piattaforme configurate).
- Più clip in coda: "fai le 3 suggerite" e le renderizza una dopo l'altra nel worker.

## C3.8 Tool MCP (toolset `release`)
- `render_video` si estende in modo **retrocompatibile** (senza argomenti nuovi fa quello che fa oggi): `source`, `look`, `loop`, `title`, `platform_preset`, `max_seconds`.
- Nuovi:
  - `suggest_clips` (readOnly);
  - `share_clip {file|clip_id, platforms[], caption, privacy?, mode?: 'draft'|'direct'}`, sempre con conferma nello studio;
  - `list_clip_looks` (readOnly).

## C3.9 Accettazione
1. Da una traccia di basso del demo: "Crea clip" → look `pianoroll`, 20 s in loop perfetto → MP4 1080×1920 che parte e riparte senza stacco.
2. "Suggerisci i momenti" sul demo restituisce 3 finestre deterministiche (stesso progetto, stesso risultato, con test snapshot).
3. Desktop con l'app TikTok configurata: invio in bozze → il video compare nell'inbox di TikTok. Direct Post da app non approvata → pubblicato in privato, con il messaggio in UI che lo spiega.
4. Instagram con un account professionale: il Reel viene pubblicato con didascalia e un collaboratore.
5. Demo online su Android e iOS: "Condividi" apre il menu di sistema col file MP4.
6. `before_after` su una PR C1 produce lo schermo diviso con l'etichetta sincronizzata a ciò che si sente.
7. `render_video` senza argomenti nuovi dà lo stesso risultato di oggi (test di non regressione).

---

## Ordine di implementazione — Parte 2 (una voce = una PR)

| # | Lavoro | Dipende da |
|---|---|---|
| 13 | **C2.a** modello `SongTest`, parser testuale, motore, test symbolic, integrazione nel pannello Problemi | — |
| 14 | **C2.b** misure audio per traccia e sezione con cache, test audio, baseline, set pronti | F4, F5 |
| 15 | **C2.c** CLI `openband test` (Node + Chromium headless), JUnit, esempio CI | C2.b |
| 16 | **C1.a** fork, `Proposal`, trasporto file `.openband-pr`, pannello Proposte con diff e timeline sovrapposta | F13 |
| 17 | **C1.b** ascolto (A/B base vs head, solo modifiche, alterna), commenti sulle battute, review, merge totale e parziale, ledger `human` | C1.a, F12, F14 |
| 18 | **C1.c** PR su store R1 e su room F16; check C2 nelle PR | R1, C2 |
| 19 | **C3.a** `ClipSource`, look `pianoroll` / `waveform` / `chords` / `studio` / `before_after`, safe area, loop perfetto, `suggest_clips`, Web Share | G6 video |
| 20 | **C3.b** adapter TikTok (bozza e direct), Instagram Reels, Shorts via YouTube; `share_clip` | G6 oauth |
| 21 | **C3.c** look `camera` (video della webcam registrato con la take) | F11 |

C2 viene prima di C1 perché i check delle PR ne dipendono. C3 è indipendente dalle altre due e può andare in parallelo.

## Rischi e domande aperte (Parte 2)
- **Costo dei render** per i test audio su brani lunghi: la cache per traccia è obbligatoria. Va misurato sul demo e su un brano di 40 tracce prima di attivare l'esecuzione in idle per default.
- **Metrica `masking`**: va calibrata su casi reali (voce e chitarre, cassa e basso), confrontata con l'orecchio, prima di fissare le soglie dei set pronti.
- **Policy delle piattaforme**: TikTok e Meta cambiano regole, scope e limiti spesso, e le app degli utenti devono passare le loro review. La tabella `platforms.ts` e i messaggi d'errore devono essere chiari: "la tua app TikTok non è ancora approvata: il video è stato pubblicato in privato".
- **Diritti nelle PR**: un contributo esterno porta con sé dei diritti. Prima del primo merge di una persona nuova va mostrata una nota sui crediti, basata sul ledger. Lo split sheet vero è una feature futura.

---
---

# PARTE 3 — La Cassetta

> Stesse regole delle Parti 1 e 2. **Idea**: come da ragazzi ci si passava le canzoni su musicassetta, il cantautore "incide" una cassetta dalle sue canzoni e la dà a chi vuole. Chi la riceve la ascolta dal telefono senza installare niente, con testo e accordi, e può restituire reazioni, vocali e perfino una seconda voce registrata sopra. Tutto ritorna **dentro la canzone**, alla battuta giusta.

## Principi (vincolanti per ogni PR di questa parte)

1. **Nessun server centrale.** OpenBand (il progetto) non ospita, non inoltra e non conserva cassette, ascoltatori o risposte. Esistono solo l'**istanza del musicista** (desktop, npx, Box, self-hosted) e i **suoi ascoltatori**. Ogni infrastruttura in mezzo (hosting statico, tunnel, server di signaling, TURN) la sceglie e la controlla il musicista.
2. **La cassetta contiene il suo mangianastri.** Il player è dentro la cassetta (HTML/JS autosufficiente), non viene caricato da `iltempe.github.io` né da altri. Una cassetta di oggi deve suonare anche fra dieci anni, anche se OpenBand non esiste più.
3. **Cifrata end-to-end.** Audio, titoli e testi sono cifrati e la chiave viaggia **solo nel frammento dell'URL** (`#…`), che i browser non mandano mai al server. Chi ospita i file vede solo blob illeggibili.
4. **Il ritorno torna solo al musicista.** Le risposte sono cifrate con la chiave pubblica del musicista contenuta nella cassetta: solo la sua istanza le può leggere, qualunque strada facciano.
5. **Niente account**, né per il musicista né per gli ascoltatori. L'identità è una coppia di chiavi locale più un nome scelto.
6. **Funziona offline** una volta scaricata.

## Matrice per distribuzione

| | Desktop / npx / Box / Web self-hosted | Web online |
|---|---|---|
| Incidere una cassetta (D1) | ✅ | ✅ |
| Consegna "Dal mio OpenBand" (D3 modo 1) | ✅ (in LAN subito; su internet con un tunnel scelto dal musicista) | ❌ (non c'è un'istanza) |
| Consegna "Su un mio spazio statico" (D3 modo 2) | ✅ | ✅ |
| Consegna "In mano", un file (D3 modo 3) | ✅ | ✅ |
| Ritorno diretto HTTPS (D2) | ✅ se l'istanza è raggiungibile | ❌ |
| Ritorno P2P WebRTC (D2) | ✅ quando l'istanza è aperta | ✅ quando lo studio è aperto |
| Ritorno via file `.risposta` (D2) | ✅ | ✅ |
| Cassetta delle parti (D4) | ✅ | ✅ |

---

# D1 · La Cassetta (formato e player)

## D1.1 Contenuto
Una cassetta è una **edizione** (prima stampa, seconda stampa…) di una **serie**. Contenuto logico:

```ts
interface CassetteManifest {
  format: 'openband-cassette/1';
  seriesId: string;            // stabile tra le stampe
  edition: number;             // 1, 2, …
  createdAt: number;
  title: string; artist: string;
  dedication?: string;         // "per Giulia, che c'era quando è nata"
  notes?: string;              // note di copertina, markdown ≤ 4000
  jcard: { cover: BlobRef; style: string; handwritten?: boolean };   // copertina da cover.ts; J-card stampabile da D3.4
  intro?: BlobRef;             // la voce del musicista prima del lato A
  sides: { name: 'A' | 'B'; tracks: CassetteTrack[] }[];
  options: { download: boolean; reactions: boolean; voiceNotes: boolean; overdub: boolean; duplicate: boolean; listenStats: boolean; tapeSound: 'off' | 'soft' | 'worn' };
  author: { name: string; signKey: JsonWebKey; boxKey: JsonWebKey };   // ECDSA P-256 (firma), ECDH P-256 (risposte)
  returns: ReturnChannel[];    // D2
  updates?: string[];          // URL dove cercare la stampa successiva (D3.3)
}
interface CassetteTrack {
  id: string; title: string; durationS: number;
  projectId: string; versionId: string;       // la versione "incisa": serve ad ancorare i ritorni (D2.4)
  audio: BlobRef;                              // mix
  stems?: { part: string; blob: BlobRef }[];   // D4
  sections?: { name: string; startS: number; endS: number }[];
  lyrics?: { t: number; end: number; text: string }[];   // le lyricCues esistenti (video.ts)
  chords?: { t: number; chord: string }[];     // F9, la stessa fonte di export_chord_sheet
  beatMap: { bpm: number; offsetS: number } | { t: number; beat: number }[];   // secondi ↔ beat della versione
  note?: string;                               // "l'ho scritta in treno a febbraio"
}
type BlobRef = { id: string; type: string; bytes: number; sha256: string };
```

- **Audio**: AAC-LC 160 kbps in MP4 (`.m4a`) con WebCodecs, lo stesso encoder di `video.worker.ts`. È riproducibile ovunque, iOS compreso. In alternativa "alta qualità" 256 kbps. Loudness normalizzata su tutta la cassetta (target −14 LUFS, true peak −1) così i brani hanno lo stesso volume, come su un nastro ben fatto. Si può disattivare.
- **La cassetta è congelata**: punta a `versionId` precisi. Se cambi il mix, si incide una nuova stampa (D3.3).

## D1.2 Sicurezza (solo primitive WebCrypto standard, niente crittografia fatta in casa)
- **Chiave di serie** AES-256-GCM casuale, uguale per tutte le stampe di una serie. Ogni blob e il manifest sono cifrati con IV casuale.
- **Link**: `https://<host>/<percorso>/#k=<chiave base64url>&s=<seriesId>`. La chiave è solo nel frammento.
- **Con password** (opzionale): la chiave di serie si cifra con una chiave derivata dalla password (PBKDF2-SHA256, 600k iterazioni, salt nel pacchetto); il link non contiene `k`. Si usa per il modo "in mano" e per i link che possono girare troppo.
- **Firma**: il manifest canonico è firmato ECDSA P-256 con la chiave dell'istanza del musicista, generata alla prima cassetta e conservata nei `secrets`. Il player mostra l'**impronta** come 4 parole o 4 emoji ("la firma di Matteo: 🎸🌙🚲🍋") e la ricorda: alla stampa successiva verifica che il firmatario sia lo stesso (TOFU).
- La chiave privata del musicista **non lascia mai l'istanza**. Si esporta solo cifrata, nel backup.

## D1.3 Il player (`src/cassette-player/`, entry Vite separata)
- **TypeScript e DOM, senza React**, obiettivo < 250 KB gzip, **zero richieste esterne**. CSP nel file: `default-src 'self' blob: data:`, più `connect-src` limitato ai canali di ritorno del manifest.
- **UI**: una cassetta con le bobine che girano, il cambio lato A/B (si "gira" la cassetta), la lista dei brani scritta come su una J-card, la dedica e le note di copertina, l'intro vocale all'inizio del lato A.
- **Durante l'ascolto**: testo karaoke e accordi sincronizzati, sezioni come tacche sulla barra, la nota del brano.
- **Suono del nastro** (`tapeSound`, scelto dal musicista come default, disattivabile dall'ascoltatore): wow e flutter (LFO lento su un delay modulato), leggera saturazione (waveshaper) e fruscio (rumore filtrato −60 dBFS). È tutto in Web Audio e non tocca i file.
- **Media Session API**: controlli dalla schermata di blocco e dalle cuffie, ascolto in background. In macchina si usa davvero.
- **Offline**: se servita da un host, è una PWA (service worker, manifest, "Aggiungi alla schermata Home") che salva in cache tutta la cassetta. Se è un file, è già offline.
- **Download** (se permesso): i brani come `.m4a` con i tag (titolo, artista, copertina).
- i18n IT/EN, accessibile (tastiera, screen reader, contrasti), funziona dal telefono più vecchio che regga WebCodecs in decodifica. Il fallback è `<audio>` con il blob decifrato.

## D1.4 In OpenBand (pannello **Cassette**)
- "Incidi una cassetta": scegli i brani dai progetti (R1 o del browser) e la versione di ciascuno (di default HEAD del main), trascini nei lati A/B, e il sistema mostra la durata per lato. Poi copertina (generatore esistente), dedica, note, registrazione dell'intro (F11), opzioni (D1.1) e anteprima del player così come la vedrà l'ascoltatore.
- Il render dei brani usa il renderer F4 offline, con cache per `versionId` (una versione già incisa non si ri-renderizza).
- Elenco delle cassette incise, con stampe, consegne (D3) e ritorni (D2).

## D1.5 Accettazione
1. Una cassetta di 6 brani (A3 + B3) con intro e dedica si incide dal demo in meno di 2 minuti su un portatile medio.
2. Il player si apre da iPhone (Safari) e Android (Chrome) da un link HTTPS: suona, gira i lati, mostra testo e accordi sincronizzati (±100 ms) e funziona in background e dalla schermata di blocco.
3. Chi ospita i file vede solo blob cifrati: nessun titolo o testo in chiaro nei file, verificato con un test.
4. Una stampa firmata con un'altra chiave viene segnalata come "non è la stessa firma".
5. Il player non fa richieste di rete oltre a quelle verso i canali di ritorno e gli `updates` dichiarati (test con intercettazione).

---

# D2 · Il nastro di ritorno (reazioni, vocali, canta sopra)

## D2.1 Cosa può restituire l'ascoltatore (se il musicista l'ha permesso)
- **Reazioni**: tieni premuto in un punto → "brividi" ✨, "ancora!" 🔁, "qui non mi convince" 🤔, oppure un'etichetta libera. Anche come intervallo, trascinando.
- **Commento** scritto in un punto.
- **Vocale** fino a 30 s in un punto (MediaRecorder).
- **Canta sopra (overdub)**: con le cuffie, registra una voce o uno strumento sopra un brano, anche su una sola sezione e in più take.
- **Ascolti** (solo con consenso esplicito dell'ascoltatore): quali parti ha ascoltato, fino in fondo o no, quante volte. Niente IP, niente user agent.

## D2.2 Identità e cifratura
- Al primo ritorno l'ascoltatore sceglie un **nome** ("Luca della Vespa"); il player genera una coppia di chiavi ECDSA P-256 salvata nel browser. È la stessa identità per tutte le cassette di quel musicista, ma non è collegabile tra musicisti diversi (una chiave per `author.signKey`).
- Ogni ritorno è un pacchetto `Reply`, **firmato** dall'ascoltatore e **cifrato** per il musicista: ECDH effimero P-256 con `author.boxKey` → HKDF-SHA256 → AES-256-GCM.

```ts
interface Reply {
  format: 'openband-reply/1';
  seriesId: string; edition: number; trackId: string; versionId: string;
  from: { name: string; key: JsonWebKey };
  createdAt: number;
  items: (
    | { kind: 'reaction'; t: number; t2?: number; label: string }
    | { kind: 'comment'; t: number; t2?: number; text: string }
    | { kind: 'voice'; t: number; blob: Uint8Array; type: string }
    | { kind: 'overdub'; start: number; blob: Uint8Array; type: string; latencyMs: number; headphones: boolean; label?: string }
    | { kind: 'listen'; segments: [number, number][]; completed: boolean; plays: number }
  )[];
  via?: string;   // D3.5 duplicazione
}
```

## D2.3 Tre strade per tornare, in ordine
Il player prova la prima disponibile e mette in coda le altre (IndexedDB, nuovo tentativo all'apertura successiva):
1. **Diretta HTTPS** all'istanza del musicista, se `returns` contiene `{ kind: 'https', url }`: `POST /api/cassette/v1/inbox` (nuovo endpoint nel server R1). L'istanza accetta solo pacchetti cifrati per serie che conosce, con limite di dimensione (overdub ≤ 50 MB), rate limit per chiave e per IP, e non risponde niente di utile a chi sbaglia.
2. **P2P WebRTC**, se `returns` contiene `{ kind: 'webrtc', signaling: [...], room }`: funziona quando lo studio del musicista è aperto. Il signaling è quello che sceglie il musicista: il `/signal` della sua istanza (`OPENBAND_COLLAB=1`), che esiste già, o uno pubblico configurato in `collabServer.signaling`. TURN opzionale, configurato dal musicista. La room è derivata dalla chiave di serie, quindi non indovinabile.
3. **A mano**: il player crea un file `<titolo>-per-<artista>.risposta` (il Reply cifrato) e apre il menu di condivisione (Web Share API) o lo scarica. Il musicista lo trascina in OpenBand. È il "ti ridò la cassetta con un biglietto dentro".

Il player dice sempre all'ascoltatore che strada ha preso il suo ritorno ("consegnato", "in attesa che Matteo apra lo studio", "mandalo tu").

## D2.4 Ancoraggio musicale (la parte che nessun altro fa)
I tempi del ritorno (secondi nella cassetta) diventano **posizioni musicali**: con il `beatMap` del brano si passa da `t` a un beat della `versionId` incisa, poi a un'**ancora**:

```ts
interface MusicalAnchor { versionId: string; beat: number; sectionId?: string; sectionKind?: SectionKind; barInSection?: number; beatInBar?: number; context?: string /* hash delle note attorno, ±1 battuta */ }
```

- Funzione pura `reanchor(anchor, fromProject, toProject): { beat, confidence } | { orphan: true }`. Usa `diffProjects` e le sezioni: stessa sezione (id, oppure kind più ordine) → stessa battuta relativa. Se la sezione si è allungata o accorciata → la battuta proporzionale o quella con lo stesso `context`. Se la sezione è stata cancellata → orfano.
- I ritorni si vedono **sull'HEAD attuale** del progetto, anche se la canzone è cambiata dalla cassetta, con un indicatore di affidabilità. Gli orfani restano in una lista a parte.
- Test: sezione spostata, ritornello allungato, bridge tolto, cambio di tempo.

## D2.5 In OpenBand (pannello **Ritorni**, dentro Cassette)
- Per cassetta e per ascoltatore: i ritorni arrivano come **Annotation F14** (autore = nome dell'ascoltatore, `kind: 'user'`) con un'icona per tipo. I vocali si ascoltano dal pin.
- **Mappa di calore** delle reazioni sulla timeline del brano: dove tutti hanno detto "brividi" e dove hanno smesso di ascoltare (se c'è il consenso).
- **Overdub → pull request C1**: diventa una `Proposal` con una traccia audio nuova (autore = l'ascoltatore, base = la `versionId` incisa) e passa da revisione, A/B e merge come ogni PR. Allineamento: compensazione della latenza dichiarata, più "Allinea" (nudge manuale con anteprima). Se `headphones: false`, avviso "ci sarà il rientro della base".
- I ritorni sono **dati del progetto**: con R1 stanno sul disco del musicista, senza R1 nel browser. Non escono mai dall'istanza.

## D2.6 Canta sopra: dettagli del player
- Serve `getUserMedia`, quindi un **contesto sicuro**: funziona sui link HTTPS. Sul modo "file" dipende dal browser: se non è disponibile, il pulsante spiega perché e suggerisce il link.
- Compensazione della latenza: `AudioContext.outputLatency + baseLatency` più la latenza d'ingresso stimata, con una **calibrazione col battito di mani** facoltativa (si ascolta un click e si batte, una volta per dispositivo).
- Si ascolta la base in cuffia, con count-in di 1 battuta (dal `beatMap`) e loop di una sezione per più take; si riascolta, si tiene la migliore, si manda.

## D2.7 Accettazione
1. Un ascoltatore da Android mette "brividi" sul secondo ritornello del brano 3 e lascia un vocale. Con l'istanza raggiungibile, entro 5 s il pin è sulla battuta giusta nello studio del musicista.
2. Il musicista allunga il ritornello di 4 battute e sposta il bridge → il pin resta sulla stessa frase musicale (test `reanchor`).
3. Senza istanza raggiungibile e con lo studio chiuso, il ritorno resta in coda nel player e arriva appena il musicista apre lo studio (P2P), oppure come file `.risposta` se l'ascoltatore lo manda a mano.
4. Un overdub registrato da iPhone con le cuffie arriva come PR C1 allineato entro ±20 ms dopo la calibrazione.
5. Un pacchetto manomesso o firmato da un'altra chiave con lo stesso nome viene rifiutato e segnalato ("Luca della Vespa ha cambiato dispositivo?" → accetta o rifiuta la nuova chiave).

---

# D3 · Consegna senza server centrale

## D3.1 Modo 1 — "Dal mio OpenBand"
- L'istanza del musicista serve la cassetta su `/c/<seriesId>/` (player più blob cifrati) e riceve i ritorni su `/api/cassette/v1/inbox`. Richiede il server di R1: desktop, npx, Box o self-hosted.
- **In LAN** funziona subito (`http://openband.local:7777/c/…`; i ritorni HTTPS diretti richiedono HTTPS, quindi in LAN il ritorno usa P2P o file).
- **Su internet** serve un modo per essere raggiungibili, **scelto dal musicista**. OpenBand non offre infrastruttura, ma si integra:
  - **Cloudflare Tunnel** (`cloudflared`) o **Tailscale Funnel**: `openband box --tunnel cloudflared|tailscale` (e lo stesso interruttore nel desktop) avvia il tunnel se il programma è installato e configurato, e mostra l'URL pubblico HTTPS. Il sistema ne verifica la raggiungibilità con un controllo dall'esterno… fatto dal **telefono del musicista** (QR), non da un nostro servizio.
  - Un dominio proprio con port forwarding e HTTPS (Caddy): documentato in `SELF-HOSTING`.
- Il Box (R2) acceso 24/7 è la casa naturale delle cassette: il musicista incide dal portatile e la cassetta vive sul Box.

## D3.2 Modo 2 — "Su un mio spazio statico"
- Export di una **cartella** autosufficiente: `index.html` (il player), `sw.js`, `app.webmanifest`, `c.bin` (manifest cifrato), `b/<id>.bin` (blob cifrati). Si carica dovunque serva file statici.
- **Pubblicazione in un clic** con i token del musicista, riusando l'infrastruttura degli adapter di G6: **GitHub Pages** (un repo dell'utente, per esempio `cassette`, una cartella per serie), **Netlify**, **Cloudflare Pages**. Per tutto il resto (sito personale, Nextcloud con link pubblico, S3, una chiavetta su un server di un amico) basta caricare la cartella a mano.
- Il ritorno da questo modo usa P2P o file; HTTPS diretto se il musicista ha anche un'istanza raggiungibile e la indica.

## D3.3 Modo 3 — "In mano"
- **Un solo file** `Titolo – Artista.cassetta.html`: player più blob in base64 dentro. Se supera i 50 MB il sistema avvisa e propone l'alta compressione o lo zip della cartella.
- Si manda per email, WhatsApp, Telegram, chiavetta USB, AirDrop. **Con password** consigliata (D1.2), perché un file gira.
- **Limiti da dire chiaramente nella UI**: su iPhone un `.html` ricevuto in una chat spesso si apre in anteprima senza audio o senza script. Per gli amici con iPhone è meglio il modo 1 o 2 (link). Su desktop e Android funziona aprendolo nel browser.
- Non si può ritirare: è una cassetta vera, chi ce l'ha ce l'ha.

## D3.4 Stampe, J-card, cassetta fisica
- **Seconda stampa**: dal pannello, "Nuova stampa" (nuove versioni, brani in più o in meno) → `edition + 1`, stessa chiave di serie e stessa firma. Nei modi 1 e 2 il player controlla `updates` (un `latest.bin` firmato e cifrato) e mostra "È uscita la seconda stampa: c'è un nuovo mix del lato A". Le stampe vecchie restano ascoltabili. I ritorni sono legati alla stampa e all'ancora D2.4.
- **J-card stampabile** (PDF A4 da ritagliare e piegare, misure standard della custodia): copertina, titoli dei due lati, note e un **QR** al link della cassetta (senza password, oppure con la password scritta a mano nello spazio apposito).
- **Per la cassetta vera**: export audio per lato con le durate di un C60 o C90 (avviso se un lato sfora), 4 s di leader all'inizio e pause regolabili tra i brani, in WAV 48 kHz / 24 bit. Per chi duplica su nastro e per le etichette indipendenti.

## D3.5 Duplicare per un amico
- Se `options.duplicate` è attivo, il player offre "Duplica per un amico": lo stesso link con `&via=<id breve dell'ascoltatore>`. Se l'amico manda un ritorno, il musicista vede la catena ("l'ha avuta da Luca, che l'ha avuta da te").
- Non si può impedire a nessuno di copiare un link o un file. L'opzione dice solo se il player **invita** a farlo, e la UI lo dichiara.

## D3.6 Revoca e cancellazione
- **Modo 1**: "Ritira" toglie la cassetta dall'istanza; i link smettono di funzionare, tranne nelle copie già salvate offline.
- **Modo 2**: OpenBand cancella la cartella dall'host, se pubblicata in un clic; altrimenti lo fa il musicista.
- **Modo 3**: non si può ritirare.
- La UI lo spiega prima di incidere.

---

# D4 · La cassetta delle parti (cori, gruppi vocali, bande)

## D4.1 Obiettivo
Il direttore del coro, o chi arrangia per la band, dà a ognuno la cassetta per **imparare la propria parte**. Oggi si comprano a parte "tracce di studio" per ogni voce, una per brano. OpenBand le genera da qualunque arrangiamento, comprese le cose scritte o registrate dal direttore.

## D4.2 In OpenBand
- "Prepara le parti": il sistema riconosce le tracce-parte dai nomi (Soprano/S/Sop, Contralto/Alto/A, Tenore/T, Basso/B, Baritono, Voce 1/2/3, oppure strumenti: Clarinetto 1, Tromba 2…) e si possono correggere a mano. Le tracce non-parte formano l'accompagnamento.
- Nella cassetta, per ogni brano: il mix più gli `stems` (una per parte, più l'accompagnamento), in AAC.
- In più, **pacchetto classico** per chi vuole i file: per ogni parte i mix *in evidenza*, *muta* e *a sinistra* in MP3 o M4A, con nomi ordinati (`03 Signore delle cime – Tenore – in evidenza.m4a`).

## D4.3 Nel player (se la cassetta ha le parti)
- Selettore **"La mia parte"**, ricordato per quella cassetta.
- Modalità: **Tutte** (bilanciato), **In evidenza** (la mia +6 dB, le altre −9 dB, regolabile), **Muta** (tutte tranne la mia: ci canto sopra), **A sinistra** (la mia a sinistra, il resto a destra, per regolare il bilanciamento con le cuffie).
- **Rallenta** (50–100%) senza cambiare intonazione: time-stretch WSOLA della ADR 0002, portato in un AudioWorklet del player, con il vincolo di peso del player.
- **Loop** di una sezione o di un intervallo trascinato. Testo con le sillabe sotto la parte (F10), se c'è.
- **Canta sopra** (D2) in modalità *Muta*: il direttore riceve la parte cantata da ciascuno come ritorno e la ascolta nel contesto, uno per uno o tutti insieme (un "coro virtuale" dai ritorni).

## D4.4 Accettazione
1. Un arrangiamento SATB con pianoforte → "Prepara le parti" riconosce le 4 parti. La cassetta pesa al massimo il 30% in più della versione senza parti (stems AAC a 96 kbps).
2. Nel player su un telefono Android medio: cambio modalità senza interruzioni, rallentamento al 70% senza artefatti evidenti su voce sola, loop di 8 battute.
3. Il pacchetto classico produce 4 parti × 3 modalità, più il bilanciato, per ogni brano, con nomi ordinati.
4. Cinque coristi rimandano la parte cantata → il direttore li ascolta insieme, allineati, nel pannello Ritorni.

---

## Tool MCP (nuovo toolset `cassette`)
`create_cassette {title, sides, options, dedication?, notes?}`, `list_cassettes` (readOnly), `new_edition {series}`, `deliver_cassette {series, mode: 'instance'|'static'|'file', target?}`, `list_returns {series?, track?}` (readOnly), `apply_overdub {return_id}` (→ PR C1), `retire_cassette {series}`, `prepare_parts {tracks?}`, `export_parts_pack`.
**Sempre con conferma nello studio**: `deliver_cassette` e `retire_cassette`. Una cassetta, una volta data, non si riprende.

## Ordine di implementazione — Parte 3 (una voce = una PR)

| # | Lavoro | Dipende da |
|---|---|---|
| 22 | **D1.a** formato, cifratura, firma (modulo puro `src/cassette/crypto.ts` con vettori di test), render e incisione, pannello Cassette | F4, G6 cover |
| 23 | **D1.b** player autosufficiente (lati, testo e accordi, suono del nastro, Media Session, PWA) | D1.a |
| 24 | **D3.a** consegna modo 3 (file) e modo 2 (cartella più un clic su GitHub Pages / Netlify / Cloudflare Pages) | D1.b |
| 25 | **D2.a** ritorni: reazioni, commenti, vocali; canale file e P2P; `reanchor`; pannello Ritorni con mappa di calore | D1.b, F14, F16 |
| 26 | **D3.b** modo 1 (istanza): `/c/…`, inbox HTTPS, tunnel Cloudflare / Tailscale; stampe e `updates` | R1, D2.a |
| 27 | **D2.b** canta sopra (player), calibrazione, overdub → PR C1 | D2.a, C1 |
| 28 | **D4** cassetta delle parti, pacchetto classico, coro virtuale dai ritorni | D1.b, D2.b |
| 29 | **D3.c** J-card stampabile, export per nastro C60/C90, duplicazione con `via` | D1.b |

**Ordine consigliato per il lancio su Substack**: 22 → 23 → 24 → 25. Basta per incidere, consegnare a mano o su GitHub Pages e ricevere le reazioni sulla battuta giusta, senza toccare R1. È il "ti ricordi le cassette?" da mostrare.

## Rischi e domande aperte (Parte 3)
- **Crittografia**: solo WebCrypto standard (AES-GCM, ECDH/ECDSA P-256, HKDF, PBKDF2), con vettori di test e una revisione esterna prima di dire "end-to-end" sul sito.
- **iPhone e file `.html`**: è il limite del modo 3. Va testato su iOS reale e la UI deve guidare verso il link.
- **WebRTC senza TURN**: una parte delle reti (4G con NAT simmetrico, reti aziendali) non si collega. In quel caso il file `.risposta` resta la via sicura, e il musicista può configurare un suo TURN.
- **Inbox esposta su internet** (modo 1): rate limit, limiti di dimensione, accetta solo pacchetti per serie note, nessun dato in chiaro nei log. Va aggiunta ai test di sicurezza e alla CSP.
- **Peso**: 12 brani a 160 kbps sono circa 60 MB, e con le parti di più. Servono avvisi chiari e il preset "leggera" a 96 kbps.
- **Diritti delle cover**: una cassetta privata con cover di brani altrui resta una distribuzione. La UI lo ricorda quando i metadati dicono "cover" (G6 `release`), senza bloccare.
