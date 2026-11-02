import { describe, expect, it } from 'vitest';
import { tapeGain } from './burn';

describe('the same volume across the tape', () => {
  it('brings a quiet song up to the target', () => expect(20 * Math.log10(tapeGain(-20, -10))).toBeCloseTo(6));
  it('stops at the ceiling', () => expect(20 * Math.log10(tapeGain(-20, -3))).toBeCloseTo(2));
  it('turns a loud song down', () => expect(20 * Math.log10(tapeGain(-8, -0.2))).toBeCloseTo(-6));
  it('leaves silence alone', () => expect(tapeGain(-Infinity, -120)).toBe(1));
});
