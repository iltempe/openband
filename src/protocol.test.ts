import { describe, expect, it } from 'vitest';
import { protocolProblem } from './protocol';

describe('bridge protocol', () => {
  it('tells which side is older', () => {
    expect(protocolProblem(1, 1)).toBeNull();
    expect(protocolProblem(undefined, 2)).toBeNull(); // servers before the protocol field
    expect(protocolProblem(1, 2)).toBe('server_old');
    expect(protocolProblem(3, 2)).toBe('app_old');
  });
});
