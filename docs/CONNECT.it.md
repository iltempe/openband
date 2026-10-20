# Collegare un'AI a OpenBand

🇬🇧 [English](CONNECT.md) · 🇮🇹 Italiano · [← README](../README.it.md)

```
Client AI (Claude Desktop, Claude Code, Cursor…)
        │  stdio · MCP
        ▼
server/mcp-server.mjs ──── WebSocket ws://127.0.0.1:7777/bridge ────▶ OpenBand nel browser
```

Il client avvia il server MCP, che inoltra ogni chiamata alla finestra di OpenBand aperta. Ogni comando ricevuto compare nel pannello **AI** dell'app (il pulsante “MCP” in alto a destra).

**Claude Code**:

```bash
claude mcp add openband -- npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz mcp
```

**Claude Desktop, Cursor, VS Code…**, oppure esegui `npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz setup`. Claude Desktop tiene il file in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) o `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "openband": { "command": "npx", "args": ["-y", "--allow-remote=all", "https://github.com/iltempe/openband/releases/latest/download/openband.tgz", "mcp"] }
  }
}
```

Nessun percorso da modificare: `npx` scarica il pacchetto dall'ultima release su GitHub, con lo studio già compilato (`setup` scrive l'indirizzo della release esatta che stai usando). `--allow-remote=all` permette a npm 12 (Node 26) di scaricare un pacchetto da un indirizzo; le versioni precedenti di npm lo ignorano. Alla prima chiamata di un tool lo studio si apre da solo nel browser.

Poi chiedi, per esempio:

> Crea un beat lo-fi a 82 BPM in Re minore con batteria, basso e Rhodes, poi fai partire il loop.

> Aggiungi un overdrive valvolare caldo al basso e un riverbero ampio al pad, poi apri l'overdrive così lo regolo.

> Importa ~/Samples/voce.wav come traccia audio alla battuta 5, metti un compressore sul basso, fai entrare il pad in dissolvenza in due battute e salva il brano come ~/Desktop/brano.wav e brano.mid.

Variabili d'ambiente: `OPENBAND_REMOTE_MCP=1` e `OPENBAND_REMOTE_TOKEN` (MCP remoto su `/mcp`, vedi [self-hosting](SELF-HOSTING.it.md#claudeai-come-client-mcp-remoto)), `OPENBAND_PORT` (predefinita 7777; se è occupata si usa la prima porta libera e lo studio si apre con `?mcp=<porta>`), `OPENBAND_OPEN_BROWSER=0` (non aprire il browser), `OPENBAND_COLLAB=1` (stanze multiplayer nella tua rete), `OPENBAND_NO_UPDATE_CHECK=1` (non controllare su GitHub, una volta al giorno, se c'è un OpenBand più nuovo) e `OPENBAND_DEV_URL` (predefinita `http://localhost:5173`, usata quando manca la build). Problemi? `npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz doctor` controlla Node, la porta (e chi la usa), la build, i pacchetti e i tuoi client MCP, con una soluzione per ogni ✗. Nello studio, *⋯ → Diagnostica* mostra audio, bridge, permessi, spazio, plugin ed errori recenti, e *Segnala un problema* apre una segnalazione su GitHub già compilata, senza niente delle tue canzoni e mai le tue chiavi, da rileggere prima di pubblicare.

**Dalla demo online.** Anche la demo può comandare il server OpenBand sul tuo computer: apri il pannello **AI**, installa l'estensione (o esegui `npx -y --allow-remote=all https://github.com/iltempe/openband/releases/latest/download/openband.tgz mcp`) e scrivi il **codice di abbinamento** di 6 cifre che Claude ti dà quando gli chiedi di aprire lo studio (il server lo stampa anche all'avvio). La scheda riceve un token di sessione, quindi ricaricando non lo richiede; riavviare il server lo revoca. Il browser potrebbe chiederti di consentire al sito l'accesso alla rete locale: è così che la pagina raggiunge `127.0.0.1`, scegli *Consenti*. Se il browser rifiuta, *Apri lo studio locale* porta la canzone aperta nello studio servito dal tuo computer.

<img src="connect-ai.png" alt="La procedura Collega AI nella demo online" width="300">

Il bridge accetta solo connessioni in loopback: da pagine servite su localhost (senza codice) e dai siti in `OPENBAND_ALLOWED_ORIGINS` (predefinito `https://iltempe.github.io`), che devono prima abbinarsi: 5 codici sbagliati in un minuto bloccano l'abbinamento per 5 minuti, e i codici scadono dopo 10 minuti.

claude.ai sul web e sul telefono può collegarsi a un OpenBand self-hosted: vedi [MCP remoto](SELF-HOSTING.it.md#claudeai-come-client-mcp-remoto). Tutti gli strumenti: [MCP-TOOLS.it.md](MCP-TOOLS.it.md).
