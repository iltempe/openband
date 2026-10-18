# OpenBand

🇬🇧 [English](README.md) · 🇮🇹 Italiano

**Uno studio musicale open source in stile GarageBand, che gira nel browser e che puoi far suonare anche alla tua AI tramite il Model Context Protocol (MCP).**

### ▶ [Prova la demo online](https://iltempe.github.io/openband/) — niente da installare

![OpenBand in riproduzione](docs/demo.gif)

OpenBand è una reimplementazione *clean-room*: riproduce il flusso di lavoro di una DAW consumer (tracce, regioni, piano roll, step sequencer, Smart Controls, mixer, tastiera musicale) con codice e suoni scritti da zero. Non contiene codice, campioni, loop o grafica di Apple: tutti gli strumenti sono sintetizzati in tempo reale, quindi il progetto è liberamente ridistribuibile con licenza MIT.

## Funzionalità

- **Arrangiamento**: tracce strumento e batteria; regioni MIDI da trascinare, ridimensionare, duplicare (⌥-trascina o ⌘D) e spostare tra tracce dello stesso tipo; righello con ciclo (loop) e zoom (⌘ + rotella).
- **Piano roll**: aggiungi, sposta, allunga e cancella note; griglia da 1/4 a 1/32 e terzine; trasposizione, quantizzazione e velocity.
- **Step sequencer** per la batteria: 11 pezzi (cassa, rullante, clap, rim, hi-hat chiuso e aperto, 3 tom, crash, ride), disegno a trascinamento, accenti.
- **15 strumenti sintetizzati**: piano, piano elettrico FM, organo, campane, lead, pluck, 8-bit, 3 bassi, pad, archi e 3 kit di batteria (Studio, Trap 808, Lo-Fi).
- **Smart Controls**: volume, pan, brillantezza (filtro), riverbero ed eco per traccia.
- **Mixer** con misuratori di livello, fader, mute e solo, mandate e master.
- **Tastiera musicale** (tasti A–' come un pianoforte, Z/X per l'ottava, C/V per la velocity) e **Web MIDI** per i controller esterni.
- **Registrazione** dal vivo in nuove regioni, con metronomo.
- **Annulla/ripristina**, salvataggio automatico, salvataggio e apertura dei progetti `.json`, **esportazione WAV** con rendering offline.
- **Controllo AI via MCP**: 32 strumenti per comporre, arrangiare, mixare e riprodurre.
- Interfaccia in **inglese e italiano**: l'inglese è predefinito, si cambia dalla schermata iniziale o dal menu ⋯.

| Piano roll | Mixer |
|---|---|
| ![Piano roll](docs/editor.png) | ![Mixer](docs/mixer.png) |

> Nella demo online l'AI non può collegarsi: per motivi di sicurezza il server MCP accetta solo pagine servite da localhost. Per farla suonare alla tua AI, avvia OpenBand in locale come spiegato qui sotto.

## Avvio rapido

```bash
npm install
npm run dev          # apri http://localhost:5173
```

Oppure compila una volta: il server MCP servirà l'app da solo su `http://127.0.0.1:7777`.

```bash
npm run build
```

Al primo avvio si apre un brano demo. Il clic su “Entra nello studio” (“Enter the studio” in inglese) serve perché i browser abilitano l'audio solo dopo un'interazione dell'utente.

## Collegare un'AI (MCP)

```
Client AI (Claude Desktop, Claude Code, Cursor…)
        │  stdio · MCP
        ▼
server/mcp-server.mjs ──── WebSocket ws://127.0.0.1:7777/bridge ────▶ OpenBand nel browser
```

Il client avvia il server MCP, che inoltra ogni chiamata alla finestra di OpenBand aperta. Ogni comando ricevuto compare nel pannello **AI** dell'app (il pulsante “MCP” in alto a destra).

**Claude Desktop**: aggiungi in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) o `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "openband": {
      "command": "node",
      "args": ["/percorso/assoluto/openband/server/mcp-server.mjs"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add openband -- node /percorso/assoluto/openband/server/mcp-server.mjs
```

Poi apri lo studio (`npm run dev`, oppure lascia che l'AI chiami `open_studio` dopo un `npm run build`) e chiedi, per esempio:

> Crea un beat lo-fi a 82 BPM in Re minore con batteria, basso e Rhodes, poi fai partire il loop.

Variabili d'ambiente: `OPENBAND_PORT` (predefinita 7777; se la cambi, apri l'app con `?mcp=<porta>`) e `OPENBAND_DEV_URL` (predefinita `http://localhost:5173`).

Il bridge accetta connessioni solo da `127.0.0.1` e da pagine servite su localhost.

### Strumenti MCP

| Area | Strumenti |
|---|---|
| Progetto | `get_project`, `get_status`, `list_instruments`, `new_project`, `rename_project`, `set_tempo`, `set_key`, `set_master_volume`, `export_project_json`, `import_project_json`, `export_wav`, `undo`, `redo` |
| Tracce | `add_track`, `update_track` (strumento, volume, pan, mute, solo, riverbero, eco, tono), `delete_track` |
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
| Y · B · E · X | Libreria · Smart Controls · Editor · Mixer |
| ↑ ↓ | Traccia precedente o successiva |
| ⌘Z / ⇧⌘Z | Annulla / Ripristina |
| ⌘D · ⌫ | Duplica regione · Elimina note o regione |
| ⌘A (nell'editor) | Seleziona tutte le note |

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
  audio/render.ts         rendering offline in WAV
  components/             Toolbar, Arrangement, Editor, SmartControls, Mixer, Library, AIPanel…
server/mcp-server.mjs     server MCP (stdio) + bridge WebSocket + file statici
```

## Roadmap

- Tracce audio (microfono e chitarra) con forma d'onda
- Effetti per traccia (compressore, EQ, amp sim) e automazioni
- “Drummer” generativo e libreria di loop con licenza libera (CC0)
- Import ed export MIDI
- App desktop con Tauri o Electron

## Licenza

MIT. “GarageBand” è un marchio di Apple Inc.; OpenBand è un progetto indipendente, non affiliato né approvato da Apple.
