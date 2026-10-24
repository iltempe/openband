# L'app desktop di OpenBand

🇬🇧 [English](DESKTOP.md) · 🇮🇹 Italiano · [← README](../README.it.md)

Lo stesso studio della [demo online](https://iltempe.github.io/openband/), in una finestra sua, per macOS,
Windows e Linux, con il server MCP incluso: niente browser, niente Node, niente comandi.

<img src="desktop.png" alt="L'app desktop con la scheda App AI" width="720">

## Scaricala

| Sistema | File |
|---|---|
| macOS, Apple Silicon (M1 e successivi) | [OpenBand-mac-arm64.dmg](https://github.com/iltempe/openband/releases/latest/download/OpenBand-mac-arm64.dmg) |
| macOS, Intel | [OpenBand-mac-x64.dmg](https://github.com/iltempe/openband/releases/latest/download/OpenBand-mac-x64.dmg) |
| Windows 10 e 11 (x64) | [OpenBand-win-x64.exe](https://github.com/iltempe/openband/releases/latest/download/OpenBand-win-x64.exe) |
| Windows su ARM | [OpenBand-win-arm64.exe](https://github.com/iltempe/openband/releases/latest/download/OpenBand-win-arm64.exe) |
| Linux (Ubuntu, Debian…) | [OpenBand-linux-amd64.deb](https://github.com/iltempe/openband/releases/latest/download/OpenBand-linux-amd64.deb) · [AppImage](https://github.com/iltempe/openband/releases/latest/download/OpenBand-linux-x86_64.AppImage) (anche `arm64`) |

Tutti i file sono nella [pagina delle release](https://github.com/iltempe/openband/releases/latest).

## La prima apertura

L'app non è ancora firmata (la firma costa un abbonamento annuale ad Apple e un certificato per Windows),
quindi il sistema ti chiede una conferma, una volta sola:

- **macOS**: apri il `.dmg` e trascina OpenBand in *Applicazioni* (l'immagine disco contiene anche
  questi passaggi, in *Se non si apre*). Fai doppio clic su OpenBand: macOS dice *«OpenBand.app» non è
  stata aperta… Apple non è in grado di verificare…* — premi *Fine*. Poi *Impostazioni di Sistema →
  Privacy e sicurezza*, scorri fino a *«OpenBand.app» è stata bloccata* e premi **Apri comunque**,
  confermando con la password. Da lì in poi si apre normalmente. (Da macOS 15 il clic destro → *Apri*
  non basta più.) Lo stesso con un solo comando nel Terminale:
  `xattr -dr com.apple.quarantine /Applications/OpenBand.app`. L'app non è rotta: macOS blocca ogni app
  scaricata che non sia notarizzata da Apple, cosa che richiede un account sviluppatore a pagamento.
- **Windows**: avvia l'installer; se SmartScreen dice *PC protetto da Windows*, fai clic su *Ulteriori
  informazioni* → *Esegui comunque*.
- **Linux**: `sudo apt install ./OpenBand-linux-amd64.deb`, oppure rendi eseguibile l'AppImage
  (`chmod +x OpenBand-*.AppImage`) e avviala. Da Ubuntu 24.04 in poi l'AppImage potrebbe non partire
  per le regole di sandbox di AppArmor: usa il `.deb`, oppure avviala con `--no-sandbox`.

## Collega la tua AI

Apri il pannello **AI** → **App AI** → *Aggiungi OpenBand alle mie app AI* (oppure *File → Connect to
Claude and other AI apps…*). L'app si aggiunge a Claude Desktop, Claude Code, Cursor e VS Code dove li
trova, tenendo una copia di backup di ogni file che modifica. Riavvia Claude Desktop e chiedi una
canzone: lo studio si apre nell'app.

Come funziona: l'app AI avvia l'eseguibile di OpenBand in modalità Node sul server MCP incluso
nell'app (`server/mcp-server.mjs`, lo stesso di `npx` e del `.mcpb`) e, quando quel server ha bisogno
dello studio, apre l'app invece del browser. Su macOS sposta l'app in *Applicazioni* prima di
collegarla: le app AI ricordano dove si trova. Usa l'app oppure l'estensione per Claude Desktop
(`.mcpb`), non entrambe: aggiungerebbero entrambe gli strumenti di OpenBand.

## Cosa cambia rispetto al browser

- **File**: i file `.openband`, `.mid` e `.dawproject` si aprono con un doppio clic, da *File → Open*
  (⌘O / Ctrl+O) e da *Open Recent*; salvataggi ed esportazioni chiedono dove mettere il file.
- **Menu**: *File* (nuova canzone, apri, salva, esporta WAV / MIDI / DAWproject, collega le app AI),
  *Edit*, *View*, *Window*, *Help* (per ora in inglese). Le scorciatoie dello studio funzionano come nel
  browser.
- **Le canzoni** stanno nella memoria dell'app, separata da quella del browser: per spostare una canzone
  tra i due, salvala come `.openband` e aprila dall'altra parte.
- **Aggiornamenti**: una volta al giorno l'app controlla su GitHub se c'è una nuova versione e ti
  propone di scaricarla (*Check for Updates…* nel menu). Installandola sopra la vecchia, le canzoni restano.
- **Plugin**: i plugin web (WAM) funzionano come nel browser. I plugin nativi VST3 / CLAP / AU si
  costruiscono per fasi ([SPEC v0.6, G8](SPEC-v0.6.md), [ADR 0001](adr/0001-desktop.md)); vedi
  [Plugin nativi](#plugin-nativi) qui sotto.

## Plugin nativi

Gli **strumenti e gli effetti CLAP e VST3** installati sul computer funzionano nell'app: *Plugin* (nella libreria, o *+ Plugin*
negli effetti di una traccia) li elenca in *Installati su questo computer*, accanto ai plugin web. OpenBand
li cerca nelle cartelle standard: CLAP in macOS `~/Library/Audio/Plug-Ins/CLAP` e `/Library/Audio/Plug-Ins/CLAP`,
Windows `Common Files\CLAP`, Linux `~/.clap`, `/usr/lib/clap`; VST3 in macOS `~/Library/Audio/Plug-Ins/VST3` e
`/Library/Audio/Plug-Ins/VST3`, Windows `Common Files\VST3`, Linux `~/.vst3`, `/usr/lib/vst3`. Le esamina un plugin alla volta, ognuno in un processo a
parte: uno che si blocca o si chiude durante la ricerca viene messo da parte (*Ignorati*, con *Riprova*).
Ogni plugin mostra il suo formato (CLAP, VST3); un plugin installato in entrambi i formati compare due volte:
vanno bene tutti e due, e tutto quello che segue vale per entrambi.

![Plugin CLAP e VST3 installati nella finestra dei plugin](native-plugins.png)

- **Ogni plugin gira in un processo suo** (`openband-plughost`): se va in crash, si ferma solo lui. La
  traccia continua a suonare senza, a tempo, lo slot dice *Si è chiuso*, e **Riavvia** lo riapre con lo
  stato salvato nella canzone.
- **A tempo con tutto il resto**: l'audio va al plugin e torna a blocchi, circa 16 ms più la latenza del
  plugin, e OpenBand ritarda altrettanto le altre tracce (compensazione della latenza), dal vivo e negli
  export. Lo slot mostra la latenza.
- **Strumenti**: aggiungine uno da *Plugin* (su una traccia nuova, o sulla traccia strumento da cui hai
  aperto la finestra); suona le note della timeline, una tastiera MIDI e le parti dell'AI. **Modifica** (o
  *Apri plugin* negli Smart Controls) mostra i suoi parametri, con la ricerca, e **Apri la finestra del
  plugin** apre la sua interfaccia, sospesa sopra lo studio (macOS e Windows; su Linux per ora i parametri).
- L'**automazione** di qualsiasi parametro arriva sul campione esatto dentro il blocco audio, e muovere un
  controllo nella finestra del plugin viene registrato in Touch / Latch come qualsiasi manopola dello
  studio. Ogni modifica nella finestra del plugin è un passo di annullamento, e le impostazioni si salvano
  con la canzone.

![Vital, un synth CLAP, su una traccia: i suoi parametri e la sua finestra](native-instrument.png)

- I plugin sono programmi che girano con i tuoi permessi: OpenBand lo dice prima del primo, e li carica
  solo dalle cartelle dei plugin, mai da internet.
- Gli **export** includono i plugin nativi: l'export li fa girare nella loro modalità offline, blocco per
  blocco attraverso il loro host; due export della stessa canzone sono identici al bit, e suonano come
  quello che hai sentito.
- **Le canzoni viaggiano**: quando salvi una canzone come `.openband`, ogni traccia che suona un plugin
  nativo tiene il suo audio "congelato" dentro il file. Aperta nel browser, nello studio online o su un
  computer senza quel plugin, la traccia suona l'audio congelato (**❄ Congelata** accanto al nome) e puoi
  comunque mixarla; se lì cambi le sue note, il badge dice **Non aggiornata**: apri la canzone nell'app
  desktop per congelarla di nuovo, o clicca il badge per scegliere un altro strumento.
- Prossimi passi: AU (macOS); finestre native su Linux.

## Compilarla

```bash
npm ci && npm ci --prefix desktop   # gli strumenti di build dell'app (Electron) stanno in desktop/
npm run build                       # lo studio
npm run desktop:dev                 # avvia l'app dal checkout (profilo "OpenBand (dev)")
npm run desktop:build               # installer per questo sistema in build/desktop/ (--dir: solo l'app)
npm run desktop:smoke               # prova l'app: suona, e un client MCP la comanda
```

Il workflow *Release* costruisce gli installer su macOS, Windows e Linux e li aggiunge alla release su
GitHub. Per firmarli più avanti, aggiungi i secret `CSC_LINK` (il certificato, in base64) e
`CSC_KEY_PASSWORD`; su macOS la notarizzazione richiede anche `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e
`APPLE_TEAM_ID` (vedi la guida alla firma di electron-builder).
