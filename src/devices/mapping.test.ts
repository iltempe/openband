import { describe, expect, it } from 'vitest';
import { applyCurve, mapValue, smoother, thinPoints } from './mapping';

describe('mapping a control', () => {
  it('follows the curve and the range', () => {
    expect(applyCurve(0.5, 'linear')).toBe(0.5);
    expect(applyCurve(0.5, 'exp')).toBe(0.25);
    expect(applyCurve(0.25, 'log')).toBe(0.5);
    expect(applyCurve(7, 'linear')).toBe(1);
    expect(mapValue(0.5, { curve: 'linear', min: 200, max: 400 })).toBe(300);
  });
  it('smooths with a time constant, whatever the rate', () => {
    const a = smoother(20);
    a(0, 10);
    expect(a(1, 20)).toBeCloseTo(1 - Math.exp(-1));
    const b = smoother(20);
    b(0, 10);
    b(1, 10);
    expect(b(1, 10)).toBeCloseTo(1 - Math.exp(-1));
    expect(smoother(0)(5, 10)).toBe(5);
  });
  it('thins a gesture and keeps where it ended', () => {
    const pts = Array.from({ length: 100 }, (_, i) => ({ beat: i / 100, value: i < 50 ? i / 50 : 1 }));
    const thin = thinPoints(pts);
    expect(thin.length).toBeLessThan(25);
    expect(thin[thin.length - 1]).toEqual(pts[99]);
  });
});
