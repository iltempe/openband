// The Box's physical controls (R2.6). GPIO through libgpiod's own commands as child processes, no native Node
// module; a USB-MIDI footswitch through amidi or arecordmidi where there is one. The logic is pure.
import { spawn } from 'node:child_process';

export const LONG_PRESS_MS = 2000;

/** LED: off = stopped, steady = armed, blinking = recording, fast = error or disk full. */
export function ledPattern(status) {
  if (status.error || (status.disk && status.disk.free < 1e9)) return { onMs: 100, offMs: 100 };
  if (status.state === 'recording') return { onMs: 500, offMs: 500 };
  if (status.state === 'armed') return { onMs: 1, offMs: 0 };
  return { onMs: 0, offMs: 1 };
}

/** Parse a line of `gpiomon`: { pin, rising } or null (libgpiod 1.x and 2.x word it differently). */
export function parseGpiomon(line) {
  const edge = /rising|falling/i.exec(line)?.[0].toLowerCase();
  const pin = /(?:offset:?\s*|line\s+)(\d+)/i.exec(line)?.[1] ?? /"?(\d+)"?\s*$/.exec(line)?.[1];
  return edge && pin ? { pin: Number(pin), rising: edge === 'rising' } : null;
}

/** Buttons pull down: press = falling. REC short toggles, REC long turns the Box off or on. */
export class Buttons {
  constructor({ rec, mark, actions, now = () => Date.now() }) {
    Object.assign(this, { rec, mark, actions, now });
    this.down = null;
  }

  edge(pin, rising) {
    if (pin === this.mark && !rising) return void this.actions.mark();
    if (pin !== this.rec) return;
    if (!rising) return void (this.down = this.now());
    if (this.down === null) return;
    const held = this.now() - this.down;
    this.down = null;
    if (held >= LONG_PRESS_MS) this.actions.toggleArmed();
    else this.actions.rec();
  }
}

/** Raw MIDI bytes → the configured action: `midi: { rec: { note: 60 }, mark: { cc: 64 } }`. */
export function midiAction(bytes, map) {
  const [status, data, value] = bytes;
  const kind = status & 0xf0;
  const hit = (m) => (m?.note !== undefined && kind === 0x90 && data === m.note && value > 0) || (m?.cc !== undefined && kind === 0xb0 && data === m.cc && value >= 64);
  if (hit(map?.rec)) return 'rec';
  if (hit(map?.mark)) return 'mark';
  return null;
}

/** Hex dump of `amidi -d` → messages of three bytes. */
export const parseAmidi = (line) => {
  const b = line.trim().split(/\s+/).filter((x) => /^[0-9a-f]{2}$/i.test(x)).map((x) => parseInt(x, 16));
  return b.length >= 3 ? b.slice(0, 3) : null;
};

const lines = (stream, fn) => {
  let rest = '';
  stream.on('data', (d) => {
    const all = (rest + d).split('\n');
    rest = all.pop();
    all.forEach(fn);
  });
};

/** Start what box.json asks for. A missing tool is a message, not a failure: the Box records anyway. */
export function startControls({ box, cfg, log = () => {}, spawnFn = spawn }) {
  const actions = { rec: () => box.recorder.force(!box.recorder.session), mark: () => box.recorder.mark(), toggleArmed: () => box.arm(!cfg.armed) };
  const stoppers = [];
  if (cfg.gpio) {
    const { chip = 'gpiochip0', rec, mark, led } = cfg.gpio;
    const pins = [rec, mark].filter((p) => p !== undefined);
    if (pins.length) {
      const buttons = new Buttons({ rec, mark, actions });
      const mon = spawnFn('gpiomon', ['--chip', chip, ...pins.map(String)], { stdio: ['ignore', 'pipe', 'ignore'] });
      mon.on('error', () => log('gpiomon not found: install gpiod'));
      lines(mon.stdout, (l) => {
        const e = parseGpiomon(l);
        if (e) buttons.edge(e.pin, e.rising);
      });
      stoppers.push(() => mon.kill());
    }
    if (led !== undefined) {
      let lit = false;
      let timer;
      const set = (on) => spawnFn('gpioset', ['--chip', chip, '-t', '0', `${led}=${on ? 1 : 0}`], { stdio: 'ignore' }).on('error', () => {});
      const tick = () => {
        const { onMs, offMs } = ledPattern(box.status());
        const next = onMs === 0 ? false : offMs === 0 ? true : !lit;
        if (next !== lit) set((lit = next));
        timer = setTimeout(tick, Math.max(100, next ? onMs : offMs));
      };
      tick();
      stoppers.push(() => clearTimeout(timer));
    }
  }
  if (cfg.midi?.port) {
    const m = spawnFn('amidi', ['-p', cfg.midi.port, '-d'], { stdio: ['ignore', 'pipe', 'ignore'] });
    m.on('error', () => log('amidi not found: the footswitch needs alsa-utils'));
    lines(m.stdout, (l) => {
      const b = parseAmidi(l);
      const a = b && midiAction(b, cfg.midi);
      if (a) actions[a]();
    });
    stoppers.push(() => m.kill());
  }
  return () => stoppers.forEach((f) => f());
}
