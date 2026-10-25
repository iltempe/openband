// Online engines from the page (SPEC v0.6 §9-bis): the relay transport, the quote and the budget.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverBudget, checkBudget, estimate, recordSpend, resetSpending, spending } from './budget';
import { route, DEFAULT_POLICY } from './router';
import { callRelay, relayEngines, setRelay } from './relay';
import { encodeWav } from '../../omep/lib/audio.mjs';
import type { Scp } from './types';

const SCP: Scp = { scp: '1.0', song: { bpm: 120, meter: '4/4', key: 'Am', length_bars: 8 }, scope: { from_bar: 1, to_bar: 9 } };

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
}

describe('online engines in the page', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    resetSpending();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('with a relay set, the catalog models are engines; off by default in the policy', () => {
    expect(relayEngines()).toEqual([]);
    setRelay({ url: 'https://relay.example', token: 't0k' });
    const engines = relayEngines();
    expect(engines.map((e) => e.id)).toEqual(['fal-ace-step', 'fal-demucs']);
    const r = route({ capability: 'music.add_layer' }, engines, DEFAULT_POLICY);
    expect(r.candidates).toEqual([]);
    expect(r.excluded[0].reason).toMatch(/online engines are off/);
    // Online on: fal's terms for the output are conditional, accepted per engine.
    const on = route({ capability: 'music.add_layer' }, engines, { ...DEFAULT_POLICY, allow_cloud: true });
    expect(on.excluded[0].reason).toMatch(/conditional/);
    const ok = route({ capability: 'music.add_layer' }, engines, { ...DEFAULT_POLICY, allow_cloud: true, accepted_conditions: ['fal-ace-step'] });
    expect(ok.candidates.map((c) => c.id)).toEqual(['fal-ace-step']);
    expect(() => setRelay({ url: 'http://evil.example', token: 'x' })).toThrow(/https/);
  });

  it('quotes before running; past the budget nothing starts without confirmation; spending is logged', () => {
    setRelay({ url: 'https://relay.example', token: 't0k' });
    const ace = relayEngines()[0];
    const usd = estimate(ace, 'music.add_layer', SCP, 3);
    expect(usd).toBeCloseTo(16 * 0.0002 * 3, 9);
    const budget = { session_usd: 0.01, month_usd: 0.05 };
    checkBudget(usd, budget);
    recordSpend(ace.id, 'music.add_layer', usd);
    expect(() => checkBudget(usd, budget)).toThrow(OverBudget);
    expect(() => checkBudget(usd, budget)).toThrow(/session budget/);
    expect(() => checkBudget(usd, budget, true)).not.toThrow();
    expect(spending()).toMatchObject({ session_usd: usd, month_usd: usd, byEngine: { 'fal-ace-step': usd } });
  });

  it('runs a model through the relay: the token, never a key; the audio comes back through it', async () => {
    setRelay({ url: 'https://relay.example', token: 't0k' });
    const wav = encodeWav([new Float32Array(16000).fill(0.1)], 8000);
    const seen: { url: string; headers: Record<string, string> }[] = [];
    let polls = 0;
    const fake = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const j = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/fal/fal-ai/ace-step')) return j({ request_id: 'r1', status_url: 'https://queue.fal.run/fal-ai/ace-step/requests/r1/status', response_url: 'https://queue.fal.run/fal-ai/ace-step/requests/r1' });
      if (url.endsWith('/status')) return j({ status: ++polls < 2 ? 'IN_PROGRESS' : 'COMPLETED' });
      if (url.endsWith('/requests/r1')) return j({ audio: { url: 'https://v3b.fal.media/files/b/x/out.wav' } });
      if (url.includes('/media?url=')) return new Response(new Blob([wav], { type: 'audio/wav' }));
      return new Response('nope', { status: 404 });
    });
    const c = await callRelay('fal-ace-step', 'music.add_layer', { context: SCP, request: { text: 'lofi keys' }, seed: 2 }, { fetch: fake as unknown as typeof fetch, pollMs: 1 });
    expect(c).toMatchObject({ kind: 'audio', provenance: { engine: 'fal-ace-step' }, cost_usd: 0.0032 });
    expect(c.files![0].uri).toMatch(/^data:audio\/wav;base64,/);
    expect(c.files![0].role).toBe('layer');
    // Status and result go through the relay too, not to fal.
    expect(seen.map((s) => s.url)).toEqual([
      'https://relay.example/fal/fal-ai/ace-step',
      'https://relay.example/fal/fal-ai/ace-step/requests/r1/status',
      'https://relay.example/fal/fal-ai/ace-step/requests/r1/status',
      'https://relay.example/fal/fal-ai/ace-step/requests/r1',
      `https://relay.example/media?url=${encodeURIComponent('https://v3b.fal.media/files/b/x/out.wav')}`,
    ]);
    for (const s of seen) {
      expect(s.headers['x-relay-token']).toBe('t0k');
      expect(s.headers.authorization).toBeUndefined();
    }
  });
});

describe('conformance steps 6 and 8 for audio', () => {
  it('silence and noise are not placed; a part is brought to the working level; clipping is said', async () => {
    const { audioQuality, planAudio } = await import('./conform');
    const sr = 16000;
    const tone = Float32Array.from({ length: sr * 2 }, (_, i) => 0.05 * Math.sin((2 * Math.PI * 330 * i) / sr));
    let seed = 7;
    const noise = Float32Array.from({ length: sr * 2 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 0.6 - 0.3);
    expect(audioQuality(new Float32Array(sr), sr).reject).toMatch(/silent/);
    expect(audioQuality(noise, sr).reject).toMatch(/noise/);
    expect(audioQuality(tone, sr).reject).toBeUndefined();
    const hot = Float32Array.from({ length: sr * 2 }, (_, i) => Math.max(-1, Math.min(1, 1.5 * Math.sin((2 * Math.PI * 330 * i) / sr))));
    expect(audioQuality(hot, sr).warn).toMatch(/clipped/);
    const c = { kind: 'audio' as const, files: [{ uri: 'data:,', role: 'layer', format: 'wav' as const }], claims: { bpm: 120, length_bars: 1, key: 'Am' }, provenance: { engine: 'x' }, license: { code: 'MIT', weights: null, commercial: 'yes' as const } };
    const plan = planAudio(c, { ...SCP, scope: { from_bar: 1, to_bar: 2 } }, { mono: tone, sampleRate: sr });
    // −29 dBFS RMS → −20: about +9 dB, as a region gain.
    expect(plan.gainDb).toBeCloseTo(-20 - 20 * Math.log10(0.05 / Math.SQRT2), 0);
    expect(() => planAudio(c, SCP, { mono: noise, sampleRate: sr })).toThrow(/noise/);
  });
});
