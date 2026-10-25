// Taste (SPEC v0.6 §7, E4): blind comparisons teach the router — after 10 of them it changes its choice,
// consistently; a couple of listens or a split decision don't.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bradleyTerry, preferencesFor, recordRanking, resetTaste, tasteByCapability, styleOf } from './taste';
import { route, DEFAULT_POLICY, type EngineInfo } from './router';
import { builtinEngines } from './engines';
import type { Manifest } from './types';

const neural: EngineInfo = {
  id: 'neural-drums',
  transport: 'bridge',
  status: 'ready',
  manifest: { omep: '1.0', engine: { id: 'neural-drums', name: 'Neural drums', version: '1.0.0' }, license: { code: 'MIT', weights: 'MIT', commercial: 'yes' }, runtime: { where: 'local' }, capabilities: { 'symbolic.drums': {} }, outputs: ['application/x-omep-notes'], determinism: 'seeded' } as Manifest,
};
const engines = () => [...builtinEngines(), neural];
const choice = (style = '') => {
  const t = preferencesFor('symbolic.drums', style);
  return route({ capability: 'symbolic.drums' }, engines(), DEFAULT_POLICY, { 'symbolic.drums': t.prefs }, { 'symbolic.drums': t.confidence }).candidates[0].id;
};

describe('taste', () => {
  beforeEach(() => {
    const kv = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) });
    resetTaste();
  });

  it('Bradley–Terry: the engine that keeps winning scores higher, with a narrowing interval', () => {
    const few = bradleyTerry([{ winner: 'a', loser: 'b' }, { winner: 'a', loser: 'b' }]);
    const many = bradleyTerry(Array.from({ length: 12 }, () => ({ winner: 'a', loser: 'b' })));
    expect(few[0].engine).toBe('a');
    expect(many[0].score).toBeGreaterThan(few[0].score);
    expect(many[0].interval).toBeLessThan(few[0].interval);
    expect(bradleyTerry([])).toEqual([]);
  });

  it('after 10 blind comparisons the router changes its choice; 2 are not enough; a split leaves it', () => {
    expect(choice()).toBe('openband-drummer');
    for (let i = 0; i < 2; i++) recordRanking('symbolic.drums', '', ['neural-drums', 'openband-drummer']);
    expect(choice()).toBe('openband-drummer');
    for (let i = 0; i < 8; i++) recordRanking('symbolic.drums', '', ['neural-drums', 'openband-drummer']);
    expect(choice()).toBe('neural-drums');
    resetTaste();
    for (let i = 0; i < 10; i++) recordRanking('symbolic.drums', '', i % 2 ? ['neural-drums', 'openband-drummer'] : ['openband-drummer', 'neural-drums']);
    expect(choice()).toBe('openband-drummer');
  });

  it('per style once there is enough of it; the ranking for "Your engines"', () => {
    for (let i = 0; i < 10; i++) recordRanking('symbolic.drums', 'funk', ['neural-drums', 'openband-drummer']);
    for (let i = 0; i < 10; i++) recordRanking('symbolic.drums', 'pop', ['openband-drummer', 'neural-drums']);
    expect(choice('funk')).toBe('neural-drums');
    expect(choice('pop')).toBe('openband-drummer');
    expect(styleOf('funk drums, busy')).toBe('funk');
    expect(styleOf('a lofi groove')).toBe('lo-fi');
    const all = tasteByCapability();
    expect(all[0]).toMatchObject({ capability: 'symbolic.drums' });
    expect(all[0].ranking[0].comparisons).toBe(20);
  });
});
