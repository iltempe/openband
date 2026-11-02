import { describe, expect, it } from 'vitest';
import { lineSplitter, parseSerial } from './serial';

describe('devices on a serial port', () => {
  it('joins lines that arrive in pieces', () => {
    const lines: string[] = [];
    const feed = lineSplitter((l) => lines.push(l));
    feed('{"val');
    feed('ues":{"a":1}}\r\n{"b"');
    expect(lines).toEqual(['{"values":{"a":1}}']);
  });
  it('reads the handshake and the values, and ignores noise', () => {
    expect(parseSerial('{"omep-device":"0.1","manifest":{"engine":{"id":"x"},"device":{"controls":[]}}}')).toMatchObject({ hello: { manifest: { engine: { id: 'x' } } } });
    expect(parseSerial('{"values":{"a":0.5}}')).toEqual({ values: { a: 0.5 } });
    expect(parseSerial('booting...')).toBeNull();
  });
});
