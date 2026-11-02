# Theremin ToF: una mano nell'aria come controllo

🇬🇧 [English](README.md) · 🇮🇹 Italiano

Un Raspberry Pi (basta uno Zero 2 W), un sensore di distanza a tempo di volo VL53L1X (circa 10 €) e un LED. Muovi la mano e il filtro si apre.

**Stato:** provato solo in simulazione. La sequenza di avvio del sensore qui è uno schizzo: il VL53L1X ha bisogno della configurazione completa dei registri dal driver di ST prima di dare letture vere.

## Cablaggio

| VL53L1X | Raspberry Pi |
|---|---|
| VIN | 3V3 (pin 1) |
| GND | GND (pin 6) |
| SDA | GPIO 2 (pin 3) |
| SCL | GPIO 3 (pin 5) |

Il LED va su un GPIO libero, con una resistenza da 330 Ω. Attiva l'I²C con `sudo raspi-config`.

## Installazione

```sh
npm install
npm start                 # sul Pi
npm run simulate          # su qualunque computer: una sinusoide lenta
```

Per farlo partire con il Pi, copia la cartella in `/opt/openband-device` e la unit in `/etc/systemd/system/`, poi `sudo systemctl enable --now openband-device`.

## Mappalo sul filtro in 3 passi

1. In OpenBand, *Device*: inserisci `http://<indirizzo del Pi>:7788/` e *Collega*.
2. Scegli una traccia e il parametro `tone`, poi *Mappa* accanto a *Hand distance*.
3. Muovi la mano. Spunta *scrivi l'automazione* e suona per registrarla.

Oppure chiedi alla tua AI: "collega il theremin e mappalo sul filtro". `node node.mjs --http 7788 --token <t>` chiede un token in LAN.
