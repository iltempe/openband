# Sviluppare OpenBand

🇬🇧 [English](DEVELOPMENT.md) · 🇮🇹 Italiano · [← README](../README.it.md)

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

La CI esegue typecheck e test a ogni push e pull request, più le build dei pacchetti (il pacchetto su 3 sistemi × Node 18/20/22, il `.mcpb`), i controlli e2e e una prova della release. Release: vedi [RELEASING.md](RELEASING.md); un tag costruisce la release su GitHub (il pacchetto e l'estensione per Claude Desktop) e la demo alla stessa versione. Le roadmap sono descritte in [SPEC.md](SPEC.md) (v0.2) e [SPEC-v0.3.md](SPEC-v0.3.md); le decisioni di progetto sono in [adr/](adr/); le modifiche sono elencate in [CHANGELOG.md](../CHANGELOG.md).

Per provare il tuo checkout da un client MCP: `claude mcp add openband -- node /percorso/di/openband/bin/openband.mjs mcp`.

## Struttura del codice

```
src/
  types.ts, music.ts       modello dei dati, teoria (note, accordi, mappa della batteria)
  store.ts                 stato (zustand), annulla/ripeti, salvataggio automatico
  commands.ts              API dei comandi condivisa da interfaccia, MCP e chat nella pagina (transazioni, comandi di sola lettura)
  migrations.ts            versioni dello schema del progetto (v1 → v3)
  bridge.ts, protocol.ts   client WebSocket verso il server locale, abbinamento, scheda MCP remoto
  ai/                      Claude nel browser: provider, ciclo dell'agente, strumenti, chiavi, modelli
  audio/                   motore (grafo dal vivo, misuratori, ascolto), render (offline, WAV), effetti, host WAM,
                           campioni, sampler, SoundFont, time-stretch, automazioni, worklet (LUFS)
  analysis/                DSP puro: FFT, loudness (BS.1770), spettro, stereo, mascheramento, tonalità, armonia,
                           tracciamento dell'intonazione, confronto con il riferimento, loudness dal vivo
  generate/                Sorprendimi, batterista, parti generate
  lint/, lyrics/           linter musicale; sillabe, allineamento, prosodia, ChordPro (puri)
  journal/                 diario, checkpoint, macchina del tempo (IndexedDB)
  collab/                  stanze (Yjs): binding, sessioni, versioni e commenti condivisi
  interop/dawproject/      importazione ed esportazione DAWproject
  structure.ts, takes.ts, flubs.ts, punch.ts, loops.ts, automation.ts, …   una funzione ciascuno
  workers/                 analisi e time-stretch fuori dal thread principale
  components/              l'interfaccia (Toolbar, Arrangement, Editor, Mixer, Library, AIPanel…)
server/
  mcp-server.mjs           server MCP (stdio) + bridge WebSocket + file statici; tools.mjs definisce gli strumenti
  remote.mjs, pairing.mjs  MCP remoto via HTTP, codici di abbinamento
  setup.mjs, doctor.mjs, clients.mjs, update.mjs, package.mjs   la CLI (setup, doctor, avvisi di aggiornamento, origine dell'installazione)
  collab.mjs, csp.mjs, http.mjs   stanze in rete locale e signaling, header di sicurezza, server statico
bin/openband.mjs           il comando `openband`
scripts/                   CLI del linter, build e smoke test del .mcpb, note di release, e2e (puppeteer), libreria di loop
```
