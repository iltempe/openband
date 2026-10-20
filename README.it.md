# OpenBand

🇬🇧 [English](README.md) · 🇮🇹 Italiano

**Uno studio musicale open source in stile GarageBand, che gira nel browser e che puoi far suonare anche alla tua AI tramite il Model Context Protocol (MCP).**

### ▶ [Prova la demo online](https://iltempe.github.io/openband/) — niente da installare

![OpenBand in riproduzione](docs/demo.gif)

OpenBand è una reimplementazione *clean-room*: riproduce il flusso di lavoro di una DAW consumer (tracce, regioni, piano roll, step sequencer, Smart Controls, mixer, tastiera musicale) con codice e suoni scritti da zero. Non contiene codice, campioni, loop o grafica di Apple: tutti gli strumenti sono sintetizzati in tempo reale, quindi il progetto è liberamente ridistribuibile con licenza MIT.

## Funzionalità

- **Arrangiamento**: tracce strumento, batteria e audio; regioni MIDI da trascinare, ridimensionare, duplicare (⌥-trascina o ⌘D) e spostare tra tracce dello stesso tipo; righello con ciclo (loop) e zoom (⌘ + rotella).
- **Piano roll**: aggiungi, sposta, allunga e cancella note; griglia da 1/4 a 1/32 e terzine; trasposizione, quantizzazione e velocity.
- **Step sequencer** per la batteria: 11 pezzi (cassa, rullante, clap, rim, hi-hat chiuso e aperto, 3 tom, crash, ride), disegno a trascinamento, accenti.
- **15 strumenti sintetizzati**: piano, piano elettrico FM, organo, campane, lead, pluck, 8-bit, 3 bassi, pad, archi e 3 kit di batteria (Studio, Trap 808, Lo-Fi).
- **Importa i tuoi suoni**: trasforma file audio in un **campionatore** suonabile (i nomi delle note nei file indicano i tasti, altrimenti la nota viene riconosciuta), crea **kit batteria** da campioni (cassa, rullante, hi-hat… riconosciuti dal nome), carica strumenti da librerie **SoundFont (.sf2)** o trascina file audio sulla timeline.
- **Tracce audio** con forma d'onda: clip con guadagno e punto d'inizio, incluse nell'esportazione WAV.
- **Smart Controls**: volume, pan, brillantezza (filtro), riverbero ed eco per traccia.
- **Effetti per traccia**: simulatore di amplificatore (gain, tono del cabinet, livello), EQ a 3 bande con medi regolabili e compressore con misuratore di riduzione.
- **Automazioni** di volume, pan, brillantezza, riverbero ed eco: disegni le curve in una corsia sotto ogni traccia.
- **Plugin (Web Audio Modules 2.0)**, lo standard aperto dei plugin per il web: sfoglia la raccolta della community con synth, drum machine, amplificatori, pedali e riverberi, oppure carica qualsiasi WAM da un URL. I plugin strumento suonano il tuo MIDI, i plugin effetto vanno nella catena di ogni traccia, le loro finestre si aprono dentro lo studio e le impostazioni si salvano con il progetto e finiscono nell'export WAV.
- **Mixer** con misuratori di livello, fader, mute e solo, mandate e master.
- **Tastiera musicale** (tasti A–' come un pianoforte, Z/X per l'ottava, C/V per la velocity) e **Web MIDI** per i controller esterni.
- **Registrazione** dal vivo in nuove regioni, con metronomo.
- **Registrazione dal microfono e canticchia→MIDI**: registra voce o strumento su una traccia audio dopo una battuta di conteggio (con compensazione della latenza), oppure *canticchia una melodia* e ritrovala come note MIDI, agganciate alla tonalità e quantizzate con delicatezza. Ogni clip audio monofonica si può convertire allo stesso modo. Quando è l'AI a chiedere di registrare, confermi sempre tu.
- **Import ed export MIDI** (Standard MIDI File, programmi General MIDI, batteria sul canale 10).
- **L'AI ascolta**: `analyze_mix` renderizza il brano e lo misura (loudness EBU R128 in LUFS, true peak, LRA, equilibrio in 7 bande, stereo/fase, mascheramento tra tracce, tonalità) e restituisce correzioni concrete (*“Basso e batteria si coprono a 60–250 Hz: taglia 2–3 dB intorno a 80 Hz…”*). `render_spectrogram` dà a Claude un'immagine del mix da guardare, e `analyze_harmony` legge gli accordi con i gradi nella tonalità (*Am7 i7 · Fmaj7 VImaj7 · V7/V…*) e le cadenze. Gli stessi rapporti sono nel pannello **Analisi** (N).
- **Suonare insieme, con l'AI come terzo musicista**: apri una stanza dal pulsante delle persone, condividi il link (e la password) e tutti modificano lo stesso brano dal vivo: note diverse della stessa regione si uniscono da sole (CRDT Yjs). Vedi chi è su quale traccia, i suoni importati arrivano a chi non li ha, play/stop può seguire l'host e **l'undo annulla solo il tuo lavoro**. L'AI collegata al tuo browser agisce nella stanza come chiunque altro, e gli altri vedono cosa ha fatto e per chi.
- **Suona con l'AI (botta e risposta)**: attiva *Jam* nel pannello AI, suona una frase e l'AI risponde alla battuta successiva o all'inizio del loop: la latenza dell'LLM sparisce perché la risposta è quantizzata alla prossima finestra musicale (se arriva tardi passa alla successiva, mai a metà battuta, mai sopra la risposta precedente). Le risposte si sentono ma non si salvano: appaiono come note fantasma luminose nel piano roll finché non premi **Tieni**.
- **Versioni e branch, come git per le canzoni**: salva versioni, apri un branch per provare un'altra direzione (*“e se il ritornello fosse più lento?”*), torna indietro quando vuoi (annullabile; il lavoro non salvato resta come versione WIP) e **unisci** i branch con un merge a tre vie: le modifiche su tracce, regioni o campi diversi si combinano da sole, i conflitti veri sono elencati con *tieni la nostra / prendi l'altra*. La **vista di confronto** colora la timeline (verde aggiunte, giallo modificate, rosso tratteggiato rimosse), mostra le note dell'altra versione come fantasmi nel piano roll e permette l'A/B sincronizzato fra le due. `export_project_json({canonical:true})` scrive JSON deterministico per git.
- **Modalità Spiegami**: clic destro su una regione, una sezione o le note selezionate e scegli **Spiega**: l'AI risponde con un commento appuntato proprio lì (*“Do in primo rivolto: il Mi al basso ammorbidisce il passaggio da Fa maj7…”*). Attiva **Insegnami** e l'AI annota le scelte non ovvie mentre lavora. I commenti vivono nel brano (thread, risposte, risolti), sopravvivono a export e undo, e restano — segnati come *eliminato* — se il loro oggetto sparisce.
- **Take, comping e A/B alla cieca**: ogni regione può avere più take alternative — registrate in cycle (una per giro, come in GarageBand) o scritte dall'AI (*“dammi 4 linee di basso”*). Componi il meglio trascinando sulle corsie delle take, oppure fai un **test alla cieca**: le take girano in loop come A/B/C/D in ordine casuale, le metti in classifica e solo allora vedi i nomi (e l'AI riceve la tua classifica).
- **Rete di sicurezza e macchina del tempo**: ogni passo (le tue modifiche, ogni richiesta all'AI, annulla, ripristina) finisce in un journal nel browser, così il lavoro non si perde mai — dopo un crash OpenBand ti ripropone le modifiche che l'autosalvataggio non aveva fatto in tempo a salvare — e la **macchina del tempo** nel pannello Versioni ricostruisce la canzone in qualsiasi momento degli ultimi 30 giorni: ascoltala, confrontala in A/B con adesso, ripristinala o aprila come branch, senza aver mai salvato una versione. Le operazioni distruttive (nuova canzone, import, checkout, merge, eliminare una traccia con regioni, richieste all'AI di più di 20 comandi, tornare indietro nel tempo) salvano prima una versione *«Before: …»*, ed esportare due volte un `.openband` non sovrascrive mai (`song v2.openband`).
- **Monitoring essenziale**: **meter LUFS** live sul master (momentary, short-term, integrata, true peak sovracampionato 4× — un AudioWorklet che coincide con la misura offline entro 0,3 LU) rispetto a un obiettivo (Streaming −14, Apple −16, Broadcast −23, Club −8) con spia verde / gialla / rossa; pulsanti **Mono** e **Dim** (−20 dB) solo per l'ascolto, mai nell'export; **Ø** inversione di polarità per traccia (inclusa nel render). **A/B a volume pareggiato**: misura quanto una catena di effetti o un plugin alza il volume di una traccia, ascoltala bypassata allo stesso volume (*«Questa catena aggiunge +5,8 dB: senza compensazione ti stai facendo ingannare dal volume»*) e rendi permanente la compensazione con un clic.
- **Marcatori di errore**: mentre registri premi **F** quando sbagli (**G** per una parte da tenere; Maiusc+F / Maiusc+G con la tastiera musicale aperta) o pigia un pedale MIDI (CC64 di base, o qualunque controller con *Impara*). Bandierine rosse e verdi compaiono sul righello, sulla regione e sulla take; il pannello **Da sistemare** le elenca, `]` / `[` portano all'errore successivo / precedente con un loop di 2 battute attorno, e **Take migliore** inserisce, sulle battute attorno all'errore, la take che lì non sbaglia e ha più segni di parte buona. L'AI viene avvisata mentre segni (eventi `flub`) e può proporti di sistemarli.
- **Confronto con una reference**: carica un brano a cui vuoi somigliare (resta fuori dalla timeline), usa **A/B** nel mixer per ascoltarlo alla stessa loudness del tuo mix e nello stesso punto del brano, e confronta: loudness, dinamica, ampiezza stereo e bilanciamento per 1/3 d'ottava a loudness pareggiata, con suggerimenti come *“+2,5 dB sopra i 6 kHz sul master”* o *“taglia 2 dB a 250–500 Hz sul Pad, la traccia più energica lì”*.
- **Struttura del brano**: segna intro, strofe, ritornelli… nella corsia *Struttura* sopra il righello (oppure lascia che *Suggerisci* li trovi dalle ripetizioni). Un clic su una sezione la mette in loop, trascinandola la sposti con tutto il contenuto (⌥ spinge il resto del brano), con il tasto destro la duplichi o la elimini. Anche l'AI lavora per sezioni: *“aggiungi un altro ritornello alla fine”*, *“rendi più pieno la seconda strofa”*.
- **Testi**: scrivi le parole per sezione nel pannello **Testo**; i testi italiani vengono divisi in sillabe metriche (con sinalefe: *canto e ballo* = 4) e le sillabe accentate segnate, anche in inglese. Allineali alla traccia della melodia: le sillabe compaiono sotto la traccia e dentro le note del piano roll, e i problemi di prosodia (accenti sui tempi deboli, note lunghe su finali atone, parole spezzate da pause, sillabe e note che non tornano) vengono sottolineati ed elencati. Esporta uno spartito **ChordPro** o con gli accordi sopra il testo.
- **Linter musicale**: il pannello **Problemi** (contatore nella toolbar) controlla il brano dopo ogni modifica (note fuori tonalità, note e regioni sovrapposte, note oltre la fine della regione, due bassi che si scontrano sotto il Mi2, registri affollati, velocity o tempi meccanici, tracce vuote, basso spostato nel pan) e quasi sempre offre una correzione con un clic. L'AI fa gli stessi controlli con `lint_project`, e può farli anche la tua CI.
- **L'AI ti segue**: le frasi che suoni (separate dopo una battuta di silenzio), ciò che selezioni, play/stop, le tue modifiche e le domande scritte in *Chiedi all'AI* arrivano all'AI collegata come eventi. Un interruttore nel pannello AI disattiva la condivisione dell'attività (le domande vengono sempre inviate).
- **Annulla per intento**: tutto ciò che l'AI fa per una richiesta è un solo passo di annullamento con etichetta (*“Annulla: Beat lo-fi (23 comandi)”*); trascinamenti e manopole contano un passo ciascuno. **Plugin compresi**: quello che cambi nella finestra di un plugin (preset, modalità, wavetable — non solo le manopole automatizzabili) e ogni `set_plugin_params` sono anch'essi passi di annullamento, e l'annulla rimette il plugin esattamente nello stato in cui era.
- **Annulla/ripristina**, salvataggio automatico, **esportazione WAV** con rendering offline; i progetti con suoni importati si salvano in un unico file `.openband` che contiene i campioni.
- **Controllo AI via MCP**: 118 strumenti per comporre, arrangiare, importare suoni, aggiungere plugin, mixare, automatizzare ed esportare: l'AI può aggiungere un plugin solo a partire da una descrizione come *“un overdrive valvolare caldo”*.
- Interfaccia in **inglese e italiano**: l'inglese è predefinito, si cambia dalla schermata iniziale o dal menu ⋯.

| Piano roll | Mixer |
|---|---|
| ![Piano roll](docs/editor.png) | ![Mixer con effetti su due tracce](docs/mixer.png) |
| **Effetti** | **Traccia audio** |
| ![Amp, EQ, compressore e un riverbero WAM sul basso](docs/effects.png) | ![Clip audio con forma d'onda](docs/audio.png) |
| **Analisi (ciò che l'AI sente)** | **Spettrogramma (ciò che l'AI vede)** |
| ![Pannello Analisi](docs/analysis.png) | ![Spettrogramma della demo](docs/spectrogram.png) |
| **Problemi (linter musicale)** | **Testo e prosodia** |
| ![Pannello Problemi](docs/problems.png) | ![Pannello Testo](docs/lyrics.png) |
| **Finestra di un plugin WAM** | **Browser dei plugin** |
| ![Plugin WAM Synth-101](docs/plugins.png) | ![Ricerca dei plugin a parole](docs/plugin-browser.png) |
| **Suonare insieme: stanza, link, persone** | **Cosa vedono gli altri (avatar, attività dell'AI)** |
| ![Menu della stanza con link e partecipanti](docs/room.png) | ![Lo studio del secondo musicista con l'avatar dell'host e l'attività della stanza](docs/multiplayer.png) |
| **Jam: l'AI risponde a ciò che suoni** | **La risposta come note fantasma, finché non la tieni** |
| ![Sezione Jam nel pannello AI](docs/jam.png) | ![Risposta dell'AI come note fantasma nel piano roll](docs/jam-ghosts.png) |
| **Versioni: grafo dei branch e confronto** | **Note fantasma dell'altra versione** |
| ![Pannello Versioni con branch e vista di confronto](docs/versions.png) | ![Piano roll con note fantasma](docs/version-ghosts.png) |
| **Spiegami: commenti appuntati al brano** | **Le spiegazioni dell'AI, per richiesta** |
| ![Pannello Commenti con segnaposto su regioni e sezioni](docs/comments.png) | ![Pannello AI con le annotazioni](docs/ai-notes.png) |
| **Take e comping** | **Test A/B alla cieca** |
| ![Finestra delle take con comping](docs/takes.png) | ![Test alla cieca di tre take di basso](docs/blind-test.png) |
| **Confronto con la reference** | **A/B con la reference** |
| ![Curve mix vs reference e suggerimenti](docs/reference.png) | ![Striscia Reference nel mixer](docs/reference-strip.png) |
| **Microfono: registra o canticchia** | **L'AI chiede prima di registrare** |
| ![Menu del microfono](docs/recording.png) | ![Conferma della registrazione](docs/record-confirm.png) |
| **Macchina del tempo** | **Recupero dopo un crash** |
| ![Cursore della macchina del tempo nel pannello Versioni](docs/time-machine.png) | ![Banner di recupero](docs/recovery.png) |
| **Meter di loudness, Mono, Dim, Ø** | **A/B a volume pareggiato** |
| ![Mixer con il meter LUFS e i pulsanti di polarità](docs/monitoring.png) | ![Confronto a volume pareggiato di una catena di effetti](docs/level-match.png) |
| **Marcatori di errore: il pannello Da sistemare** | **Bandierine sulle take** |
| ![Pannello Da sistemare con un errore e una parte buona](docs/flubs.png) | ![Finestra delle take con le bandierine](docs/flub-takes.png) |

> La demo online funziona con la tua AI in tre modi: abbinata al server OpenBand sul tuo computer (un codice di 6 cifre), con la tua API key Anthropic direttamente nella pagina, oppure — su un OpenBand self-hosted — come connettore di claude.ai. Vedi [Collega un'AI](#collegare-unai-mcp).

## Avvio rapido

```bash
npx openband
```

Fatto: lo studio si apre nel browser (serve Node 18+). Niente clone, niente build. Non vuoi installare nulla? [Apri la demo online](https://iltempe.github.io/openband/).

**Installala come app:** in Chrome o Edge, *⋯ → Installa OpenBand* (o l'icona di installazione nella barra dell'indirizzo); in Safari, *Condividi → Aggiungi al Dock*. Si apre in una finestra sua, funziona offline dopo la prima visita (synth, editing, analisi, export; plugin e font restano disponibili dopo il primo uso) e, dove il browser lo permette, apre con un doppio clic i file `.openband`, `.mid` e `.dawproject`.

**Solo un browser e una API key:** apri la [demo online](https://iltempe.github.io/openband/) → pannello **AI** → *Collega AI* → *API key*, incolla la tua chiave Anthropic e chatta: Claude gira dentro la pagina e suona lo studio con gli stessi strumenti che ha via MCP (ogni richiesta è un solo passo di annullamento, il costo di ogni risposta è indicato, *Stop* è sempre disponibile). La chiave resta nella memoria del tuo browser, mai nelle canzoni o negli export, e le richieste vanno dal tuo browser direttamente ad Anthropic.

<img src="docs/chat.png" alt="Chat con Claude dentro lo studio" width="300">

**Claude Desktop: due passaggi, niente da installare.**

[**⬇ Scarica OpenBand per Claude Desktop**](https://github.com/iltempe/openband/releases/latest/download/openband.mcpb) → doppio clic sul file (o trascinalo su Claude Desktop) → *Installa*. Poi chiedi a Claude una canzone: lo studio si apre da solo nel browser. Claude Desktop include già Node; nelle impostazioni dell'estensione puoi cambiare la porta, disattivare l'apertura automatica e scegliere una cartella di suoni da cui Claude può importare per nome.

**Altri client AI:** aggiungi OpenBand al tuo client MCP: `npx openband setup` trova Claude Desktop, Claude Code, Cursor e VS Code sul tuo computer e lo fa al posto tuo (chiede prima e tiene una copia di backup di ogni file). Per farlo a mano vedi [Collegare un'AI](#collegare-unai-mcp).

> Il pacchetto npm `openband` e l'estensione `.mcpb` vengono pubblicati con la release v0.2. Fino ad allora usa un checkout (vedi [Sviluppo](#sviluppo)).

La prima schermata comincia con la musica, non con un tutorial: **🎲 Sorprendimi** crea e fa suonare un loop di 8 battute in una frazione di secondo (un giro a caso fra 12, in una tonalità a caso, con batteria e basso, senza AI), **🎤 Canticchia un'idea** trasforma 4 battute cantate in una melodia con accordi, basso e ritmo, **🤖 Chiedi all'AI** apre la procedura di collegamento, **📂 Apri un file** prende una canzone o un MIDI. *Brani d'esempio* contiene 8 piccoli brani (lo-fi, ballata pop, trap, house, rock, bossa nova, cantautore, ambient) che spiegano le proprie scelte nel pannello Commenti. Un tour di 5 passi segue quello che fai davvero (play, crea una regione, aggiungi una nota, apri il mixer, conosci l'AI), si può saltare o rivedere dal menu ⋯; `?` mostra tutte le scorciatoie.

<img src="docs/welcome.png" alt="Schermata iniziale: Sorprendimi, Canticchia un'idea, Chiedi all'AI, Apri un file" width="640">

## Suoni, effetti, automazioni e MIDI

- **I tuoi suoni**: usa *Importa suoni* in cima alla libreria. *Campionatore* trasforma file audio in uno strumento (chiamali per esempio `Piano_C4.wav` per indicare i tasti, altrimenti la nota viene riconosciuta); *Kit batteria* assegna i file chiamati kick, snare, hat, clap, tom… ai pezzi del kit; *SoundFont* apre una libreria `.sf2` e ti fa scegliere i preset; *Audio* mette i file sulla timeline. Puoi anche trascinare i file ovunque nello studio. SoundFont gratuiti da provare: FluidR3_GM (MIT) o GeneralUser GS.
- **Salvataggio**: i progetti con suoni importati si salvano in un unico file `.openband` che contiene i campioni, così si aprono ovunque. I brani salvati con versioni precedenti si aprono normalmente e vengono aggiornati in automatico.
- **Effetti**: seleziona una traccia e premi **F** (o clicca *FX* su un canale del mixer). Ogni unità ha il suo pulsante di accensione.
- **Automazioni**: clicca **A** su una traccia per aprirne la corsia, scegli il parametro, clicca per aggiungere punti, trascinali per spostarli, doppio clic per eliminarli.
- **MIDI**: *Importa MIDI…* / *Esporta MIDI* nel menu ⋯, oppure trascina un file `.mid` nello studio.
- **Plugin**: clicca *Plugin* nella libreria e descrivi cosa ti serve (*“riverbero ampio e scuro”*, *“monophonic synth”*) o filtra per strumenti/effetti; gli strumenti hanno una loro traccia, gli effetti si aggiungono alla traccia selezionata (anche da *+ Plugin* nel pannello Effetti). *Modifica* apre la finestra del plugin. I plugin arrivano dalla [raccolta WAM della community](https://github.com/boourns/wam-community) e serve una connessione internet la prima volta che si caricano.

### Controllare le canzoni in CI

Se tieni le canzoni in un repository Git, controlla ogni pull request con il linter di OpenBand:

```yaml
# .github/workflows/songs.yml
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: iltempe/openband/.github/actions/openband-lint@main
        with:
          files: songs/*.openband.json songs/*.openband
          fail-on: error        # oppure warn / info / none
```

I problemi compaiono come annotazioni sulla pull request. In locale: `node scripts/openband-lint.mjs brano.openband.json [--format=text|json|github] [--fail-on=warn]`. Le regole si possono disattivare o cambiare di gravità per ogni brano in `project.lint` (`disabled`, `severity`, `ignored`).

### Ospitare il proprio OpenBand

Lo studio è un'app statica, quindi gira ovunque: per una scuola, una community o per te:

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/iltempe/openband) [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/iltempe/openband)

- **GitHub Pages dal tuo fork:** fork → *Settings → Pages → Source: GitHub Actions* → *Settings → Secrets and variables → Actions → Variables*: `OPENBAND_DEPLOY = true`. I fork non pubblicano finché non lo attivi.
- **Cloudflare Pages:** collega il repository con il preset *Vite* (build `npm run build`, output `dist`), oppure `wrangler pages deploy dist`.
- **Docker** (NAS, Raspberry Pi, server della scuola; amd64 e arm64): `docker run -p 8080:7777 ghcr.io/iltempe/openband`, oppure `docker compose up -d` con il `docker-compose.yml` incluso (stanze multiplayer attive, healthcheck su `/version.json`).
- **Impostazioni senza ricompilare:** metti un `config.json` accanto a `index.html` (o indica con `OPENBAND_CONFIG` un file in Docker): nome dell'istanza, lingua predefinita, funzioni da disattivare (chat nel browser, plugin, stanze), URL del catalogo plugin, server di collaborazione. Vedi [`config.example.json`](config.example.json).
- Ogni host riceve gli stessi header: asset in cache per sempre, pagina e service worker mai, e una Content-Security-Policy (`server/csp.mjs`) che permette alla pagina di raggiungere solo il bridge sul computer dell'utente, l'API Anthropic, il catalogo plugin e i server di collaborazione. Un'istanza statica non salva nulla: le canzoni restano nel browser di chi la usa. L'isolamento cross-origin (COOP/COEP, per un futuro uso di `SharedArrayBuffer`) non è ancora attivo.

### Suonare insieme

- **Nella stessa rete** (il modo più veloce): avvia il server MCP con `OPENBAND_COLLAB=1`; servirà anche lo studio e un relay per le stanze sul tuo indirizzo di rete locale (stampato all'avvio; il bridge dell'AI resta raggiungibile solo da questo computer). Apri una stanza con *In questa rete* e manda il link.
- **Peer to peer**: *Peer to peer* collega direttamente i browser con WebRTC; il link apre la demo online. I partecipanti si trovano tramite un server di signaling: quello di OpenBand (`/signal` su un server avviato con `OPENBAND_COLLAB=1`) o quello pubblico di y-webrtc, e puoi indicarne uno tuo con `?signal=wss://…` (viaggia con il link). I server di signaling pubblici vanno e vengono: per sessioni affidabili via internet usane uno sotto il tuo controllo.
- La password cifra il traffico peer to peer e separa stanze con lo stesso nome; mandala a parte rispetto al link.

## Collegare un'AI (MCP)

```
Client AI (Claude Desktop, Claude Code, Cursor…)
        │  stdio · MCP
        ▼
server/mcp-server.mjs ──── WebSocket ws://127.0.0.1:7777/bridge ────▶ OpenBand nel browser
```

Il client avvia il server MCP, che inoltra ogni chiamata alla finestra di OpenBand aperta. Ogni comando ricevuto compare nel pannello **AI** dell'app (il pulsante “MCP” in alto a destra).

**Claude Code**:

```bash
claude mcp add openband -- npx -y openband mcp
```

**Claude Desktop, Cursor, VS Code…**, oppure esegui `npx openband setup`. Claude Desktop tiene il file in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) o `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "openband": { "command": "npx", "args": ["-y", "openband", "mcp"] }
  }
}
```

Nessun percorso da modificare: `npx` scarica il pacchetto, che contiene lo studio già compilato. Alla prima chiamata di un tool lo studio si apre da solo nel browser.

Poi chiedi, per esempio:

> Crea un beat lo-fi a 82 BPM in Re minore con batteria, basso e Rhodes, poi fai partire il loop.

> Aggiungi un overdrive valvolare caldo al basso e un riverbero ampio al pad, poi apri l'overdrive così lo regolo.

> Importa ~/Samples/voce.wav come traccia audio alla battuta 5, metti un compressore sul basso, fai entrare il pad in dissolvenza in due battute e salva il brano come ~/Desktop/brano.wav e brano.mid.

Variabili d'ambiente: `OPENBAND_REMOTE_MCP=1` e `OPENBAND_REMOTE_TOKEN` (MCP remoto su `/mcp`, vedi sotto), `OPENBAND_PORT` (predefinita 7777; se è occupata si usa la prima porta libera e lo studio si apre con `?mcp=<porta>`), `OPENBAND_OPEN_BROWSER=0` (non aprire il browser), `OPENBAND_COLLAB=1` (stanze multiplayer nella tua rete), `OPENBAND_NO_UPDATE_CHECK=1` (non chiedere a npm, una volta al giorno, se c'è un OpenBand più nuovo) e `OPENBAND_DEV_URL` (predefinita `http://localhost:5173`, usata quando manca la build). Problemi? `npx openband doctor` controlla Node, la porta (e chi la usa), la build, i pacchetti e i tuoi client MCP, con una soluzione per ogni ✗. Nello studio, *⋯ → Diagnostica* mostra audio, bridge, permessi, spazio, plugin ed errori recenti, e *Segnala un problema* apre una segnalazione su GitHub già compilata, senza niente delle tue canzoni e mai le tue chiavi, da rileggere prima di pubblicare.

**Dalla demo online.** Anche la demo può comandare il server OpenBand sul tuo computer: apri il pannello **AI** → *Collega AI*, installa l'estensione (o esegui `npx openband mcp`) e scrivi il **codice di abbinamento** di 6 cifre che Claude ti dà quando gli chiedi di aprire lo studio (il server lo stampa anche all'avvio). La scheda riceve un token di sessione, quindi ricaricando non lo richiede; riavviare il server lo revoca. Il browser potrebbe chiederti di consentire al sito l'accesso alla rete locale: è così che la pagina raggiunge `127.0.0.1`, scegli *Consenti*. Se il browser rifiuta, *Apri lo studio locale* porta la canzone aperta nello studio servito dal tuo computer.

<img src="docs/connect-ai.png" alt="La procedura Collega AI nella demo online" width="300">

Il bridge accetta solo connessioni in loopback: da pagine servite su localhost (senza codice) e dai siti in `OPENBAND_ALLOWED_ORIGINS` (predefinito `https://iltempe.github.io`), che devono prima abbinarsi: 5 codici sbagliati in un minuto bloccano l'abbinamento per 5 minuti, e i codici scadono dopo 10 minuti.

**Da claude.ai, web e mobile (MCP remoto).** Un OpenBand self-hosted avviato con `OPENBAND_REMOTE_MCP=1` parla MCP anche via Streamable HTTP su `/mcp`, quindi si può aggiungere in claude.ai da *Impostazioni → Connettori → Aggiungi connettore personalizzato* (anche dal telefono):

```
claude.ai ──HTTPS · MCP──▶ https://music.example/mcp ──WebSocket──▶ la scheda OpenBand dell'utente
```

1. Avvialo: `docker run -p 8080:7777 -e OPENBAND_REMOTE_MCP=1 -e OPENBAND_REMOTE_TOKEN=<una stringa casuale lunga> ghcr.io/iltempe/openband`, dietro HTTPS (Caddy, nginx… che inoltrano l'header `Host`).
2. In claude.ai aggiungi il connettore `https://music.example/mcp?token=<il token>`.
3. Apri lo studio → **AI** → *Collega AI* → *Claude (remoto)*: la scheda mostra un codice di 6 cifre. Di' a Claude «abbinati a OpenBand, codice 395 337» (oppure aggiungi `&pair=<codice>` all'URL del connettore).

<img src="docs/remote-mcp.png" alt="La scheda Claude (remoto) con l'URL del connettore e il codice di abbinamento" width="300">

Il server fa solo da ponte e non conserva nulla: le canzoni restano nella scheda. Ogni sessione MCP comanda solo la scheda con cui si è abbinata — le altre schede, anche sullo stesso server, per lei non esistono — e nessuno strumento funziona prima dell'abbinamento (`pair_studio`). I codici cambiano ogni 10 minuti e valgono una volta sola; 5 codici sbagliati per sessione in un minuto (30 fra tutte le sessioni) bloccano l'abbinamento per un minuto; le chiamate sono limitate per sessione (60 ogni 10 s) e le sessioni inattive finiscono dopo 30 minuti. In questa modalità i file si importano solo da URL http(s) pubblici (mai percorsi locali, mai indirizzi della rete del server) e gli export non hanno `save_to`: il file si scarica nella scheda. Chiudere o ricaricare la scheda chiude l'abbinamento. `OPENBAND_REMOTE_TOKEN` è facoltativo ma caldamente consigliato su un indirizzo pubblico: senza, chiunque conosca l'URL può aprire sessioni (gli serve comunque un codice da una scheda).

### Strumenti MCP

| Area | Strumenti |
|---|---|
| Progetto | `pair_studio` (solo MCP remoto), `open_studio` (solo locale), `get_project`, `get_status`, `list_instruments`, `new_project`, `rename_project`, `set_tempo`, `set_key`, `set_master_volume`, `export_project_json`, `import_project_json` |
| Eventi dello studio | `get_events`, `wait_for_event` (frasi che suoni, selezione, trasporto, modifiche, domande da *Chiedi all'AI*); risorsa `openband://project` con notifiche delle modifiche |
| Annulla | `begin_change` / `end_change` (un passo di annullamento per richiesta, con etichetta), `get_history` (con `plugins_changed` per passo), `undo` / `redo` (con `steps`; stato dei plugin compreso) |
| Tracce | `add_track` (strumento, batteria o audio), `update_track` (strumento, volume, pan, mute, solo, riverbero, eco, tono), `delete_track` |
| Suoni | `import_sample`, `list_samples`, `create_sampler_instrument`, `import_soundfont`, `add_audio_region` — i file si leggono da un percorso locale o da un URL http(s) |
| Struttura | `get_structure` (sezioni con profilo di energia), `add_section`, `update_section`, `delete_section`, `move_section`, `duplicate_section` (con ripple), `split_region`, `auto_sections` |
| Testi | `set_lyrics`, `get_lyrics`, `align_lyrics`, `check_prosody`, `suggest_melody_rhythm`, `export_chord_sheet` (ChordPro o testo, `save_to` opzionale) |
| Linter | `lint_project` (regole simboliche, opzionalmente audio), `apply_fix`, `ignore_issue`; `update_notes` modifica le note sul posto |
| Ascolto | `analyze_mix` (battute o sezione, per traccia, summary/full), `render_spectrogram` (restituisce un'immagine), `detect_key` (MIDI, audio o entrambi), `analyze_harmony` (accordi, numeri romani, funzioni, cadenze) |
| Multiplayer | `create_room` (LAN o peer to peer, password facoltativa), `join_room`, `leave_room`, `get_peers` |
| Jam | `set_jam_mode` (traccia di risposta, finestra), `play_phrase` (note effimere a `next_bar`, `next_loop` o a una battuta; `commit` opzionale), `keep_answer`; le frasi dell'utente arrivano come eventi `phrase` |
| Versioni | `save_version`, `list_versions`, `create_branch`, `checkout` (branch o versione, annullabile, salva il WIP), `diff_versions` (riepilogo leggibile + modifiche strutturate), `merge` (a tre vie; `strategy` e `pick` per entità); `export_project_json` con `canonical` |
| Spiegami | `annotate` (progetto, traccia, regione, note, sezione o intervallo di battute; markdown fino a 500 caratteri), `list_annotations`, `resolve_annotation`, `delete_annotation`; `get_status` riporta `teach_mode` |
| Take | `add_take`, `list_takes`, `set_active_take`, `delete_take`, `comp_takes` (segmenti, note tagliate ai confini), `start_ab_test` (test alla cieca; la classifica arriva come evento `ab_result`) |
| Macchina del tempo | `get_timeline` (ogni passo nel journal), `preview_at({time})` (la canzone in un momento — ISO, ms o `"-20m"` — senza cambiare nulla), `restore_at({time, as_branch?})` |
| Monitoring | `get_meters` (LUFS e true peak live del master e di ogni traccia, stato rispetto all'obiettivo), `set_monitoring` (mono, dim, obiettivo, azzeramento — solo ascolto), `level_match` (quanto una catena di effetti o un plugin cambia il volume; `apply` compensa), `update_track({polarity})` |
| Errori | `add_flub` (playhead o battuta/beat; tipi flub / good / note), `list_flubs`, `resolve_flub`, `delete_flub`, `replace_with_best_take`; eventi `flub` mentre l'utente segna |
| Reference | `import_reference` (percorso o URL, estratto opzionale), `compare_to_reference` (differenze a loudness pareggiata e suggerimenti), `clear_reference` |
| Registrazione | `record_audio` (microfono, conteggio, modo `audio` o `hum`; l'utente conferma), `audio_to_midi` (audio monofonico → note, aggancio alla tonalità, quantizzazione con intensità) |
| Mix | `set_track_effects` (amp, EQ, compressore), `set_automation`, `clear_automation` |
| Plugin | `add_plugin` (da una descrizione a parole), `search_plugins`, `list_plugins`, `add_plugin_instrument`, `add_plugin_effect`, `remove_plugin_effect`, `set_plugin_bypass`, `get_plugin_params`, `set_plugin_params`, `show_plugin` |
| File | `export_wav`, `export_midi` (con `save_to` per salvarli in un percorso), `import_midi` |
| Regioni | `add_region`, `update_region`, `delete_region`, `duplicate_region`, `open_editor` |
| Note | `get_region_notes`, `add_notes`, `remove_notes`, `transpose_region`, `quantize_region` |
| Composizione | `add_drum_pattern` (stringhe di step tipo `"x...x...x...x..."`), `add_chord_progression` (`["Am7","Fmaj7","C","G"]`, stile block, arpeggio o stabs) |
| Trasporto | `transport` (play, stop, toggle, rewind), `set_loop`, `set_metronome`, `open_studio` |

Convenzioni: tempo in 4/4; le battute partono da 1; dentro una regione posizioni e durate sono in movimenti (0,25 = sedicesimo); le altezze si danno come numero MIDI, come nome (`"C4"`, `"F#3"`) o, sulla batteria, come nome del pezzo (`"kick"`, `"snare"`, `"hihat"`…).

## Scorciatoie

| Tasto | Azione |
|---|---|
| Spazio / Invio | Play/Stop · Torna all'inizio |
| R · C · M | Registra · Ciclo · Metronomo |
| K | Tastiera musicale (Esc per chiuderla) |
| Y · B · E · X · F · N | Libreria · Smart Controls · Editor · Mixer · Effetti · Analisi |
| ↑ ↓ | Traccia precedente o successiva |
| ⌘Z / ⇧⌘Z | Annulla / Ripristina |
| ⌘D · ⌫ | Duplica regione · Elimina note o regione |
| ⌘A (nell'editor) | Seleziona tutte le note |
| ? | Tutte le scorciatoie |

## Sviluppo

```bash
git clone https://github.com/iltempe/openband.git
cd openband
npm install
npm run dev         # studio con ricarica automatica
npm run typecheck   # TypeScript
npm test            # test unitari (Vitest, in Node)
npm run build       # build di produzione in dist/
node bin/openband.mjs mcp   # il server MCP dal checkout (oppure: claude mcp add openband -- node /percorso/openband/bin/openband.mjs mcp)
node scripts/smoke-pack.mjs # crea il pacchetto npm, lo installa in una cartella vuota e lo prova
npm run pack:mcpb           # build/openband-<versione>.mcpb per Claude Desktop (poi npm run smoke:mcpb)
npm run e2e                 # lo studio compilato in Chrome: primo avvio sotto i 3 s, PWA offline
```

La CI esegue typecheck e test a ogni push e pull request, più le build dei pacchetti (tarball npm su 3 sistemi × Node 18/20/22, il `.mcpb`), i controlli e2e e una prova della release. Release: vedi [docs/RELEASING.md](docs/RELEASING.md); un tag pubblica pacchetto npm, estensione e demo alla stessa versione. La roadmap v0.2 è descritta in [docs/SPEC.md](docs/SPEC.md); le modifiche sono elencate in [CHANGELOG.md](CHANGELOG.md).

## Struttura del codice

```
src/
  types.ts, music.ts      modello dati, teoria (note, accordi, mappa batteria)
  store.ts                stato (zustand), annulla/ripristina, salvataggio automatico
  commands.ts             API dei comandi, condivisa da UI e MCP
  bridge.ts               client WebSocket verso il server MCP
  input.ts                tastiera musicale, Web MIDI, registrazione
  audio/instruments.ts    preset sintetizzati (Tone.js)
  audio/engine.ts         grafo audio live, trasporto, metronomo, misuratori
  audio/render.ts         rendering offline: brano, intervalli, stem (deterministico), WAV
  audio/samples.ts        audio importato (IndexedDB), forme d'onda, riconoscimento della nota
  audio/sampler.ts        strumenti a campioni (campionatore, kit, preset SoundFont)
  audio/soundfont.ts      lettore SoundFont 2
  audio/fx.ts             effetti per traccia (amp, EQ, compressore, slot plugin)
  audio/wam.ts            host Web Audio Modules (catalogo, caricamento, strumenti, effetti)
  audio/context.ts        AudioContext nativo per Tone.js (richiesto dai WAM)
  plugins.ts              ricerca dei plugin a parole, parametri, stato salvato
  lint/                   linter musicale (puro): motore e regole, ingresso CLI
  structure.ts            sezioni: dividi, sposta, duplica (ripple), profili di energia, proposte automatiche
  lyrics/                 sillabe (regole italiane + accento, inglese), allineamento, prosodia, ChordPro (puro)
scripts/openband-lint.mjs  CLI del linter per la CI; .github/actions/openband-lint è la GitHub Action
  automation.ts           curve di automazione
  analysis/               DSP puro: FFT, loudness (BS.1770), spettro, stereo, mascheramento, tonalità, problemi; armonia (accordi, gradi, cadenze)
  workers/                worker di analisi (FFT, loudness, immagini di spettrogramma fuori dal thread principale)
  mixAnalysis.ts          analyze_mix / detect_key / render_spectrogram
  midi.ts                 lettura/scrittura file MIDI, mappatura General MIDI
  importers.ts            import dei suoni, file .openband
  components/             Toolbar, Arrangement, Editor, SmartControls, Mixer, Library, AIPanel…
server/mcp-server.mjs     server MCP (stdio) + bridge WebSocket + file statici
```

## Roadmap

- Registrazione multicanale da schede audio, punch-in e take
- App desktop con Tauri o Electron che ospiti plugin VST/AU nativi
- “Drummer” generativo e libreria di loop con licenza libera (CC0)
- Automazione dei parametri degli effetti; time-stretch delle clip audio

## Licenza

MIT. “GarageBand” è un marchio di Apple Inc.; OpenBand è un progetto indipendente, non affiliato né approvato da Apple.
