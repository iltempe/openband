#!/usr/bin/env node
// A hand in the air becomes a control: a Raspberry Pi with a VL53L1X time-of-flight sensor on I²C and an LED.
//   node node.mjs --simulate           a slow sine, on any computer (the conformance suite uses it)
//   node node.mjs --http 7788          on the Pi, for the LAN; --token <t> to require a token
import { createDevice, simulated } from '../../lib/device.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const SIMULATE = process.argv.includes('--simulate');

export const MANIFEST = {
  omep: '1.1',
  engine: { id: 'pi-tof-theremin', name: 'Theremin ToF', version: '0.1.0' },
  license: { code: 'MIT', weights: null, commercial: 'yes', attribution: null, conditions: null },
  runtime: { where: 'lan', device: ['cpu'], realtime: true },
  device: {
    hardware: 'Raspberry Pi 5 + VL53L1X (I²C)',
    latency_ms: 15,
    controls: [
      { id: 'distance', label: 'Hand distance', kind: 'continuous', range: [0, 1], unit: 'norm', rate_hz: 100, curve: 'linear', raw: { min: 40, max: 600, unit: 'mm' } },
      { id: 'present', label: 'Hand present', kind: 'toggle' },
    ],
    audio_inputs: [],
    outputs: [{ id: 'led', kind: 'light', range: [0, 1] }],
    midi_fallback: { port: 'Theremin ToF', map: { distance: { cc: 74 } } },
  },
  capabilities: { 'device.read': {}, 'device.stream': { max_rate_hz: 200 }, 'device.set': {} },
  outputs: ['application/json'],
  determinism: 'deterministic',
};

const RAW = { min: 40, max: 600 };
/** Millimetres to 0..1, near = 1. */
export const normalize = (mm) => Math.max(0, Math.min(1, 1 - (mm - RAW.min) / (RAW.max - RAW.min)));

async function hardware() {
  // Only on the Pi: the main package never loads a native module.
  const { default: i2c } = await import('i2c-bus');
  const bus = await i2c.openPromisified(1);
  const ADDR = 0x29;
  return {
    distance: async () => {
      const b = Buffer.alloc(2);
      await bus.i2cWrite(ADDR, 2, Buffer.from([0x00, 0x96]));
      await bus.i2cRead(ADDR, 2, b);
      return b.readUInt16BE(0);
    },
  };
}

const sine = simulated();
const sensor = SIMULATE ? null : await hardware();
const read = async () => {
  const d = SIMULATE ? sine() : normalize(await sensor.distance());
  return { distance: d, present: d > 0.02 ? 1 : 0 };
};

const device = await createDevice({
  manifest: MANIFEST,
  read,
  simulate: SIMULATE,
  host: SIMULATE ? '127.0.0.1' : '0.0.0.0',
  token: arg('--token'),
  set: async (output, value) => console.error(`${output} = ${value}`),
});
if (arg('--http')) await device.serveHttp(Number(arg('--http')));
else await device.serveStdio();
