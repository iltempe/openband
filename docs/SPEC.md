# OpenBand — Specifica v0.2 "L'AI che ascolta"

> Documento per Claude Code. Mettilo in `docs/SPEC.md` del repo e lavora **una milestone alla volta, una feature per PR**.
> Ogni feature ha: obiettivo, modello dati, comandi/tool MCP, implementazione (file), UI, criteri di accettazione.
> Basata sul codice attuale (`main`, commit corrente): `types.ts`, `store.ts`, `commands.ts`, `bridge.ts`, `audio/render.ts`, `server/mcp-server.mjs`.

---

## 0. Regole per Claude Code (valgono per tutte le feature)

### Architettura da rispettare
- **Un solo punto di verità per i comandi**: ogni nuova capacità è un comando in `src/commands.ts` (snake_case, argomenti in snake_case, ritorna JSON serializzabile). La UI chiama gli stessi comandi via `runCommand(method, params, 'ui')`.
- **Ogni comando esposto all'AI** va registrato in `server/mcp-server.mjs` con `tool(...)` + schema zod + descrizione chiara. I tool di sola lettura hanno `readOnly`. Aggiorna anche `INSTRUCTIONS` se cambia il workflow consigliato.
- **Convenzioni musicali invariate**: 4/4, battute 1-based nei tool, beat (quarti) nel modello dati, pitch MIDI o nomi (`"C4"`), velocity 0..1.
- **Logica pura separata dalla UI e dall'audio**: analisi, lint, diff, sillabazione, riconoscimento accordi vanno in moduli puri (`src/analysis/`, `src/lint/`, `src/lyrics/`, `src/versions/`) senza import da React/Tone/store, così sono testabili in Node e riusabili in CI.
- **DSP pesante in Web Worker** (`src/workers/`), mai sul main thread: FFT, loudness, pitch tracking.
- **i18n**: ogni stringa UI nuova in `src/i18n.ts`, sia `en` sia `it`.
- **Clean-room e licenze**: niente codice/asset proprietari. Dipendenze nuove solo MIT/Apache-2.0/BSD/ISC, e solo se evitano >200 righe di codice non banale. Giustificale nella PR.
- **Retrocompatibilità**: progetti v1 (localStorage, `.openband.json`, `.openband` zip) devono continuare ad aprirsi, migrati a v2.

### Definition of Done (per ogni feature)
1. `npm run typecheck` e `npm test` verdi.
2. Test unitari per tutta la logica pura nuova (vitest).
3. Comandi + tool MCP + i18n IT/EN + riga nella tabella "MCP tools" di `README.md` e `README.it.md`.
4. Undo funzionante sulla feature (via transazioni, vedi F1).
5. Il progetto demo (`src/demo.ts`) si apre senza errori.
6. Nota nel CHANGELOG (crealo se non c'è).

### Timeout bridge
`call()` nel server ha default 20 s. Tutto ciò che renderizza audio (analisi, confronto, conversione) usa `opts.timeout = 180000`.

---

## Milestone e ordine di lavoro

| Milestone | Feature | Dipende da |
|---|---|---|
| **M0 Fondamenta** | F0 test infra · F1 transazioni/undo per intento · F2 schema v2 + migrazioni · F3 canale eventi studio→AI · F4 renderer riusabile | — |
| **M1 Orecchie** | F5 `analyze_mix` + spettrogramma · F6 reference matching · F7 linter musicale + CI | M0 |
| **M2 Cantautore** | F8 sezioni · F9 analisi armonica · F10 lyrics + prosodia + ChordPro · F11 registrazione mic + hum-to-MIDI | M0 (F10 dipende da F8, F9) |
| **M3 Workflow** | F12 take + A/B alla cieca · F13 versioni/branch/diff/merge · F14 modalità "spiegami" · F15 call-and-response live | M0, F3 |
| **M4 Insieme** | F16 multiplayer (Yjs) con AI come peer | tutto |

---

# M0 — Fondamenta

## F0 · Infrastruttura di test

- Aggiungi `vitest` (devDependency) e script `"test": "vitest run"`, `"test:watch": "vitest"`.
- Config in `vite.config.ts` (`test: { environment: 'node' }`), con override `jsdom` solo dove serve.
- Crea `src/__fixtures__/projects.ts` con 3 progetti di riferimento: demo, progetto vuoto, progetto "sporco" (note fuori tonalità, sovrapposizioni, clipping simbolico) usato dal linter.
- Aggiungi job `test` al workflow GitHub (nuovo `.github/workflows/ci.yml`: `npm ci && npm run typecheck && npm test` su push e PR).

**Accettazione**: `npm test` gira in CI su ogni PR.

---

## F1 · Transazioni e undo per intento

**Problema**: oggi ogni `commit()` crea uno snapshot. Una richiesta AI ("fammi un beat lo-fi") genera 30-40 voci di history; ⌘Z annulla un pezzetto alla volta.

### Modello
In `store.ts` la history diventa etichettata:
```ts
interface HistoryEntry {
  project: Project;
  label: string;           // "Beat lo-fi 82 BPM" | "Sposta regione"
  source: 'ui' | 'ai';
  commands: number;        // quanti comandi raggruppa
  at: number;
}
past: HistoryEntry[]; future: HistoryEntry[];
```

### API store
```ts
beginTransaction(label: string, source: 'ui' | 'ai'): string   // ritorna tx id
endTransaction(txId: string): void
activeTransaction: { id; label; source; commands; snapshot: Project } | null
```
- Dentro una transazione, `commit()` **non** pusha history: lo snapshot è preso una volta sola a `beginTransaction`.
- `endTransaction` pusha una sola `HistoryEntry` (solo se il progetto è cambiato).
- Transazioni annidate: contatore di profondità, conta solo la più esterna.

### Raggruppamento automatico dei comandi AI
In `runCommand` con `source === 'ai'`:
- Se non c'è una transazione aperta, ne apre una con label provvisoria = `shortSummary` del primo comando.
- Chiusura automatica dopo **4 s di inattività** del bridge (configurabile), oppure su `end_change`.
- Ogni comando AI incrementa `commands`.

### Tool MCP nuovi
| Tool | Args | Note |
|---|---|---|
| `begin_change` | `label: string` | L'AI dichiara l'intento ("Beat lo-fi in Re minore"). Chiude l'eventuale transazione automatica aperta. |
| `end_change` | — | Chiude e ritorna `{label, commands}` |
| `get_history` | `limit?` | readOnly: lista `{label, source, commands, at}` per past/future |
| `undo` / `redo` | `steps?` | esistenti, ora operano per entry |

Aggiorna `INSTRUCTIONS`: *"Wrap every user request in begin_change(label) … end_change() so the user can undo it in one step."*

### UI
- Tooltip/voce menu: "Annulla: Beat lo-fi (23 comandi)".
- Nel pannello AI, i comandi sono raggruppati per transazione, con un pulsante "↶ Annulla questo" per transazione (solo se è l'ultima; altrimenti disabilitato con tooltip).
- I drag UI esistenti (`checkpoint()`) diventano `beginTransaction('Sposta regione','ui')`/`endTransaction` su pointerdown/up.

**Accettazione**
- Test: 10 comandi AI consecutivi → 1 sola entry; `undo` ripristina lo stato iniziale.
- Test: `begin_change`/`end_change` espliciti; transazione vuota non crea entry.
- Test: drag UI produce 1 entry.

---

## F2 · Schema progetto v2 + migrazioni

Tutte le feature successive aggiungono campi opzionali a `Project`. Si fa **una sola** migrazione v1→v2 ora, con i campi già previsti.

```ts
export interface Project {
  version: 2;
  // …campi v1 invariati…
  sections?: Section[];             // F8
  lyrics?: LyricsDoc;               // F10
  annotations?: Annotation[];       // F14
  reference?: ReferenceTrack;       // F6
  meta?: { createdAt: number; updatedAt: number; projectId: string }; // F13
}
```
- `src/migrations.ts`: `migrate(raw: unknown): Project` — accetta v1 e v2, riempie `meta.projectId` (uid) se mancante, valida forma minima, lancia errore chiaro se illeggibile.
- Usala in: `loadSaved()` (store), `import_project_json`, apertura `.openband`/`.openband.json` (`importers.ts`), `loadProject`.
- Cambia `STORAGE_KEY` → `openband.project.v2` con lettura di fallback della chiave v1.
- `Region` guadagna campi opzionali per F12: `takes?: Take[]; activeTakeId?: string`.

**Accettazione**: test di migrazione con un JSON v1 reale (esporta la demo attuale prima del refactor e mettila in fixture).

---

## F3 · Canale eventi studio → AI

**Problema**: oggi il bridge è solo AI → studio. L'AI non sa cosa fa l'utente.

### Protocollo bridge
Nuovo messaggio dal browser: `{ type: 'event', event: StudioEvent }`.
```ts
type StudioEvent =
  | { kind: 'phrase'; track_id: string; start_bar: number; notes: NoteOut[] }      // frase suonata live (MIDI/typing), vedi sotto
  | { kind: 'selection'; track_id?: string; region_id?: string; note_ids?: string[] }
  | { kind: 'transport'; action: 'play'|'stop'|'loop'; bar: number }
  | { kind: 'user_edit'; label: string }                                            // a fine transazione UI
  | { kind: 'region_recorded'; region_id: string }
  | { kind: 'ask'; text: string; context?: { region_id?: string; section_id?: string } } // pulsante "Chiedi all'AI"/"Spiega"
  | { kind: 'ab_result'; test_id: string; ranking: string[] };                     // F12
// ogni evento ha anche: id (seq crescente), at (ms)
```
- **Segmentazione frasi** (`src/input.ts`): le note live (anche senza registrazione) vengono accumulate; una frase si chiude dopo **1 battuta di silenzio**. Le posizioni sono in beat relativi alla battuta d'inizio, quantizzate a 1/16 (valori originali in `raw_start`).
- Throttle: `selection` max 1 evento/500 ms.

### Server
- Ring buffer di 500 eventi in `mcp-server.mjs`.
- Tool:
  - `get_events({ since_id?, kinds?, limit? })` → readOnly, ritorna eventi + `last_id`.
  - `wait_for_event({ kinds?, timeout_ms ≤ 60000 })` → long-poll; ritorna il primo evento corrispondente o `{timeout:true}`.
- Risorsa MCP `openband://project` (JSON di `get_project`) con `subscribe` e `notifications/resources/updated` emesso a fine transazione, per i client che supportano le subscription.
- Opzione privacy: toggle "Condividi la mia attività con l'AI" nel pannello AI (default ON in localhost). Se OFF il browser non invia eventi (tranne `ask` e `ab_result`, che sono espliciti).

**Accettazione**: test del segmentatore di frasi (puro); test server: `wait_for_event` si risolve su evento e va in timeout correttamente.

---

## F4 · Renderer riusabile

Refactor di `audio/render.ts` (prerequisito per analisi, confronto, lint audio):
```ts
interface RenderOptions {
  fromBeat?: number; toBeat?: number;   // range (default: tutto)
  tracks?: string[];                    // solo queste tracce (stems); default: mix rispettando mute/solo
  includeMaster?: boolean;              // default true
  sampleRate?: number;                  // default 44100
  tailSeconds?: number;                 // default 3 (0 per analisi di sezione)
}
export async function renderBuffer(p: Project, o?: RenderOptions): Promise<AudioBuffer>;
export async function renderStems(p: Project, o?: RenderOptions): Promise<Record<string, AudioBuffer>>; // una traccia per volta, stesso range
export async function renderProject(p: Project): Promise<Blob>; // invariata esternamente, usa renderBuffer
```
- Il range si implementa avviando il transport a `fromBeat` e dimensionando l'OfflineContext sulla durata.
- Le stem si renderizzano in sequenza (non in parallelo) per limitare la memoria.
- Cache: hash di `(project JSON senza ui-state, options)` → buffer, LRU di 3 elementi, invalidata a ogni commit.

**Accettazione**: WAV esportato bit-identico (o differenza < -90 dBFS) prima/dopo il refactor sulla demo.

---

# M1 — Orecchie

## F5 · `analyze_mix` — l'AI sente il mix

### Modulo puro `src/analysis/`
- `fft.ts` — FFT radix-2 reale, finestra Hann. Niente dipendenze.
- `loudness.ts` — ITU-R BS.1770-4 / EBU R128: filtro K (due biquad), blocchi 400 ms overlap 75%, gating assoluto -70 LUFS e relativo -10 LU. Ritorna integrated LUFS, short-term max (3 s), LRA, true-peak (oversampling 4× con interpolazione), RMS, crest factor, sample sopra 0 dBFS.
- `spectrum.ts` — energia media per banda (dB) su 7 bande:
  `sub 20–60 · bass 60–250 · lowmid 250–500 · mid 500–2k · highmid 2k–4k · presence 4k–6k · air 6k–20k`
  + centroide spettrale + curva 1/3 di ottava (31 punti) per il confronto con reference.
- `stereo.ts` — correlazione L/R, larghezza (side/mid energy ratio) totale e per banda, compatibilità mono (perdita in dB sommando L+R).
- `masking.ts` — per ogni coppia di stem, per ogni banda: `overlap = min(Ea, Eb)` normalizzato sull'energia del mix in quella banda, solo nei frame in cui entrambe sono attive (> -50 dBFS). Ritorna le top-5 coppie/banda con `score 0..1`.
- `key.ts` — tonalità: (a) **simbolica** dai MIDI (istogramma pitch-class pesato per durata × velocity, Krumhansl-Schmuckler); (b) **audio** da cromagramma per le tracce audio. Ritorna `{key, confidence, alternatives[2]}` e se differisce da `project.key`.
- `issues.ts` — regole che trasformano metriche in problemi leggibili con suggerimento concreto, es.:
  - `true_peak > -1 dBTP` → "Picchi a +0.4 dBTP: abbassa il master di 1.5 dB o aggiungi un limiter".
  - masking basso/kick in `bass` con score > 0.6 → "Basso e kick si coprono a 60–250 Hz: taglia 2–3 dB a 80 Hz sul basso o sidechain".
  - `sub` > `bass` + 6 dB → "Troppo sub".
  - correlazione < 0 → "Problemi di fase in mono".
  - LUFS < -20 → "Mix molto basso rispetto agli standard streaming (-14 LUFS)".

Tutto gira in `src/workers/analysis.worker.ts`: il main thread passa i Float32Array dei canali (transferable).

### Tool MCP
| Tool | Args | Ritorna |
|---|---|---|
| `analyze_mix` | `from_bar?, to_bar?, section_id?, per_track?: boolean (default true), detail?: 'summary'\|'full'` | vedi sotto |
| `render_spectrogram` | `from_bar?, to_bar?, track_id?, width?=1024, height?=384` | **contenuto immagine MCP** (`{type:'image', mimeType:'image/png', data}`) — Claude lo vede |
| `detect_key` | `source?: 'midi'\|'audio'\|'both'` | `{key, confidence, alternatives, matches_project_key}` |

Output `analyze_mix` (`summary`, compatto per il contesto dell'LLM):
```json
{
  "range": {"from_bar": 1, "to_bar": 17},
  "master": {"lufs_integrated": -15.8, "lufs_short_max": -12.1, "true_peak_dbtp": -0.6,
             "crest_db": 11.2, "correlation": 0.71, "mono_loss_db": 0.8,
             "bands_db": {"sub": -32, "bass": -21, "lowmid": -24, "mid": -26, "highmid": -31, "presence": -35, "air": -41}},
  "tracks": [{"id": "trk_x", "name": "Bass", "lufs": -19.3, "peak_db": -4.1, "dominant_band": "bass", "share_of_mix": 0.34}],
  "masking": [{"a": "Bass", "b": "Kick", "band": "bass", "score": 0.72}],
  "key": {"detected": "Dm", "project": "Dm", "confidence": 0.81},
  "issues": [{"severity": "warn", "code": "masking_low_end", "message": "...", "suggestion": "...", "tracks": ["trk_x"]}]
}
```
`full` aggiunge curve 1/3 d'ottava e statistiche per battuta (LUFS momentary per battuta → l'AI vede la dinamica dell'arrangiamento).

`render_spectrogram`: STFT nel worker, disegno su `OffscreenCanvas` (asse log-frequenza, colormap percettiva, griglia battute e nomi sezioni), `convertToBlob` → base64. Nel server serve un tool dedicato che ritorni `content: [{type:'image', …}]` invece di `text()`.

### UI
- Nuovo pannello "Analisi" (tasto **N**): meter LUFS/true-peak, barre per banda, lista problemi cliccabili (selezionano traccia/range).
- Pulsante "Analizza" nel mixer.

**Accettazione**
- Test loudness con segnali sintetici: sinusoide 1 kHz a -20 dBFS → ≈ -23 LUFS (±0.3); rumore rosa; silenzio → -∞ gestito.
- Test FFT su sinusoide nota (bin corretto).
- Test masking: due sinusoidi a 80 Hz → score alto; 80 Hz vs 5 kHz → basso.
- Test key: scala di Do maggiore in MIDI → `C` con confidence > 0.7.
- `analyze_mix` sulla demo < 10 s su un laptop medio.

---

## F6 · Reference matching

### Modello
```ts
interface ReferenceTrack { sampleId: string; name: string; loudnessMatched: boolean; analysis?: ReferenceAnalysis }
```
Il campione è salvato come gli altri sample (IndexedDB + bundle `.openband`) ma **non** sta in timeline.

### Comandi/tool
| Tool | Args | Ritorna |
|---|---|---|
| `import_reference` | `source` (fileTool: path o URL), `from_seconds?, to_seconds?` | analisi della reference (stesso formato master di `analyze_mix`) |
| `compare_to_reference` | `from_bar?, to_bar?, section_id?` | diff |
| `clear_reference` | — | |

Output `compare_to_reference`:
```json
{
  "loudness_diff_lu": -3.2,
  "crest_diff_db": 2.1,
  "width_diff": -0.15,
  "tonal_diff_db": {"sub": -4.0, "bass": 1.5, "lowmid": 2.8, "mid": 0.4, "highmid": -1.2, "presence": -2.5, "air": -3.9},
  "suggestions": [
    {"action": "eq", "target": "master", "band": "air", "gain_db": 2.5, "reason": "Il tuo mix è più scuro della reference sopra 6 kHz"},
    {"action": "eq", "target": "trk_pad", "band": "lowmid", "gain_db": -2, "reason": "Accumulo a 250–500 Hz, il pad è la traccia più energica lì"}
  ]
}
```
- Il confronto tonale si fa **dopo** aver normalizzato entrambi alla stessa loudness integrata.
- I suggerimenti per-traccia scelgono la stem con più energia nella banda incriminata (da `renderStems`).

### UI
- Slot "Reference" in cima al mixer: carica, play, **toggle A/B** che commuta l'ascolto tra mix e reference, loudness-matched.
- Overlay delle due curve 1/3 d'ottava nel pannello Analisi.

**Accettazione**: confrontare un mix con sé stesso → tutti i diff ≈ 0 (±0.2 dB); test della normalizzazione loudness.

---

## F7 · Linter musicale + CI

### Motore (`src/lint/`, puro, gira anche in Node)
```ts
interface LintRule {
  id: string;                         // 'out_of_key'
  category: 'harmony'|'rhythm'|'arrangement'|'mix'|'lyrics'|'structure';
  severity: 'info'|'warn'|'error';
  needsAudio?: boolean;               // regole audio solo nel browser (usano F5)
  check(p: Project, ctx: LintContext): LintIssue[];
}
interface LintIssue {
  id: string;                         // deterministico: hash(rule, target) → stabile tra run
  rule: string; severity; message: string;
  target: { track_id?: string; region_id?: string; note_ids?: string[]; section_id?: string; from_beat?: number; to_beat?: number };
  fix?: { label: string; commands: { method: string; params: Record<string, unknown> }[] };
}
```
File di config opzionale nel progetto: `project.lint?: { disabled?: string[]; severity?: Record<string, Severity> }` (aggiungilo allo schema v2).

### Regole v1 (simboliche)
| id | Cosa controlla | Fix automatico |
|---|---|---|
| `out_of_key` | note fuori dalla scala di `project.key`, escluse note di passaggio ≤ 1/8 tra due note in scala | trasponi alla nota in scala più vicina |
| `overlapping_notes` | stessa pitch sovrapposta nella stessa regione | accorcia la prima |
| `notes_outside_region` | note oltre `region.length` | estendi regione / rimuovi |
| `overlapping_regions` | regioni sovrapposte sulla stessa traccia | — |
| `low_end_clash` | ≥2 tracce non-drum con note < E2 simultanee per > 1 beat | trasponi +12 la meno prioritaria |
| `register_crowding` | ≥3 tracce melodiche nello stesso range di un'ottava per > 2 battute | — |
| `robotic_velocity` | regione con ≥ 16 note e deviazione std velocity < 0.02 | umanizza ±0.08 |
| `robotic_timing` | tutte le note perfettamente in griglia su traccia "suonata" (non drum, non arpeggio) | — (info) |
| `empty_track` | traccia senza regioni | elimina |
| `bass_panned` | traccia con pitch medio < C3 o kick con `|pan| > 0.2` | pan 0 |
| `section_gap` | battute non coperte da sezioni (se ci sono sezioni) | — |
| `lyrics_prosody` | problemi da F10 | — |

### Regole audio (`needsAudio`, browser) — riusano F5
`clipping`, `low_headroom`, `masking_low_end`, `phase_mono`.

### Tool MCP
| Tool | Args | Ritorna |
|---|---|---|
| `lint_project` | `rules?: string[], include_audio?: boolean=false, min_severity?` | `{issues: LintIssue[], counts}` |
| `apply_fix` | `issue_id` | esegue `fix.commands` in **una** transazione, ritorna esito |
| `ignore_issue` | `issue_id` | aggiunge a `project.lint.ignored` |

### UI
Pannello "Problemi" (badge con conteggio nella toolbar), click → seleziona e zooma sul target, pulsante "Correggi". Lint simbolico ricalcolato con debounce 1 s a ogni commit.

### CI per le canzoni
- `scripts/openband-lint.mjs` (Node, importa `src/lint` compilato con `tsx` o build dedicata): `npx openband-lint song.openband.json --format=github` → output con annotazioni `::warning file=…::` ed exit code ≠ 0 se ci sono `error`.
- Composite action `.github/actions/openband-lint/action.yml` + esempio in README per chi versiona le canzoni su GitHub.
- (Fase 2, opzionale) render WAV in CI con Playwright + Chromium headless che apre lo studio con `?headless=1` e chiama `export_wav` via bridge.

**Accettazione**: il fixture "sporco" produce esattamente gli issue attesi (snapshot test); ogni fix risolve il proprio issue al run successivo; ID issue stabili tra run.

---

# M2 — Cantautore

## F8 · Sezioni come oggetti di prima classe

### Modello
```ts
type SectionKind = 'intro'|'verse'|'prechorus'|'chorus'|'bridge'|'solo'|'breakdown'|'outro'|'custom';
interface Section { id: string; name: string; kind: SectionKind; start: number; length: number; color?: string }
```
Le sezioni non si sovrappongono e sono ordinate. L'appartenenza regione↔sezione **si calcola** per sovrapposizione, non si salva.

### Comandi/tool
| Tool | Args | Note |
|---|---|---|
| `get_structure` | — | readOnly: sezioni con bar, durata, e per ogni sezione un **profilo di energia**: tracce attive, note/battuta per traccia, velocity media, registro medio, LUFS per sezione se c'è cache F5 |
| `add_section` | `name, kind, start_bar, length_bars` | |
| `update_section` | `section_id, name?, kind?, start_bar?, length_bars?` | |
| `delete_section` | `section_id, delete_content?: boolean` | |
| `move_section` | `section_id, to_bar, ripple?: boolean=true` | sposta tutto il contenuto; con ripple fa scorrere ciò che segue |
| `duplicate_section` | `section_id, to_bar?` (default subito dopo), `ripple?` | "aggiungi un ritornello finale" |
| `split_region` | `region_id, at_bar` (o `at_beat`) | **nuovo primitivo**, serve sopra |
| `auto_sections` | — | propone sezioni da ripetizioni del materiale (similarità per battuta delle note) e silenzi; ritorna proposta senza applicarla |

Regola chiave di `move_section`/`duplicate_section`: prima si spezzano (`split_region`) le regioni che attraversano i confini, poi si spostano/duplicano quelle interne. Tutto in una transazione.

### UI
- Corsia "Struttura" sopra il righello: blocchi colorati, rinomina con doppio click, drag per spostare (con ripple se tieni ⌥), menu contestuale duplica/elimina.
- Click su una sezione → imposta il loop su quella sezione.

### INSTRUCTIONS
Aggiungi: *"When the user talks about parts of a song (verse, chorus…), call get_structure first and operate on sections. Use the energy profile to make a section 'bigger' (more tracks, higher register, more notes, higher velocity) or 'smaller'."*

**Accettazione**: test su `split_region` (note tagliate correttamente al confine, note a cavallo accorciate) e su `move_section` con ripple.

---

## F9 · Analisi armonica

Modulo puro `src/analysis/harmony.ts`, usato da F10 (chord sheet), F14 (spiegazioni), F7.
- **Riconoscimento accordi da MIDI**: per finestra (default 1 battuta, con suddivisione a 2 beat se il set di pitch-class cambia), pitch-class pesate per durata×velocity, matching su template (maj, min, dim, aug, sus2, sus4, 7, maj7, m7, m7b5, dim7, add9, 6, m6) con basso più grave → slash chord (`C/E`). Esclude tracce drum.
- **Gradi**: numeri romani relativi a `project.key` (`I, ii, V/V, bVII`), con rilevamento di dominanti secondarie e prestiti modali.
- **Cadenze**: individua V-I, IV-I, ii-V-I, cadenza d'inganno, alla fine delle sezioni.

Tool: `analyze_harmony({ from_bar?, to_bar?, section_id?, track_ids? })` → `[{bar, beat, chord: "Am7", roman: "vi7", function: "tonic", confidence}]` + cadenze.

**Accettazione**: fixture con progressioni note (I–V–vi–IV, ii–V–I in Do, giro in La minore con E7) riconosciute al 100%.

---

## F10 · Lyrics track + prosodia + ChordPro

### Modello
```ts
interface LyricsDoc {
  language: 'it'|'en';
  melodyTrackId?: string;          // traccia della linea vocale
  lines: LyricLine[];
}
interface LyricLine { id: string; sectionId?: string; text: string; syllables: Syllable[] }
interface Syllable {
  text: string;                    // "can-"  "zo-"  "ne"
  stressed: boolean;
  beat?: number;                   // posizione assoluta assegnata
  noteId?: string;                 // nota della melodia a cui è agganciata
  melisma?: boolean;               // continua sulla nota successiva
}
```

### Modulo `src/lyrics/` (puro)
- `syllabify.it.ts` — sillabazione italiana a regole: vocali, dittonghi/trittonghi (con iato su `i`/`u` toniche accentate), consonanti doppie divise, gruppi inseparabili (`ch gh gl gn sc` + `cons + l/r`), `s` impura. **Sinalefe** opzionale tra parole (vocale finale + vocale iniziale = una sillaba metrica) — cruciale per il canto.
- `stress.it.ts` — accento: lettere accentate esplicite; altrimenti piana (penultima); dizionario minimo di eccezioni sdrucciole frequenti (~300 voci in JSON); l'utente può forzare con `ˈ` o maiuscola (`canTAre`).
- `syllabify.en.ts` — pattern di sillabazione (es. `hyphen` / pattern TeX, licenza compatibile) + stress da dizionario CMU ridotto (licenza BSD) solo per parole comuni, fallback euristico.
- `align.ts` — assegna in ordine le sillabe alle note della melodia nella sezione; sinalefe e melismi rispettati; ritorna sillabe orfane o note orfane.
- `prosody.ts` — controlli:
  - **sillabe vs note**: conteggio per frase (frase = riga di testo vs frase melodica separata da pausa ≥ 1 beat).
  - **accento su tempo debole**: sillaba accentata su suddivisione debole mentre la precedente/successiva atona cade su un tempo forte → warn.
  - **nota lunga su sillaba atona** (≥ 1 beat su sillaba atona di fine parola, escluso fine verso).
  - **parola spezzata da pausa lunga**.
  - Ogni problema è un `LintIssue` con regola `lyrics_prosody` (si integra in F7).
- `chordpro.ts` — export ChordPro (`{title}`, `{key}`, `{tempo}`, `{start_of_chorus}`…) unendo F8 (sezioni), F9 (accordi) e lyrics (accordo inserito prima della sillaba che cade sul cambio). Anche export `.txt` "accordi sopra il testo" con monospazio.

### Tool MCP
| Tool | Args |
|---|---|
| `set_lyrics` | `section_id?` (o `line_ids`), `text` (righe separate da `\n`), `language?` |
| `get_lyrics` | readOnly: righe, sillabe, allineamento, accenti |
| `align_lyrics` | `melody_track_id, section_id?` |
| `check_prosody` | `section_id?` → issue |
| `export_chord_sheet` | `format: 'chordpro'\|'txt'`, `save_to?` (come `export_midi`) |
| `suggest_melody_rhythm` | `line_id` → ritmo consigliato (durate per sillaba con accenti sui tempi forti) che l'AI può usare per scrivere la melodia |

### UI
- Corsia "Testo" sotto la traccia melodia in arrangiamento (sillabe allineate).
- Nel piano roll: sillaba scritta dentro/sotto ogni nota; sillabe accentate in grassetto; problemi prosodici sottolineati in arancione.
- Editor testo per sezione (pannello laterale), con conteggio sillabe metriche per verso.

**Accettazione**
- Test sillabazione su ≥ 200 parole italiane con risultato atteso (includi: *aiuola, scienza, glicine, psicologo, maggio, perché, mangiare, paura, pioggia*).
- Test sinalefe: "canto e ballo" → 4 sillabe metriche.
- Test ChordPro su fixture con 2 sezioni e accordi noti.

---

## F11 · Registrazione da microfono + hum-to-MIDI

(Copre anche la voce di roadmap "recording audio from the microphone".)

### Registrazione audio
- `src/audio/mic.ts`: `getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false}})`, `AudioWorklet` che scrive PCM in un ring buffer → a fine registrazione `importSample` + `add_audio_region` alla posizione di start.
- Compensazione latenza: misura `outputLatency + baseLatency` e sposta la regione; impostazione manuale in ms (calibrazione con click di loopback opzionale).
- Count-in di 1 battuta col metronomo. Monitoraggio input con meter.
- Comandi: `record_audio({ track_id?, start_bar?, bars? })` (solo da UI o con conferma utente: il browser chiede comunque il permesso microfono).

### Audio → MIDI monofonico (`src/analysis/pitchtrack.ts`, nel worker)
- **YIN** (o pYIN semplificato): frame 2048, hop 256 a 44.1 kHz, soglia 0.15, range 70–1100 Hz. Sostituisce/estende l'autocorrelazione di `detectPitch` in `samples.ts`.
- Smoothing: mediana su 5 frame, conversione in semitoni frazionari.
- Segmentazione note: nuovo onset se (a) energia sale > 6 dB in 30 ms o (b) il pitch si stabilizza su un semitono diverso per ≥ 60 ms. Durata minima 80 ms.
- Pitch della nota = mediana dei frame stabili; opzionale **snap alla tonalità** del progetto.
- Quantizzazione opzionale (1/8, 1/16, 1/8 terzinata) con `strength 0..1`.
- Velocity dall'RMS della nota normalizzato.

Tool: `audio_to_midi({ sample_id | region_id, track_id?, instrument?, snap_to_key?: boolean=true, quantize?: number, strength?: number })` → crea una regione MIDI allineata all'audio originale e ritorna note.

### UI — "Canticchia"
Pulsante microfono 🎤 nella toolbar → count-in → registri → conversione automatica → nuova traccia strumento (preset scelto) con la melodia, l'audio originale mantenuto muto sotto per confronto.

### Fase 2 (opzionale, non in v0.2)
Polifonico con modello **Basic Pitch** (Apache-2.0) via `onnxruntime-web`, caricato on-demand.

**Accettazione**
- Test con WAV sintetici: sinusoidi a pitch noti in sequenza → note corrette (pitch esatto, onset ±20 ms).
- Test con vibrato sintetico (±30 cent) → una sola nota.

---

# M3 — Workflow

## F12 · Take, comping e A/B alla cieca

### Modello
```ts
interface Take { id: string; name: string; notes: Note[]; audio?: AudioClip; createdAt: number; author: 'user'|'ai' }
// Region: takes?: Take[]; activeTakeId?: string
```
I `notes`/`audio` della regione restano la verità per il playback = contenuto della take attiva (o del comp). Cambiare take attiva copia i dati nella regione.

### Comandi/tool
| Tool | Args | Note |
|---|---|---|
| `add_take` | `region_id, notes, name?` | l'AI genera varianti così ("4 alternative del basso" = 4 chiamate in una transazione) |
| `list_takes` | `region_id` | |
| `set_active_take` | `region_id, take_id` | |
| `comp_takes` | `region_id, segments: [{from_beat, to_beat, take_id}]` | crea take "Comp" |
| `start_ab_test` | `region_id, take_ids (2–4), loop?: boolean=true` | UI di ascolto alla cieca; ritorna `test_id`. Il risultato arriva come evento `ab_result` (F3) → l'AI usa `wait_for_event({kinds:['ab_result']})` |

- La registrazione in modalità cycle crea una take per ogni giro (stile GarageBand).

### UI
- Badge "3 take" sulla regione; espandi → corsie take sotto la regione, selezione per segmenti (comping) col drag.
- **A/B cieco**: overlay con pulsanti A/B/C/D in ordine casuale, ogni pulsante commuta la take in tempo reale senza fermare il loop; l'utente ordina le preferite e conferma → rivelazione dei nomi + evento.

**Accettazione**: test comping (note tagliate ai confini dei segmenti); la mappatura casuale A/B non è mai esposta finché il test non è chiuso (anche nel DOM).

---

## F13 · Versioni, branch, diff e merge

### Storage
IndexedDB, store `versions` per `meta.projectId`:
```ts
interface Version { id: string; projectId: string; parentIds: string[]; branch: string; label: string; createdAt: number; author: 'user'|'ai'; snapshot: Project }
interface BranchRef { name: string; headId: string }
```
Branch di default `main`. `HEAD` = branch corrente in `useStore`.
Snapshot completi (i progetti sono piccoli; i sample sono già esterni via `sampleId`). Compressione con `fflate` (già dipendenza).

### Modulo puro `src/versions/`
- `diff.ts` — diff strutturale per **id**:
  - progetto: bpm, key, master, loop;
  - tracce aggiunte/rimosse/modificate (per campo: volume, pan, fx, instrument, automation);
  - regioni aggiunte/rimosse/spostate/ridimensionate;
  - note per regione: aggiunte/rimosse/modificate (match per `id`, fallback per `(pitch, start)` con tolleranza 1/32);
  - sezioni, lyrics.
  Output JSON + riepilogo leggibile ("Basso: 12 note cambiate nel ritornello; tempo 82→86").
- `merge.ts` — merge a 3 vie a livello di entità (traccia/regione/sezione/campo): non conflittuale se solo un lato cambia; conflitto se entrambi cambiano lo stesso campo/la stessa regione. Strategie: `ours`, `theirs`, `manual`. Risoluzione granulare: `pick: [{entity: 'region', id, from: 'a'|'b'}]` ("prendi il basso dalla versione B").
- `canonical.ts` — serializzazione JSON **deterministica** (chiavi ordinate, numeri arrotondati a 4 decimali, array di note ordinati per start/pitch) usata da `export_project_json({canonical:true})`, così chi versiona le canzoni con git ottiene diff leggibili.

### Tool MCP
| Tool | Args |
|---|---|
| `save_version` | `label` |
| `list_versions` | `branch?` |
| `create_branch` | `name, from_version_id?` (default HEAD) |
| `checkout` | `branch \| version_id` (crea entry di undo; se ci sono modifiche non salvate le salva automaticamente come versione "WIP") |
| `diff_versions` | `a, b` (id o nome branch; `b` default = stato corrente) |
| `merge` | `from_branch, strategy?, pick?` → applicato in una transazione, ritorna conflitti se `manual` |

### UI
- Pannello "Versioni": grafo verticale dei branch, label, autore (utente/AI).
- **Diff visivo**: modalità confronto in arrangiamento (regioni verdi=aggiunte, rosse=rimosse, gialle=modificate) e nel piano roll (note fantasma della versione B).
- Ascolto alternato tra due versioni (riusa il meccanismo A/B di F12 su progetto intero).

**Accettazione**: test diff/merge su fixture costruite (ognuno dei casi sopra); `canonical` stabile (stesso progetto → stessa stringa, indipendente dall'ordine di inserimento).

---

## F14 · Modalità "Spiegami" (annotazioni)

### Modello
```ts
interface Annotation {
  id: string;
  target: { type: 'project'|'track'|'region'|'notes'|'section'|'range'; id?: string; note_ids?: string[]; from_beat?: number; to_beat?: number };
  text: string;                 // markdown breve, max 500 caratteri
  author: 'ai'|'user';
  txId?: string;                // transazione F1 che l'ha prodotta
  createdAt: number;
  resolved?: boolean;
}
```

### Tool
| Tool | Args |
|---|---|
| `annotate` | `target, text` |
| `list_annotations` | `target?` |
| `resolve_annotation` / `delete_annotation` | `annotation_id` |

- Impostazione `teach_mode` (UI toggle) esposta in `get_status`. Quando è ON, `INSTRUCTIONS` chiede all'AI di annotare le scelte musicali non ovvie (armonia, voicing, ritmo, mix), usando `analyze_harmony` per essere precisa.
- Pulsante **"Spiega"** nel menu contestuale di regione/sezione/selezione note → evento `ask` (F3) con il contesto; l'AI risponde con `annotate`.

### UI
Pin di commento sull'arrangiamento e nel piano roll; pannello laterale con thread; le annotazioni dell'AI sono raggruppate per transazione nel pannello AI.

**Accettazione**: annotazioni sopravvivono a export/import e a checkout di versioni; eliminare la regione target marca l'annotazione come orfana (non la cancella).

---

## F15 · Call-and-response live

L'AI risponde a ciò che suoni. Limite fisico: la latenza dell'LLM è di secondi, quindi la risposta **non** è istantanea ma **quantizzata alla prossima finestra musicale utile**.

### Flusso
1. Loop attivo (es. 4 battute). L'utente suona una frase → evento `phrase` (F3).
2. L'AI (in un ciclo `wait_for_event({kinds:['phrase']})`) compone la risposta e chiama `play_phrase`.
3. Lo studio la suona all'**inizio della prossima finestra** libera (configurabile: prossima battuta / prossimo inizio loop / dopo N battute di attesa).

### Tool
| Tool | Args |
|---|---|
| `play_phrase` | `track_id, notes, at?: 'next_bar'\|'next_loop'\|{bar}`, `commit?: boolean=false` | suona note **effimere** (non nel progetto). Con `commit:true` crea anche la regione. |
| `set_jam_mode` | `enabled, response_track_id, window: 'next_bar'\|'next_loop'` | |

### Engine
`engine.schedulePhrase(trackId, notes, startBeat)` usa il transport live con `Tone.Part` temporanei, ripuliti a fine frase o allo stop. Nessun commit nello store.

### UI
Modalità "Jam" nel pannello AI: indicatore "l'AI sta ascoltando / sta rispondendo alla battuta 9", le frasi dell'AI evidenziate nel piano roll come note fantasma con pulsante "Tieni" (= commit).

**Accettazione**: test di scheduling (risposta mai prima della finestra richiesta; se arriva tardi slitta alla finestra successiva, non si sovrappone a metà battuta).

---

# M4 — Insieme

## F16 · Multiplayer con l'AI come terzo musicista

### Architettura
- **Yjs** (MIT) come documento condiviso: `Y.Map` per progetto, tracce e regioni per id; note come `Y.Map` per id dentro la regione; sezioni, lyrics, annotazioni idem.
- Binding bidirezionale `src/collab/binding.ts` tra `useStore.project` e `Y.Doc` (applica i diff strutturali di F13 in un `doc.transact`, origine = utente locale).
- Provider: `y-webrtc` per P2P (stanze con link condivisibile + password) e `y-websocket` servito opzionalmente dal processo `mcp-server.mjs` (`OPENBAND_COLLAB=1`) per LAN.
- **Awareness**: nome, colore, traccia selezionata, posizione playhead, cursore nel piano roll.
- **Undo in collab**: si passa a `Y.UndoManager` con `trackedOrigins` = utente locale (ognuno annulla solo il proprio lavoro); le transazioni F1 diventano `captureTimeout`/stack item espliciti.
- **Sample**: content-addressed (`sha256` → `sampleId`). Fase 1: i sample viaggiano solo come URL o vengono richiesti on-demand al peer che li possiede via chunk su un `Y.Map` effimero; limite 50 MB per sample.
- **Transport**: ognuno suona localmente; opzione "Segui il transport dell'host" (sincronizzazione su play/stop/posizione, non sample-accurate).
- **L'AI come peer**: il server MCP entra nella stanza come client Yjs con awareness `{name:'Claude', color}`; i comandi AI applicati nel browser dell'utente che ha l'AI connessa si propagano agli altri come qualsiasi modifica. Il pannello AI di ogni peer mostra chi ha chiesto cosa.

### Tool
`create_room`, `join_room({room, password?})`, `leave_room`, `get_peers` (readOnly).

**Accettazione**: test di convergenza (due `Y.Doc` in memoria con modifiche concorrenti a note diverse della stessa regione → stato identico); undo per-utente non annulla le modifiche altrui.

---

## Appendice A — Aggiornamento `INSTRUCTIONS` del server (testo finale suggerito)

Da aggiungere in coda a quelle esistenti:
```
Workflow:
- Wrap each user request in begin_change("short label") … end_change() so it can be undone in one step.
- Before mixing decisions, LISTEN: call analyze_mix (and render_spectrogram if useful). After changes, analyze again and compare.
- If a reference is loaded, use compare_to_reference to steer EQ and loudness.
- Talk about songs in sections: call get_structure and operate on sections (move_section, duplicate_section).
- For vocal lines, keep lyrics and melody aligned: set_lyrics → align_lyrics → check_prosody. Put stressed syllables on strong beats.
- When unsure between options, create takes (add_take) and ask the user to choose with start_ab_test; wait for the result with wait_for_event.
- Run lint_project before declaring a task done and fix errors.
- If teach_mode is on, annotate non-obvious musical choices with annotate().
- To react to what the user plays, use wait_for_event({kinds:["phrase"]}) and answer with play_phrase.
```

## Appendice B — File nuovi previsti

```
src/migrations.ts
src/analysis/{fft,loudness,spectrum,stereo,masking,key,issues,harmony,pitchtrack}.ts
src/workers/analysis.worker.ts
src/lint/{engine,rules/*}.ts
src/lyrics/{syllabify.it,syllabify.en,stress.it,align,prosody,chordpro}.ts
src/versions/{diff,merge,canonical,storage}.ts
src/collab/{binding,provider,awareness}.ts
src/audio/mic.ts
src/components/{AnalysisPanel,ProblemsPanel,StructureLane,LyricsLane,LyricsEditor,TakesLane,ABTest,VersionsPanel,Annotations,JamPanel}.tsx
scripts/openband-lint.mjs
.github/actions/openband-lint/action.yml
.github/workflows/ci.yml
```

## Appendice C — Come usarla con Claude Code

Per ogni feature, un prompt del tipo:
```
Leggi docs/SPEC.md. Implementa la feature F5 rispettando la sezione 0 (regole e Definition of Done).
Prima proponi il piano (file toccati, nuovi comandi, test), poi implementa, poi esegui typecheck e test.
Non toccare feature non elencate. Apri una PR con titolo "F5: analyze_mix".
```
Ordine consigliato: F0 → F1 → F2 → F4 → F3 → F5 → F7 → F8 → F9 → F10 → F11 → F6 → F12 → F14 → F13 → F15 → F16.
