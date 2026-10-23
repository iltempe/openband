# OpenBand

🇬🇧 [English](README.md) · 🇮🇹 Italiano

**Uno studio musicale open source in stile GarageBand, che gira nel browser e che puoi far suonare anche alla tua AI tramite il Model Context Protocol (MCP).**

![OpenBand mentre suona una canzone](docs/demo.gif)

Chiedi alla tua AI (Claude, ChatGPT, Gemini o un modello locale) *“crea un beat lo-fi a 82 BPM in Re minore con batteria, basso e Rhodes, poi mettilo in loop”* e guarda tracce, note e mixer muoversi in tempo reale. Oppure suona tu: tracce, piano roll, step sequencer, 15 strumenti sintetizzati, mixer, effetti, plugin, registrazione dal microfono.

## Per iniziare

Scegli il modo che fa per te. Nessuno richiede di clonare o compilare.

| | Hai | Fai così |
|---|---|---|
| 🎹 **Solo provare** | un browser | Apri la **[demo online](https://iltempe.github.io/openband/)** e premi **🎲 Sorprendimi** |
| 🖥 **App desktop** | macOS, Windows o Linux | **[Scaricala](docs/DESKTOP.it.md#scaricala)**: lo studio in una finestra sua, collegato a Claude con un clic |
| 🤖 **Claude Desktop** | Claude Desktop | **[⬇ Scarica openband.mcpb](https://github.com/iltempe/openband/releases/latest/download/openband.mcpb)**, fai doppio clic, scegli *Installa* |
| 💻 **Claude Code, Cursor, VS Code** | [Node 18+](https://nodejs.org) | Esegui il comando qui sotto |
| 🔑 **L'AI che preferisci** | un browser | [Demo](https://iltempe.github.io/openband/) → pannello **AI** → *Modello AI*: Claude, OpenAI, Gemini con la tua chiave, o un modello gratuito sul tuo computer con Ollama |

**Il comando** (Claude Code, Cursor, VS Code, o Claude Desktop senza l'estensione) trova i client AI sul tuo computer e ci aggiunge OpenBand, chiedendo prima e tenendo una copia di backup di ogni file che modifica:

```bash
npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz setup
```

Poi riavvia il client AI e chiedigli una canzone: lo studio si apre da solo nel browser. Preferisci farlo a mano? Per Claude Code è `claude mcp add openband -- npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz mcp`; il JSON per gli altri client è in [docs/CONNECT.it.md](docs/CONNECT.it.md). Lo stesso comando senza `setup` apre solo lo studio, e con `doctor` controlla che sia tutto a posto.

> **Perché non `npx openband`?** Il nome `openband` su npm appartiene a qualcun altro, quindi OpenBand si installa dalle sue release su GitHub. `--allow-remote=all` permette a npm 12 (Node 26) di scaricare un pacchetto da un indirizzo; le versioni precedenti di npm lo ignorano.

**Qualsiasi AI.** Nella pagina la chat usa Claude, i modelli di OpenAI, Gemini o un modello locale con Ollama, con gli stessi strumenti dei client MCP; la chiave resta nel tuo browser e le richieste vanno direttamente al fornitore. Via MCP OpenBand funziona con Claude Desktop, Claude Code, Codex, Gemini CLI, Cursor, VS Code, claude.ai e la modalità sviluppatore di ChatGPT: vedi **[docs/AI-MODELS.it.md](docs/AI-MODELS.it.md)**.

## La tua prima canzone

1. **Parti dalla musica.** Nella prima schermata premi **🎲 Sorprendimi** (un loop di 8 battute con batteria e basso, senza AI), **🎤 Canticchia un’idea** (canta 4 battute, ottieni una melodia con accordi e ritmo) o scegli una degli 8 *Brani d’esempio*. Un tour in 5 passi ti fa da guida, e `?` mostra tutte le scorciatoie.
2. **Chiedi alla tua AI.** Prova:
   > Crea un beat lo-fi a 82 BPM in Re minore con batteria, basso e Rhodes, poi fai partire il loop.

   > Aggiungi un overdrive valvolare caldo al basso e un riverbero ampio al pad, poi apri l'overdrive così lo regolo.

   > Dammi 4 linee di basso come take e avvia un test alla cieca.
3. **Cambia tutto a mano.** Trascina le regioni, modifica le note nel piano roll (**E**), mixa (**X**), aggiungi effetti (**F**). Tutto quello che l'AI ha fatto per una richiesta si annulla in un solo passo.
4. **Tienila.** Le canzoni si salvano nel browser mentre lavori. Esporta un **WAV**, un file **MIDI**, un `.dawproject` per Bitwig, Studio One o Cubase, o un file `.openband` con dentro i tuoi suoni.

<img src="docs/welcome.png" alt="Schermata iniziale: Sorprendimi, Canticchia un'idea, Chiedi all'AI, Apri un file" width="640">

## Cosa fa

- **Un piccolo studio completo**: tracce di strumenti, batteria e audio, piano roll, step sequencer, mixer con mandate, effetti (ampli, EQ, compressore), automazione di qualsiasi parametro, plugin [WAM](https://www.webaudiomodules.com) a standard aperto, i tuoi campioni e SoundFont, controller MIDI e tastiera musicale.
- **L'AI suona, ascolta e spiega**: 129 strumenti MCP per comporre, arrangiare, mixare ed esportare; `analyze_mix` misura loudness, bilanciamento e mascheramenti e suggerisce correzioni; *Spiega* appunta commenti sulla canzone; un batterista che segue le tue sezioni.
- **Crea una parte a parole** (✦ Crea): *«batteria funk»*, *«piano arpeggiato»*: la suonano i motori di OpenBand o i modelli musicali che installi, adattata a tempo, tonalità e battute della canzone, con il registro di chi ha suonato cosa. Vedi [Ensemble](docs/ENSEMBLE.it.md).
- **Jam con l'AI**: suoni una frase e lei risponde alla battuta dopo, con note fantasma che puoi tenere.
- **Registra come in studio**: microfono o scheda audio, più ingressi insieme, punch-in con pre-roll, take e comping, test A/B alla cieca, segnalini degli errori, dalla voce al MIDI.
- **Non perdi mai il lavoro**: versioni e rami come git per le canzoni (con merge e vista di confronto), una macchina del tempo di 30 giorni e il recupero dopo un crash.
- **Suonate insieme**: condividi un link e modificate la stessa canzone dal vivo, con l'AI come terzo musicista.
- **Funziona offline** una volta installata come app (Chrome/Edge: *Installa OpenBand*; Safari: *Aggiungi al Dock*), in italiano e in inglese.

**→ [Tutte le funzionalità](docs/FEATURES.it.md)** · [tutti gli strumenti MCP](docs/MCP-TOOLS.it.md)

| Arrangiamento e mixer | Chat con Claude nella pagina | Versioni e vista di confronto |
|---|---|---|
| ![Mixer con effetti su due tracce](docs/mixer.png) | ![Chat con Claude dentro lo studio](docs/chat.png) | ![Pannello Versioni con i rami e la vista di confronto](docs/versions.png) |
| **Piano roll** | **Cosa sente l'AI** | **Loop e batterista** |
| ![Piano roll](docs/editor.png) | ![Pannello Analisi](docs/analysis.png) | ![Scheda Loop, una parte del batterista e loop nella canzone](docs/loops.png) |

## Scorciatoie

| Tasto | Azione |
|---|---|
| Spazio / Invio | Play/Stop · Torna all'inizio |
| R · C · M | Registra · Ciclo · Metronomo |
| K | Tastiera musicale (Esc per chiudere) |
| Y · B · E · X · F · N | Libreria · Smart Controls · Editor · Mixer · Effetti · Analisi |
| ⌘Z / ⇧⌘Z | Annulla / Ripeti |
| ? | Tutte le scorciatoie |

## Altro

- **[App desktop](docs/DESKTOP.it.md)**: download, prima apertura, collegare le app AI, compilarla.
- **[Qualsiasi AI](docs/AI-MODELS.it.md)**: Claude, ChatGPT / OpenAI, Gemini, Ollama e altri modelli locali.
- **[Collegare un'AI](docs/CONNECT.it.md)**: come funziona, ogni client, abbinare la demo online al tuo computer, variabili d'ambiente, problemi.
- **[Ospitare il proprio OpenBand](docs/SELF-HOSTING.it.md)**: Netlify, Vercel, Cloudflare, GitHub Pages, Docker; stanze nella tua rete; OpenBand come connettore di claude.ai (anche dal telefono).
- **[Ensemble](docs/ENSEMBLE.it.md)**: crea parti con i motori, aggiungi i tuoi modelli, le tue regole di licenza e privacy, il registro dei contributi.
- **[Open Music Engine Profile](omep/README.md)** (in inglese): lo standard aperto con cui qualsiasi modello musicale può suonare in OpenBand (o in qualsiasi studio), con la sua suite di conformità.
- **[Sviluppo](docs/DEVELOPMENT.it.md)**: compilare dai sorgenti, test, struttura del codice. Modifiche: [CHANGELOG.md](CHANGELOG.md).
- Qualcosa non va? Nello studio, *⋯ → Diagnostica → Segnala un problema* apre una segnalazione già compilata (niente delle tue canzoni, mai le tue chiavi).

OpenBand è un'implementazione *clean-room*: riproduce il flusso di lavoro di una DAW consumer con codice e suoni scritti da zero, e non contiene codice, campioni, loop o grafica di Apple: ogni strumento è sintetizzato in tempo reale. I contributi sono benvenuti: apri una issue o una pull request. Se il progetto ti piace, una ⭐ aiuta altre persone a trovarlo.

## Licenza

MIT. “GarageBand” è un marchio di Apple Inc.; OpenBand è un progetto indipendente, non affiliato né approvato da Apple.
