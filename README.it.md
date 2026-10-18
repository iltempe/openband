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
- **Import ed export MIDI** (Standard MIDI File, programmi General MIDI, batteria sul canale 10).
- **Annulla/ripristina**, salvataggio automatico, **esportazione WAV** con rendering offline; i progetti con suoni importati si salvano in un unico file `.openband` che contiene i campioni.
- **Controllo AI via MCP**: 52 strumenti per comporre, arrangiare, importare suoni, aggiungere plugin, mixare, automatizzare ed esportare: l'AI può aggiungere un plugin solo a partire da una descrizione come *“un overdrive valvolare caldo”*.
- Interfaccia in **inglese e italiano**: l'inglese è predefinito, si cambia dalla schermata iniziale o dal menu ⋯.

| Piano roll | Mixer |
|---|---|
| ![Piano roll](docs/editor.png) | ![Mixer con effetti su due tracce](docs/mixer.png) |
| **Effetti** | **Traccia audio** |
| ![Amp, EQ, compressore e un riverbero WAM sul basso](docs/effects.png) | ![Clip audio con forma d'onda](docs/audio.png) |
| **Finestra di un plugin WAM** | **Browser dei plugin** |
| ![Plugin WAM Synth-101](docs/plugins.png) | ![Ricerca dei plugin a parole](docs/plugin-browser.png) |

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

## Suoni, effetti, automazioni e MIDI

- **I tuoi suoni**: usa *Importa suoni* in cima alla libreria. *Campionatore* trasforma file audio in uno strumento (chiamali per esempio `Piano_C4.wav` per indicare i tasti, altrimenti la nota viene riconosciuta); *Kit batteria* assegna i file chiamati kick, snare, hat, clap, tom… ai pezzi del kit; *SoundFont* apre una libreria `.sf2` e ti fa scegliere i preset; *Audio* mette i file sulla timeline. Puoi anche trascinare i file ovunque nello studio. SoundFont gratuiti da provare: FluidR3_GM (MIT) o GeneralUser GS.
- **Salvataggio**: i progetti con suoni importati si salvano in un unico file `.openband` che contiene i campioni, così si aprono ovunque.
- **Effetti**: seleziona una traccia e premi **F** (o clicca *FX* su un canale del mixer). Ogni unità ha il suo pulsante di accensione.
- **Automazioni**: clicca **A** su una traccia per aprirne la corsia, scegli il parametro, clicca per aggiungere punti, trascinali per spostarli, doppio clic per eliminarli.
- **MIDI**: *Importa MIDI…* / *Esporta MIDI* nel menu ⋯, oppure trascina un file `.mid` nello studio.
- **Plugin**: clicca *Plugin* nella libreria e descrivi cosa ti serve (*“riverbero ampio e scuro”*, *“monophonic synth”*) o filtra per strumenti/effetti; gli strumenti hanno una loro traccia, gli effetti si aggiungono alla traccia selezionata (anche da *+ Plugin* nel pannello Effetti). *Modifica* apre la finestra del plugin. I plugin arrivano dalla [raccolta WAM della community](https://github.com/boourns/wam-community) e serve una connessione internet la prima volta che si caricano.

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

> Aggiungi un overdrive valvolare caldo al basso e un riverbero ampio al pad, poi apri l'overdrive così lo regolo.

> Importa ~/Samples/voce.wav come traccia audio alla battuta 5, metti un compressore sul basso, fai entrare il pad in dissolvenza in due battute e salva il brano come ~/Desktop/brano.wav e brano.mid.

Variabili d'ambiente: `OPENBAND_PORT` (predefinita 7777; se la cambi, apri l'app con `?mcp=<porta>`) e `OPENBAND_DEV_URL` (predefinita `http://localhost:5173`).

Il bridge accetta connessioni solo da `127.0.0.1` e da pagine servite su localhost.

### Strumenti MCP

| Area | Strumenti |
|---|---|
| Progetto | `get_project`, `get_status`, `list_instruments`, `new_project`, `rename_project`, `set_tempo`, `set_key`, `set_master_volume`, `export_project_json`, `import_project_json`, `undo`, `redo` |
| Tracce | `add_track` (strumento, batteria o audio), `update_track` (strumento, volume, pan, mute, solo, riverbero, eco, tono), `delete_track` |
| Suoni | `import_sample`, `list_samples`, `create_sampler_instrument`, `import_soundfont`, `add_audio_region` — i file si leggono da un percorso locale o da un URL http(s) |
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
| Y · B · E · X · F | Libreria · Smart Controls · Editor · Mixer · Effetti |
| ↑ ↓ | Traccia precedente o successiva |
| ⌘Z / ⇧⌘Z | Annulla / Ripristina |
| ⌘D · ⌫ | Duplica regione · Elimina note o regione |
| ⌘A (nell'editor) | Seleziona tutte le note |

## Sviluppo

```bash
npm run dev         # studio con ricarica automatica
npm run typecheck   # TypeScript
npm test            # test unitari (Vitest, in Node)
npm run build       # build di produzione in dist/
```

La CI esegue typecheck e test a ogni push e pull request. La roadmap v0.2 è descritta in [docs/SPEC.md](docs/SPEC.md); le modifiche sono elencate in [CHANGELOG.md](CHANGELOG.md).

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
  audio/samples.ts        audio importato (IndexedDB), forme d'onda, riconoscimento della nota
  audio/sampler.ts        strumenti a campioni (campionatore, kit, preset SoundFont)
  audio/soundfont.ts      lettore SoundFont 2
  audio/fx.ts             effetti per traccia (amp, EQ, compressore, slot plugin)
  audio/wam.ts            host Web Audio Modules (catalogo, caricamento, strumenti, effetti)
  audio/context.ts        AudioContext nativo per Tone.js (richiesto dai WAM)
  plugins.ts              ricerca dei plugin a parole, parametri, stato salvato
  automation.ts           curve di automazione
  midi.ts                 lettura/scrittura file MIDI, mappatura General MIDI
  importers.ts            import dei suoni, file .openband
  components/             Toolbar, Arrangement, Editor, SmartControls, Mixer, Library, AIPanel…
server/mcp-server.mjs     server MCP (stdio) + bridge WebSocket + file statici
```

## Roadmap

- Registrazione audio da microfono o scheda audio per chitarra
- App desktop con Tauri o Electron che ospiti plugin VST/AU nativi
- “Drummer” generativo e libreria di loop con licenza libera (CC0)
- Automazione dei parametri degli effetti; time-stretch delle clip audio

## Licenza

MIT. “GarageBand” è un marchio di Apple Inc.; OpenBand è un progetto indipendente, non affiliato né approvato da Apple.
