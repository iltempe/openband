# Theremin ToF: a hand in the air as a control

🇬🇧 English · 🇮🇹 [Italiano](README.it.md)

A Raspberry Pi (a Zero 2 W is enough), a VL53L1X time-of-flight distance sensor (about €10) and an LED. Move your hand and the filter opens.

**Status:** tested in simulation only. The sensor's start-up sequence here is a sketch: the VL53L1X needs its full register setup from ST's driver before real readings.

## Wiring

| VL53L1X | Raspberry Pi |
|---|---|
| VIN | 3V3 (pin 1) |
| GND | GND (pin 6) |
| SDA | GPIO 2 (pin 3) |
| SCL | GPIO 3 (pin 5) |

The LED goes on a free GPIO, through a 330 Ω resistor. Turn on I²C with `sudo raspi-config`.

## Install

```sh
npm install
npm start                 # on the Pi
npm run simulate          # on any computer: a slow sine
```

To start it with the Pi, copy the folder to `/opt/openband-device` and the unit to `/etc/systemd/system/`, then `sudo systemctl enable --now openband-device`.

## Map it on the filter in 3 steps

1. In OpenBand, *Devices*: enter `http://<address of the Pi>:7788/` and *Connect*.
2. Choose a track and the parameter `tone`, then *Map* next to *Hand distance*.
3. Move your hand. Tick *write automation* and play to record it.

Or ask your AI: "connect the theremin and map it to the filter". `node node.mjs --http 7788 --token <t>` asks for a token on the LAN.
