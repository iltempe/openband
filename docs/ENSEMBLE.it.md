# Ensemble: i motori che suonano in OpenBand

🇬🇧 [English](ENSEMBLE.md) · 🇮🇹 Italiano · [← README](../README.it.md)

OpenBand è dove vive la canzone; i **motori** ne suonano le parti. Un motore può essere uno degli algoritmi
di OpenBand, un modello musicale sul tuo computer, uno su un altro computer della tua rete o (presto) un
servizio online. Parlano tutti lo stesso standard aperto, l'[Open Music Engine Profile](../omep/README.md)
(OMEP), quindi OpenBand non chiama mai un modello per nome: tu chiedi una parte, OpenBand sceglie chi la
suona.

## Crea una parte

Premi **✦ Crea** nella barra (oppure *Ensemble → Crea una parte*), descrivi cosa vuoi — *«batteria funk,
fitta»*, *«piano arpeggiato, intimo»*, *«un loop di tastiere lo-fi»* — e scegli dove (tutta la canzone, il
ciclo, una sezione, alcune battute). OpenBand:

1. capisce la **parte**: batteria (note), accompagnamento (note) o uno strato audio, dalle tue parole
   oppure scegli tu;
2. sceglie il **motore** con il router (vedi sotto), o quello che indichi;
3. gli manda il **contesto** della canzone: tempo, tonalità, sezioni, gli accordi che legge dalle tue parti,
   solo quello che quel motore dichiara di usare;
4. **adatta** quello che torna alla canzone: note nella tonalità e nell'estensione della canzone e dentro le
   battute; audio portato al tempo, spostato nella tonalità, ripetuto o tagliato sulle battute. Ogni
   correzione è scritta (*«stretch 12.2% (82 → 92 BPM) · repeated ×4»*);
5. la mette nella canzone come **un solo passo di annullamento**. Con le **varianti** (fino a 4, da motori
   diversi quando più d'uno può suonare) i risultati diventano take di una regione: confrontale, o fai un
   test alla cieca.

<img src="ensemble-create.png" alt="La finestra Crea" width="420">

Non serve un'AI. Se ce n'è una collegata, può fare lo stesso con lo strumento `create`.

## I motori

| Motore | Parte | Dove | Licenza |
|---|---|---|---|
| **OpenBand Drummer** | batteria (10 stili, segue le sezioni) | in OpenBand | MIT |
| **OpenBand Chords** | accompagnamento: accordi tenuti, stab o arpeggio, sugli accordi della canzone | in OpenBand | MIT |
| **OpenBand CC0 loops** | uno strato audio dalla libreria di loop CC0 | in OpenBand | MIT + audio CC0 |
| i tuoi motori | quello che dichiarano | il tuo computer, la tua rete | la loro |

### Aggiungere motori

I motori che installi girano tramite il server OpenBand sul tuo computer: l'app desktop, `npx …` o
l'estensione per Claude Desktop. Elencali in `~/.openband/engines.json` (oppure indica un altro file con
`OPENBAND_ENGINES`), nello stesso formato dei client MCP:

```json
{
  "engines": {
    "ace-step":  { "command": "uvx", "args": ["omep-ace-step"], "env": { "DEVICE": "cuda" } },
    "studio-pc": { "url": "https://192.168.1.20:8765/mcp", "token": "…" },
    "mock":      { "builtin": "omep-mock" }
  }
}
```

poi premi *Aggiorna* in *Ensemble*. OpenBand avvia solo quello che c'è in quel file. `"builtin": "omep-mock"`
è il motore di riferimento del repository OMEP, utile per provare tutta la catena. Prima di installare un
motore, controllalo con `openband omep-conformance -- <il suo comando>`.

## Le tue regole e il router

*Ensemble → Le tue regole*:

- **Solo uso commerciale** (attivo di default): non si usano i motori la cui licenza (del codice, dei pesi
  o, online, dell'output) vieta l'uso commerciale. I motori con licenza *condizionata* chiedono una volta.
- **Solo motori su questo computer**: niente passa dalla rete.
- **Consenti i motori online** (disattivato di default): costano e inviano dati al fornitore.

Tra i motori rimasti, il router preferisce quelli che rispettano meglio le canzoni (l'aderenza misurata
dalla conformità e dalle correzioni che OpenBand ha dovuto fare), poi i più veloci; i motori di OpenBand
vengono prima, salvo che un altro faccia meglio. Ogni motore escluso è elencato con il motivo.

## Chi ha suonato cosa

Ogni parte fatta da un motore ha una ✦ sulla regione e una voce nel **registro dei contributi**: motore,
versione, seed, licenza, la tua richiesta, il contesto da cui è nata (un hash della canzone) e le correzioni.
*Ensemble → Chi ha suonato cosa* mostra la quota umano / AI di ogni traccia: una regione conta come AI
finché la take attiva è del motore; registra o scrivi una tua take e sceglila, e torna tua. Il registro
viaggia dentro la canzone (`.openband`, export) e servirà per crediti e dichiarazione AI in pubblicazione.

## Per i client AI

`create` (descrivi la parte; `variants`, `engine` solo se richiesto), `list_engines` (motori, percorsi ed
esclusioni secondo le regole), `get_ledger` (contributi e quote), `set_engine_policy`.
