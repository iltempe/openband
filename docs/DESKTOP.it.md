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

- **macOS**: apri il `.dmg` e trascina OpenBand in *Applicazioni*. La prima volta, clic destro su
  OpenBand → *Apri* → *Apri*. Da macOS 15 in poi: aprila una volta, poi *Impostazioni di Sistema →
  Privacy e sicurezza* → *Apri comunque*. Se macOS dice che l'app è *danneggiata*, è stata messa in
  quarantena durante il download: esegui `xattr -dr com.apple.quarantine /Applications/OpenBand.app`
  nel Terminale.
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
- **Plugin**: i plugin web (WAM) funzionano come nel browser. I plugin nativi VST3 / CLAP sono il
  prossimo passo ([ADR 0001](adr/0001-desktop.md)).

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
