# Mix e master: il Mix Pilot, la catena master, l'export per piattaforme

🇬🇧 [English](MIXING.md) · 🇮🇹 Italiano · [← README](../README.it.md)

OpenBand porta un brano da "l'ho registrato e programmato" a "suona come un disco ed è pronto per
Spotify" con **un pulsante e una manopola**. Puoi anche fare ogni passo a mano. Ogni scelta è spiegata, si
può annullare e si può confrontare alla stessa loudness.

![Il Mix Pilot dopo un'esecuzione: −19,8 → −14,0 LUFS, i ruoli e le 18 modifiche con il loro perché](pilot.png)

## Il Mix Pilot

Apri la scheda **Mix Pilot** (accanto a *Mixer*, oppure *Mix Pilot* nella catena master). Scegli un
**genere** (pop, rock, hip-hop, lo-fi, EDM, acustico / cantautore, ambient, jazz) e una **piattaforma**,
poi premi **Avvia il pilota**. OpenBand renderizza ogni traccia, la ascolta e decide:

1. **Ruoli**: ogni traccia è cassa, batteria, basso, armonia, lead, voce, tappeto o effetti. OpenBand lo
   capisce dal nome ("voce", "vox", "basso"…), dallo strumento, dalle note (registro, accordi o note
   singole) e, per l'audio, dalla banda che domina. Se ne sbaglia uno, correggilo nella colonna *Ruolo* o
   sulla striscia del mixer. La tua scelta vale anche per tutte le volte successive.
2. **Gain staging**: un trim (non il fader) porta ogni traccia allo stesso livello di lavoro, −18 LUFS
   short-term.
3. **Bilanciamento**: i fader seguono la tabella del genere (nel pop, per esempio, la voce comanda e
   l'armonia sta 8 dB sotto). Se più tracce hanno lo stesso ruolo, ognuna prende un po' meno.
4. **Spazio in frequenza**: dove due tracce si coprono, la meno importante riceve un taglio di 1–4 dB in
   quella banda (Q 1,2). *"Ho tagliato 1,5 dB a 354 Hz sul Pad: copriva la batteria."* Tutto tranne cassa,
   batteria e basso riceve un passa-alto un'ottava sotto la nota più bassa.
5. **Sidechain**: in pop, hip-hop ed EDM il basso si abbassa sotto la cassa quando si contendono i bassi.
6. **Pan**: cassa, basso, lead e voce restano al centro. Armonia e tappeti si allargano a coppie
   speculari, più o meno larghe a seconda del genere.
7. **Spazio**: mandate di riverbero ed eco per ruolo e genere (più bagnato nell'ambient, più asciutto
   nell'hip-hop).
8. **Master**: un EQ tilt verso il bilanciamento tonale del genere (o della reference, con *Somiglia alla
   reference*), un glue leggero, l'ampiezza con i bassi in mono e il limiter alla loudness della
   piattaforma.

Poi verifica il risultato: se il true peak supera il ceiling, abbassa il guadagno del limiter e
ricontrolla.

**Quanto** dosa il risultato: 0 è il brano com'era, 100% la proposta piena. La manopola **resta viva**
dopo l'esecuzione. La giri e il mix la segue; quando la lasci, OpenBand ritrova il guadagno del limiter
per il target. Il target di loudness è una specifica, non un gusto, quindi vale a qualsiasi dose sopra
lo 0. **Ascolta prima** fa sentire il brano com'era, alzato alla stessa loudness, così un mix più forte
non vince solo perché è più forte. **Fissa** tiene il risultato e la manopola smette di essere viva.
L'intera esecuzione è un solo passo di annullamento. Le modifiche non ovvie restano anche come commenti
sulle tracce.

Rieseguire il pilota riparte sempre dal brano com'era prima dell'ultima esecuzione. Non accumula: le
stesse impostazioni danno lo stesso mix.

## La catena master

La *Catena master* nel mixer esegue **EQ** (tilt, shelf, bande) → compressore **glue** → **ampiezza**
(mid/side, con tutto ciò che sta sotto *Mono sotto* in mono) → **limiter true-peak** (sovracampionato 4×,
lookahead 5 ms). La catena è la stessa dal vivo e in ogni export.

![La catena master nel mixer a −14 LUFS, −1 dBTP](master-chain.png)

**Imposta loudness** sceglie una piattaforma e renderizza il brano per trovare il guadagno del limiter
che arriva entro ±0,3 LU dal suo target, senza superare il ceiling:

| Piattaforma | Loudness | Ceiling |
|---|---|---|
| Spotify, YouTube | −14 LUFS | −1 dBTP |
| Apple Music | −16 LUFS | −1 dBTP |
| SoundCloud | −11 LUFS | −1 dBTP |
| Club | −8 LUFS | −1 dBTP |
| CD | −9 LUFS | −0,5 dBTP |

Quando un target non si raggiunge senza schiacciare la musica (per esempio un brano scarno a −9 LUFS),
OpenBand lo dice e si ferma al ceiling.

## Per traccia: passa-alto, tagli, sidechain

In **Effetti** ogni traccia ha un filtro **passa-alto** (12 dB/ott) e un **compressore** con *Sidechain
da*: il compressore ascolta un'altra traccia (prima del suo fader, anche quando è muta), così il basso si
abbassa sotto la cassa. I tagli del pilota sono bande peaking dopo l'EQ. Come il passa-alto, funzionano
anche con l'EQ spento.

![Effetti del basso con il passa-alto e il compressore comandato dalla batteria](sidechain.png)

## Esporta per piattaforme

*Menu → Esporta per…* produce un solo zip:

- un **master per piattaforma** alla sua loudness e al suo true peak, in WAV a 24 bit e 48 kHz. Il master
  per CD è a 16 bit e 44,1 kHz con dither TPDF;
- lo **strumentale** (tutto tranne il ruolo voce) e l'**a cappella**;
- gli **stem per ruolo** (batteria, basso, armonia, lead, voce, effetti);
- `report.txt`, con LUFS, true peak, LRA e conformità per ogni piattaforma.

Versioni e stem passano dalla stessa catena master, con glue e limiter **collegati** al mix completo:
applicano la stessa riduzione di guadagno del master. Sommando gli stem si ritrova il master, con un
residuo sotto i −60 dB (−131 dB sul brano demo).

![Esporta per piattaforme](export-platforms.png)

## Per i client AI

| Tool | Cosa fa |
|---|---|
| `mix_pilot` | `amount 0..1, genre, platform, use_reference, scope: mix / master / both` → ogni modifica con il suo perché, la loudness prima e dopo |
| `set_pilot_amount` | alza o abbassa la dose dopo un'esecuzione |
| `fix_pilot` | tiene il risultato |
| `set_track_role` | `track_id, role` (null = automatico) |
| `set_master_chain` | `eq, glue, width, limiter, platform` |
| `set_track_effects` | aggiunge `eq.hpf` e `compressor.sidechain` |
| `export_for_platforms` | `platforms[], stems, versions: instrumental / acapella, save_to` |

Il pilota è anche un motore OMEP, *OpenBand Mix Pilot* (`mix.assist`). Dal solo contesto del brano
propone fader, pan, mandate e il target del master per ruolo, per i direttori fuori da OpenBand. Vedi
[Ensemble](ENSEMBLE.it.md).
