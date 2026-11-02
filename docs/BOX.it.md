# Il Box per la sala prove

🇬🇧 [English](BOX.md) · 🇮🇹 Italiano · [← README](../README.it.md)

Un computer lasciato acceso in sala, con un'interfaccia audio USB. Registra da solo ogni prova, la divide in brani e la conserva come versione del tuo brano. Il giorno dopo la apri dal telefono.

**Registra chiunque sia in sala.** Dillo a tutti. Si spegne con `openband box off`, o dal pannello *Sala prove*.

## Raspberry Pi o Linux

```sh
curl -fsSL https://raw.githubusercontent.com/iltempe/openband/main/scripts/box/install.sh | sudo sh
```

Installa Node, ffmpeg e avahi, crea un utente `openband` e un servizio, e stampa indirizzo e PIN. Poi apri `http://openband.local:7777` da un telefono sulla stessa rete e inserisci il PIN in *Progetti → Archivio*.

## Qualunque computer

```sh
openband box devices                                  # trova il tuo ingresso
openband box --device hw:1 --channels 2 --names "Voce,Chitarra" --project "La mia band"
openband box install                                  # come servizio: systemd, launchd o Task Scheduler
openband box status
openband box off
```

Serve ffmpeg (`apt install ffmpeg`, `brew install ffmpeg`, `winget install ffmpeg`). OpenBand non lo include. Su Linux funziona anche `arecord`.

## Come decide

- Parte dopo 2 s di suono sopra la soglia (`--threshold`, default −42 dB), tenendo i 5 s precedenti.
- Una pausa oltre 8 s separa due brani. 90 s di silenzio chiudono la sessione.
- Ogni canale si scrive in segmenti da 5 minuti. Dopo un'interruzione di corrente la sessione si recupera al riavvio successivo.
- Una sessione diventa tracce, sezioni "Brano 1…n" e una versione sul branch `prove`. Il main resta quello che la band arrangia.
- Oltre le 50 sessioni si cancellano prima le più vecchie, mai quelle con la stella. Il brano conserva l'audio già importato.

Docker su Linux: `docker compose -f docker-compose.box.yml up -d`.

**Non ancora provato su hardware vero**: un Raspberry Pi e una vera interfaccia USB. Facci sapere com'è andata.
