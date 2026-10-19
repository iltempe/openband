import { describe, expect, it } from 'vitest';
import { decodeProject, encodeProject } from './handoff';
import { demoV1Raw } from './__fixtures__/projects';
import { migrate } from './migrations';

describe('hand-off to the local studio', () => {
  it('round-trips a song through the URL fragment, URL-safe and compressed', () => {
    const p = migrate(demoV1Raw);
    const s = encodeProject(p);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeLessThan(JSON.stringify(p).length);
    expect(decodeProject(s)).toEqual(JSON.parse(JSON.stringify(p)));
  });
});
