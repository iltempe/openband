import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Buttons, ledPattern, midiAction, parseAmidi, parseGpiomon, startControls } from './controls.mjs';

describe('the buttons', () => {
  const setup = () => {
    let t = 0;
    const actions = { rec: vi.fn(), mark: vi.fn(), toggleArmed: vi.fn() };
    const b = new Buttons({ rec: 17, mark: 27, actions, now: () => t });
    return { b, actions, at: (x: number) => (t = x) };
  };
  it('a short REC toggles, a long press turns the Box off', () => {
    const { b, actions, at } = setup();
    b.edge(17, false);
    at(200);
    b.edge(17, true);
    expect(actions.rec).toHaveBeenCalledOnce();
    b.edge(17, false);
    at(2500);
    b.edge(17, true);
    expect(actions.toggleArmed).toHaveBeenCalledOnce();
    expect(actions.rec).toHaveBeenCalledOnce();
  });
  it('MARK fires on the press', () => {
    const { b, actions } = setup();
    b.edge(27, false);
    b.edge(27, true);
    expect(actions.mark).toHaveBeenCalledOnce();
  });
  it('reads gpiomon in both versions of libgpiod', () => {
    expect(parseGpiomon('event: FALLING EDGE offset: 17 timestamp: [8.1]')).toEqual({ pin: 17, rising: false });
    expect(parseGpiomon('12.5\trising\tgpiochip0 27')).toEqual({ pin: 27, rising: true });
    expect(parseGpiomon('nonsense')).toBeNull();
  });
});

describe('the LED', () => {
  it('says what the Box is doing', () => {
    expect(ledPattern({ state: 'off' })).toEqual({ onMs: 0, offMs: 1 });
    expect(ledPattern({ state: 'armed' })).toEqual({ onMs: 1, offMs: 0 });
    expect(ledPattern({ state: 'recording' })).toEqual({ onMs: 500, offMs: 500 });
    expect(ledPattern({ state: 'armed', error: 'x' }).onMs).toBe(100);
    expect(ledPattern({ state: 'recording', disk: { free: 1e8 } }).onMs).toBe(100);
  });
});

describe('the footswitch', () => {
  const map = { rec: { note: 60 }, mark: { cc: 64 } };
  it('maps notes and pedals', () => {
    expect(midiAction([0x90, 60, 100], map)).toBe('rec');
    expect(midiAction([0x90, 60, 0], map)).toBeNull();
    expect(midiAction([0xb3, 64, 127], map)).toBe('mark');
    expect(midiAction([0xb0, 64, 10], map)).toBeNull();
  });
  it('reads amidi', () => expect(parseAmidi('90 3C 64')).toEqual([0x90, 0x3c, 0x64]));
  it('a missing tool does not stop the Box', () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
    const log = vi.fn();
    const stop = startControls({ box: { recorder: {}, status: () => ({ state: 'off' }) }, cfg: { armed: true, gpio: { rec: 17 } }, log, spawnFn: (() => child) as never });
    child.emit('error', new Error('ENOENT'));
    expect(log).toHaveBeenCalled();
    stop();
  });
});
