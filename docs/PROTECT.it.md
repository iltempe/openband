# Tutela: una prova che il tuo brano esisteva

Nella scheda **Pubblica**, sotto *Tutela*, OpenBand può marcare il tuo brano in Bitcoin con
[OpenTimestamps](https://opentimestamps.org). Un'IA fa lo stesso con `timestamp_work` (il toolset `protect`).

## Cosa ottieni e cosa no
- **Una prova della data.** La marca dimostra che questi file esistevano a quella data: il master, il
  progetto, il testo e il foglio accordi, ciascuno identificato dal suo SHA-256.
- **Una prova, non un deposito.** In Italia e nell'UE il diritto d'autore nasce con l'opera, quindi non va
  depositato nulla. In una contestazione la marca è una prova della data e della paternità. L'art. 8-ter del
  DL 135/2018 le dà gli effetti della validazione temporale elettronica dell'art. 41 eIDAS: è ammessa come
  prova e il giudice la valuta liberamente, ma non è qualificata.
- **Nessun incasso dei diritti.** Per incassare i diritti (concerti, radio, streaming) serve una società di
  gestione, come SIAE o Soundreef/LEA. Quel passaggio resta manuale.
- **Non è una consulenza legale.**

## Come funziona
1. OpenBand prepara i file dell'opera e un **manifest**, `work.json`. È un JSON canonico con titolo, autori,
   data dichiarata, licenza, lo SHA-256 di ogni file e la versione del brano. Gli stessi file danno sempre lo
   stesso manifest.
2. Dal tuo computer esce solo l'**impronta di 32 byte** del manifest. Prima viene aggiunto un valore casuale,
   così i server vedono solo un'impronta che non si può ricondurre al tuo brano. Va ad almeno due calendar
   pubblici di OpenTimestamps, attraverso l'OpenBand locale (i calendar non accettano richieste dalle pagine
   web). L'audio e il testo non escono mai.
3. La prova resta **in attesa** per qualche ora, finché Bitcoin non la conferma. Poi OpenBand la completa da
   solo, ogni volta che il brano è aperto con l'OpenBand locale.
4. **Verifica** controlla la prova sul blocco Bitcoin in cui è ancorata, con un block explorer pubblico.
   *Verifica un file qualsiasi con la sua prova* fa lo stesso per qualsiasi file con il suo `.ots`, tuo o di
   altri.

Il master viene conservato esattamente com'era al momento della marca, come campione salvato con il brano:
un nuovo render dello stesso brano differisce negli ultimi bit, e la prova riguarda proprio quei byte.

## Il pacchetto Prova
`Pacchetto Prova` (o `export_proof_package`) salva uno zip che chiunque può verificare senza OpenBand:
- `work.json` e `work.json.ots`, il manifest e la sua prova OpenTimestamps;
- i file elencati nel manifest: il master WAV, il progetto, `lyrics.txt` e il foglio ChordPro;
- `README.txt`, con le istruzioni per la verifica indipendente: `ots verify work.json.ots`, poi `sha256sum`
  di ogni file confrontato con `work.json`;
- `certificate.pdf`, un certificato di una pagina con titolo, autori, blocco, data e hash.

## Serve
L'app OpenBand o `npx openband` sul tuo computer. Nello studio online, collegalo a un OpenBand locale.
