import { describe, expect, it } from 'vitest';
import { findChrome, parseTestArgs } from './songtest.mjs';

describe('openband test arguments', () => {
  it('reads them', () => {
    expect(parseTestArgs(['s.openband', '--format', 'junit', '--strict', '--baseline=v1', '--chrome', '/x'])).toEqual({ file: 's.openband', format: 'junit', strict: true, baseline: 'v1', chrome: '/x' });
    expect(parseTestArgs(['s.json']).format).toBe('text');
  });
  it('takes the Chrome it is given when it exists', () => expect(findChrome(process.execPath)).toBe(process.execPath));
});
