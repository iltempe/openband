# La Cassetta

🇬🇧 [English](CASSETTE.md) · 🇮🇹 Italiano · [← README](../README.it.md)

Ti ricordi quando ci si passava le canzoni su nastro? Incidi una cassetta dalle tue canzoni e dalla a chi vuoi. La ascolta dal telefono senza installare niente, con testo e accordi.

**OpenBand non ospita niente.** Una cassetta contiene il suo lettore, quindi continua a suonare qualunque cosa succeda a questo progetto. Brani e titoli sono cifrati, e la chiave viaggia solo nella parte del link dopo `#`, che i browser non mandano mai a un server. Chi ospita i file vede solo rumore.

## Incidila

*Cassette*, nel pannello in basso: dai un titolo e una dedica, apri un brano e aggiungilo al lato A o B. Ripeti per ogni brano, poi *Incidi*. Ogni brano usa la versione in cui si trova quando lo aggiungi: una cassetta è congelata, quindi un nuovo mix vuol dire una nuova stampa.

Tutti i brani escono allo stesso volume (−14 LUFS, −1 dBTP), come su un nastro ben fatto.

## Dalla via

- **Un file**: `Titolo – Artista.cassetta.html`, per email, chat o chiavetta. Usa una password: un file gira. Non si può ritirare. Su iPhone un `.html` ricevuto in chat spesso si apre in anteprima senza audio, quindi per gli iPhone usa un link.
- **Cartella per un sito**: caricala dove vuoi, su qualunque spazio che serva file statici, poi aggiungi `#k=…&s=…` al suo indirizzo. Quella parte te la dà lo studio.

- **Dal mio OpenBand**: quando lo studio è collegato al tuo server o Box, la cassetta è servita da `/c/<serie>/<stampa>/`. In LAN funziona subito. Per arrivare su internet, `openband box --tunnel cloudflared` o `--tunnel tailscale` avvia un tunnel che hai configurato e stampa l'indirizzo pubblico: controllalo dal telefono. Su questa strada i ritorni arrivano direttamente al tuo server in HTTPS, *Ritira* toglie la cassetta, e chi ascolta vede quando esce una nuova stampa.

## Cosa torna indietro

Se lo permetti, chi ascolta può reagire su un punto, scrivere una parola o lasciare un vocale. Tutto è sigillato in modo che solo il tuo studio possa leggerlo. Ti arriva direttamente, dal tuo server di signaling mentre lo studio è aperto, oppure come file `.risposta` che ti mandano. I ritorni finiscono sulla battuta in cui sono nati e restano su quella frase anche se riarrangi il brano.

La tua firma sono quattro emoji. Il lettore le ricorda e avvisa se una stampa successiva è firmata da qualcun altro.
