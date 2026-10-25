import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeWav } from '../../omep/lib/audio.mjs';
import { useStore } from '../store';
import { commands } from '../commands';
import { BEATS_PER_BAR } from '../music';
import { DEFAULT_POLICY, inferCapability, route, type EngineInfo } from './router';
import { buildContext, minimizeContext } from './context';
import { conformNotes, nearestShift, planAudio } from './conform';
import { BUILTINS } from './builtin';
import { setExternalEngines, setPolicy } from './engines';
import { shares } from './ledger';
import type { Contribution, Manifest } from './types';

const manifest = (id: string, over: Partial<Manifest> = {}): Manifest => ({
  omep: '1.0',
  engine: { id, name: id, version: '1' },
  license: { code: 'MIT', weights: 'MIT', commercial: 'yes' },
  runtime: { where: 'local' },
  capabilities: { 'symbolic.accompany': { conditioning: ['key', 'chords'] } },
  outputs: ['application/x-omep-notes'],
  determinism: 'seeded',
  ...over,
});
const ext = (id: string, over: Partial<Manifest> = {}, adherence?: number): EngineInfo => ({ id, manifest: manifest(id, over), transport: 'bridge', status: 'ready', adherence });

describe('router', () => {
  it('filters by licence, privacy, status, conditioning and language — and says why', () => {
    const engines = [
      ext('nc', { license: { code: 'MIT', weights: 'CC BY-NC 4.0', commercial: 'no' } }),
      ext('cond', { license: { code: 'X', weights: 'X', commercial: 'conditional', conditions: 'under $1M revenue' } }),
      ext('cloud', { runtime: { where: 'cloud', provider: 'fal', pricing: { unit: 'second', usd: 0.0002 }, data_policy: { uploads_audio: true, training_on_inputs: 'no', terms_url: 'https://x', verified: '2026-10-21' }, output_rights: { commercial: 'yes' } } }),
      ext('lan', { runtime: { where: 'lan' } }),
      { ...ext('down'), status: 'error' as const, error: 'CUDA out of memory' },
      ext('nolyrics'),
      ext('en-only', { languages: ['en'] }),
      ext('good', {}, 0.9),
    ];
    const r = route({ capability: 'symbolic.accompany' }, engines, DEFAULT_POLICY);
    const why = Object.fromEntries(r.excluded.map((x) => [x.id, x.reason]));
    expect(why.nc).toMatch(/commercial/);
    expect(why.cond).toMatch(/under \$1M revenue/);
    expect(why.cloud).toMatch(/online engines are off/);
    expect(why.down).toMatch(/CUDA out of memory/);
    expect(r.candidates.map((c) => c.id)).toEqual(['good', 'en-only', 'nolyrics', 'lan']);
    // Needs and language.
    const sing = route({ capability: 'symbolic.accompany', needs: ['lyrics'], language: 'it' }, engines, DEFAULT_POLICY);
    expect(sing.candidates).toEqual([]);
    expect(Object.fromEntries(sing.excluded.map((x) => [x.id, x.reason])).good).toMatch(/doesn't use lyrics/);
    // Local only drops LAN and cloud; accepting conditions lets the conditional one in.
    const local = route({ capability: 'symbolic.accompany' }, engines, { ...DEFAULT_POLICY, local_only: true, accepted_conditions: ['cond'] });
    expect(local.candidates.map((c) => c.id)).toContain('cond');
    expect(local.candidates.map((c) => c.id)).not.toContain('lan');
    // Turning commercial_only off admits the non-commercial engine.
    expect(route({ capability: 'symbolic.accompany' }, engines, { ...DEFAULT_POLICY, commercial_only: false }).candidates.map((c) => c.id)).toContain('nc');
  });

  it('builtins first by default; preferences and adherence change the order; pinned engines still obey the policy', () => {
    const builtin: EngineInfo = { id: 'openband-chords', manifest: BUILTINS[1].manifest, transport: 'builtin', status: 'ready' };
    const fancy = ext('fancy', {}, 0.98);
    expect(route({ capability: 'symbolic.accompany' }, [fancy, builtin]).candidates[0].id).toBe('openband-chords');
    expect(route({ capability: 'symbolic.accompany' }, [fancy, builtin], DEFAULT_POLICY, { 'symbolic.accompany': { fancy: 1, 'openband-chords': 0 } }).candidates[0].id).toBe('fancy');
    expect(route({ capability: 'symbolic.accompany', engine: 'fancy' }, [fancy, builtin]).candidates.map((c) => c.id)).toEqual(['fancy']);
    expect(() => route({ capability: 'symbolic.accompany', engine: 'nc' }, [ext('nc', { license: { code: 'MIT', weights: null, commercial: 'no' } })])).toThrow(/doesn’t allow commercial use/);
    expect(() => route({ capability: 'symbolic.accompany', engine: 'ghost' }, [builtin])).toThrow(/not installed/);
  });

  it('infers the capability from the target track and the words', () => {
    expect(inferCapability({ text: 'funk drums' })).toBe('symbolic.drums');
    expect(inferCapability({ trackKind: 'drums' })).toBe('symbolic.drums');
    expect(inferCapability({ text: 'una batteria lo-fi' })).toBe('symbolic.drums');
    expect(inferCapability({ text: 'a keys loop' })).toBe('music.add_layer');
    expect(inferCapability({ text: 'arpeggiated piano' })).toBe('symbolic.accompany');
    expect(inferCapability({ capability: 'music.extend', text: 'drums' })).toBe('music.extend');
  });
});

function songWithChords() {
  commands.new_project({ name: 'Ctx', bpm: 92, key: 'Dm' });
  const keys = commands.add_track({ kind: 'instrument', instrument: 'felt-piano', name: 'Piano' }) as { track_id: string };
  commands.add_chord_progression({ track_id: keys.track_id, start_bar: 1, chords: ['Dm7', 'Gm7', 'Bbmaj7', 'A7'], beats_per_chord: 4 });
  commands.add_section({ name: 'Verse', kind: 'verse', start_bar: 1, length_bars: 4 });
  return keys.track_id;
}

describe('song context package', () => {
  beforeEach(() => useStore.setState({ past: [], future: [], activeTransaction: null }));

  it('carries the song, its sections and harmony, the tracks with roles, and a hash of the canonical song', async () => {
    songWithChords();
    const scp = await buildContext(useStore.getState().project, { scope: { from_bar: 1, to_bar: 5 }, intent: { text: 'bass' } });
    expect(scp.song).toMatchObject({ bpm: 92, key: 'Dm', meter: '4/4', length_bars: 4 });
    expect(scp.sections?.[0]).toMatchObject({ kind: 'verse', from_bar: 1, bars: 4 });
    expect(scp.harmony?.map((h) => h.chord)).toEqual(['Dm7', 'Gm7', 'Bbmaj7', 'A7']);
    expect(scp.tracks?.[0]).toMatchObject({ name: 'Piano', role: 'harmony' });
    expect(scp.context_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const again = await buildContext(useStore.getState().project, { scope: { from_bar: 1, to_bar: 5 } });
    expect(again.context_hash).toBe(scp.context_hash);
    commands.set_tempo({ bpm: 93 });
    expect((await buildContext(useStore.getState().project)).context_hash).not.toBe(scp.context_hash);
    // An engine that only uses bpm and key gets neither the harmony nor the track list.
    const slim = minimizeContext(scp, manifest('x', { capabilities: { 'symbolic.accompany': { conditioning: ['bpm', 'key'] } } }), 'symbolic.accompany');
    expect(slim.harmony).toBeUndefined();
    expect(slim.tracks).toBeUndefined();
    expect(slim.song.key).toBe('Dm');
  });
});

describe('conformance pipeline', () => {
  const scp = { scp: '1.0' as const, song: { bpm: 120, meter: '4/4', key: 'Dm', length_bars: 8 }, scope: { from_bar: 1, to_bar: 3 }, constraints: { hard: { range: ['C3', 'C5'] as [string, string] } } };
  const lic = { code: 'MIT', weights: null, commercial: 'yes' as const };

  it('notes: moves a part played in the wrong key back, fixes the octave, drops what is outside the scope', () => {
    // A D minor line a semitone up (Ebm), two octaves too high, and one note past bar 2.
    const dm = [62, 64, 65, 67, 69, 70, 72, 74];
    const notes = dm.map((p, i) => ({ pitch: p + 1 + 24, start: i, duration: 1, velocity: 0.8 })).concat([{ pitch: 87, start: 8.5, duration: 1, velocity: 0.8 }]);
    const c: Contribution = { kind: 'notes', notes, claims: { key: 'Dm', length_bars: 2 }, provenance: { engine: 'x' }, license: lic };
    const r = conformNotes(c, scp);
    expect(r.notes.map((n) => n.pitch)).toEqual(dm.map((p) => p - 12));
    expect(r.conform.join(' | ')).toMatch(/claimed Dm, sounds in Ebm/);
    expect(r.conform.join(' | ')).toMatch(/pitch -1 st into Dm/);
    expect(r.conform.join(' | ')).toMatch(/octave -3 into the range C3–C5/);
    expect(r.conform.join(' | ')).toMatch(/1 note\(s\) outside the scope dropped/);
  });

  it('audio: stretches a loop to the song tempo, moves its key, repeats it to fill the scope', () => {
    expect(nearestShift('Am', 'Dm')).toBe(5);
    expect(nearestShift('F', 'Dm')).toBe(0); // relative major: no move
    expect(nearestShift('Ebm', 'Dm')).toBe(-1);
    // A one-bar A minor arpeggio at 100 BPM.
    const sr = 22050;
    const bpm = 100;
    const x = new Float32Array(Math.round(((4 * 60) / bpm) * sr));
    [57, 60, 64, 69].forEach((p, b) => {
      const f = 440 * 2 ** ((p - 69) / 12);
      const at = Math.round(((b * 60) / bpm) * sr);
      for (let k = 0; k < sr * 0.5 && at + k < x.length; k++) x[at + k] += 0.5 * Math.exp((-k / sr) * 5) * Math.sin((2 * Math.PI * f * k) / sr);
    });
    const c: Contribution = { kind: 'audio', files: [{ uri: 'data:,', role: 'layer', format: 'wav' }], claims: { bpm: 100, key: 'Am', length_bars: 1 }, provenance: { engine: 'x' }, license: lic };
    const plan = planAudio(c, { ...scp, scope: { from_bar: 1, to_bar: 5 } }, { mono: x, sampleRate: sr });
    expect(plan.sourceBpm).toBe(100);
    expect(plan.stretch).toBe(true);
    expect(plan.pitch).toBe(5);
    expect(plan.bars).toBeCloseTo(1, 2);
    expect(plan.repeats).toBe(4);
    expect(plan.conform.join(' | ')).toMatch(/stretch 20\.0%.*pitch \+5 st \(Am → Dm\).*repeated ×4/);
  });
});

describe('conformance on the CC0 loop library', () => {
  it('trusts what each loop declares when its duration confirms it: no stretch, no shift, nothing to report', () => {
    const lib = JSON.parse(fs.readFileSync('public/loops/index.json', 'utf8')) as { loops: { id: string; url: string; bpm: number; bars: number; key?: string }[] };
    const lic = { code: 'MIT', weights: 'CC0-1.0', commercial: 'yes' as const };
    for (const l of lib.loops) {
      const { sampleRate, channels } = decodeWav(fs.readFileSync(`public/${l.url}`));
      const c: Contribution = { kind: 'audio', files: [{ uri: 'data:,', role: 'layer', format: 'wav' }], claims: { bpm: l.bpm, length_bars: l.bars, ...(l.key ? { key: l.key } : {}) }, provenance: { engine: 'openband-loops', prompt: l.id }, license: lic };
      const song = { scp: '1.0' as const, song: { bpm: l.bpm, meter: '4/4', key: l.key ?? 'C', length_bars: 8 }, scope: { from_bar: 1, to_bar: 1 + l.bars } };
      const plan = planAudio(c, song, { mono: channels[0], sampleRate, name: `${l.id}.wav` });
      expect({ id: l.id, stretch: plan.stretch, pitch: plan.pitch, conform: plan.conform }).toEqual({ id: l.id, stretch: false, pitch: 0, conform: [] });
      expect(plan.bars).toBeCloseTo(l.bars, 2);
      // Over 8 bars: exactly 8 / bars repetitions (decoders can leave a loop a few samples short).
      const wide = planAudio(c, { ...song, scope: { from_bar: 1, to_bar: 9 } }, { mono: channels[0], sampleRate, name: `${l.id}.wav` });
      expect(wide.repeats).toBe(Math.ceil(8 / l.bars));
    }
  });
});

describe('create', () => {
  beforeEach(() => {
    useStore.setState({ past: [], future: [], activeTransaction: null, bridgeLog: [] });
    setExternalEngines(null, null);
    setPolicy({ ...DEFAULT_POLICY });
  });
  afterEach(() => setExternalEngines(null, null));

  it('drums from the builtin drummer: a drum track, a region over the bars, a ledger entry, one undo step', async () => {
    commands.new_project({ name: 'C', bpm: 100, key: 'Am' });
    useStore.setState({ past: [], future: [] });
    const r = (await commands.create({ text: 'funk drums', from_bar: 1, to_bar: 4, seed: 3 })) as { track_id: string; region_id: string; engines: string[]; capability: string };
    expect(r.capability).toBe('symbolic.drums');
    expect(r.engines).toEqual(['OpenBand Drummer']);
    const p = useStore.getState().project;
    const region = p.regions.find((x) => x.id === r.region_id)!;
    expect(p.tracks.find((t) => t.id === r.track_id)!.kind).toBe('drums');
    expect(region.start).toBe(0);
    expect(region.length).toBe(4 * BEATS_PER_BAR);
    expect(region.notes.length).toBeGreaterThan(20);
    expect(p.ledger).toHaveLength(1);
    expect(p.ledger![0]).toMatchObject({ source: 'builtin', engine: 'openband-drummer', capability: 'symbolic.drums', prompt: 'funk', seed: 3, request: 'funk drums', regionIds: [r.region_id] });
    expect(shares(p).find((s) => s.trackId === r.track_id)!.ai).toBe(1);
    expect(useStore.getState().past).toHaveLength(1);
    commands.undo({});
    expect(useStore.getState().project.regions).toHaveLength(0);
    expect(useStore.getState().project.ledger ?? []).toHaveLength(0);
  });

  it('variants become takes of one region, each with its own ledger entry; a user take makes the region human again', async () => {
    const keys = songWithChords();
    const before = useStore.getState().project.regions.length;
    const r = (await commands.create({ text: 'arpeggiated piano', section_id: 'Verse', variants: 2, seed: 1 })) as { region_id: string; take_ids: string[]; track_id: string };
    const p = useStore.getState().project;
    expect(p.regions).toHaveLength(before + 1);
    const region = p.regions.find((x) => x.id === r.region_id)!;
    expect(region.takes).toHaveLength(2);
    expect(region.notes.every((n) => n.duration === 0.5)).toBe(true); // arpeggio
    expect(p.ledger?.map((e) => e.takeIds)).toEqual([[r.take_ids[0]], [r.take_ids[1]]]);
    expect(r.track_id).not.toBe(keys);
    // The user plays their own take and picks it.
    const mine = commands.add_take({ region_id: r.region_id, notes: [{ pitch: 'D4', start: 0, duration: 4 }], name: 'Mine' }) as { take_id: string };
    expect(useStore.getState().project.regions.find((x) => x.id === r.region_id)!.activeTakeId).toBe(mine.take_id);
    expect(shares(useStore.getState().project).find((s) => s.trackId === r.track_id)!.ai).toBe(0);
  });

  it('external engines: conformed into key, rotated for variants, fallback on failure, licence policy respected', async () => {
    songWithChords();
    const calls: string[] = [];
    const wrongKey = (engine: string): Contribution => ({ kind: 'notes', notes: [62, 65, 69, 72].map((p, i) => ({ pitch: p + 1, start: i * 4, duration: 4, velocity: 0.7 })), claims: { key: 'Dm' }, provenance: { engine, seed: 1 }, license: { code: 'MIT', weights: 'MIT', commercial: 'yes' } });
    setExternalEngines(
      async () => [
        { id: 'flaky', status: 'ready', manifest: manifest('flaky') },
        { id: 'sharp', status: 'ready', manifest: manifest('sharp') },
        { id: 'nc', status: 'ready', manifest: manifest('nc', { license: { code: 'MIT', weights: 'CC BY-NC 4.0', commercial: 'no' } }) },
        { id: 'broken', status: 'error', error: 'spawn uvx ENOENT' },
      ],
      async (engine, _cap, args) => {
        calls.push(`${engine}:${args.context.harmony ? 'harmony' : 'no-harmony'}`);
        if (engine === 'flaky') throw new Error('timeout');
        return wrongKey(engine);
      },
    );
    const r = (await commands.create({ text: 'pad', engine: 'sharp', section_id: 'Verse' })) as { region_id: string; corrections: string[][]; engines: string[] };
    expect(r.engines).toEqual(['sharp']);
    expect(r.corrections[0].join(' ')).toMatch(/pitch -1 st into Dm/);
    expect(useStore.getState().project.regions.find((x) => x.id === r.region_id)!.notes.map((n) => n.pitch)).toEqual([62, 65, 69, 72]);
    expect(calls).toEqual(['sharp:harmony']);
    // Unpinned with the builtin removed from contention by pinning nothing: the router picks the builtin first;
    // a pinned flaky engine fails with its reason, the non-commercial one is refused.
    await expect(commands.create({ text: 'pad', engine: 'flaky', section_id: 'Verse' })).rejects.toThrow(/Every engine failed: flaky: timeout/);
    await expect(commands.create({ text: 'pad', engine: 'nc', section_id: 'Verse' })).rejects.toThrow(/commercial/);
    const list = (await commands.list_engines({ capability: 'symbolic.accompany' })) as { routes: { order: string[]; excluded: { id: string; reason: string }[] }[]; unavailable: { id: string; error: string }[] };
    expect(list.routes[0].order[0]).toBe('openband-chords');
    expect(list.routes[0].excluded.map((x) => x.id)).toEqual(['nc']);
    expect(list.unavailable).toEqual([{ id: 'broken', error: 'spawn uvx ENOENT' }]);
    // Three variants rotate across the candidates; the flaky one falls back to the next.
    calls.length = 0;
    const v = (await commands.create({ text: 'pad', section_id: 'Verse', variants: 3, seed: 5 })) as { engines: string[]; failed?: string[] };
    expect(v.engines).toHaveLength(3);
    expect(new Set(v.engines).size).toBeGreaterThan(1);
    expect(v.failed?.some((f) => /flaky: timeout/.test(f))).toBe(true);
  });
});

describe('ghost notes and the arranger as builtin engines (G3, G2)', () => {
  it('symbolic.continue continues the melody in the SCP; symbolic.harmonize gives chords; music.arrange a plan', async () => {
    const { BUILTINS } = await import('./builtin');
    const ghost = BUILTINS.find((b) => b.manifest.engine.id === 'openband-ghost')!;
    const arranger = BUILTINS.find((b) => b.manifest.engine.id === 'openband-arranger')!;
    const scp = {
      scp: '1.0' as const,
      song: { bpm: 96, meter: '4/4', key: 'Am', length_bars: 8 },
      scope: { from_bar: 1, to_bar: 5 },
      harmony: ['Am', 'F', 'C', 'G'].map((chord, i) => ({ bar: i + 1, chord })),
      melody: { notes: [69, 72, 76, 74, 72, 69].map((pitch, i) => ({ pitch, start: i, duration: 1, velocity: 0.8 })) },
      tracks: [{ id: 'd', role: 'drums' }, { id: 'k', role: 'harmony' }, { id: 'b', role: 'bass' }],
    };
    const cont = await ghost.run('symbolic.continue', { context: scp, seed: 2 });
    expect(cont.kind).toBe('notes');
    expect(cont.notes!.length).toBeGreaterThan(0);
    expect(Math.min(...cont.notes!.map((n) => n.start))).toBeGreaterThanOrEqual(6 - 1e-6);
    expect(cont.provenance.prompt).toMatch(/chord tones/);
    const harm = await ghost.run('symbolic.harmonize', { context: scp });
    expect(harm.notes!.length).toBeGreaterThanOrEqual(6);
    const plan = await arranger.run('music.arrange', { context: scp, request: { shape: 'pop', length_bars: 64 } });
    const sections = (plan.params as { sections: { kind: string; tracks: string[] }[] }).sections;
    expect(sections[0].kind).toBe('intro');
    expect(sections[0].tracks).toEqual(['k']);
    expect(sections.find((s) => s.kind === 'chorus')!.tracks.sort()).toEqual(['b', 'd', 'k']);
  });
});
