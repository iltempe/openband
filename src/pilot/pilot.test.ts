import { describe, expect, it } from 'vitest';
import type { Project, Track } from '../types';
import { emptyProject, makeTrack } from '../store';
import { faderToDb } from '../music';
import { autoRole, noteFacts, roleOf } from './roles';
import { blendMaster, blendTrack, mixOf, planMaster, planTracks, PROFILES, spectralTilt, WORKING_LEVEL, type MaskPair, type TrackMeasure } from './plan';
import { residual } from './exportPlatforms';
import { TruePeakLimiter } from '../audio/worklets/master-dsp.js';
import { encodePcm } from '../audio/render';
import { decodeWav } from '../../omep/lib/audio.mjs';

const fmt = (key: string, vars: Record<string, string | number>) => `${key} ${JSON.stringify(vars)}`;

function song(): { p: Project; ids: Record<string, string> } {
  const p = emptyProject('Pilot test', 100);
  const add = (kind: Track['kind'], instrument: string, name: string) => {
    const t = makeTrack(p, kind, instrument, name);
    p.tracks.push(t);
    return t.id;
  };
  const ids = {
    drums: add('drums', 'kit-studio', 'Drums'),
    bass: add('instrument', 'finger-bass', 'Bass'),
    keys: add('instrument', 'felt-piano', 'Piano'),
    pad: add('instrument', 'aurora-pad', 'Pad'),
    lead: add('instrument', 'neon-lead', 'Lead'),
    vox: add('audio', 'audio', 'Voce'),
  };
  const notes = (pitches: number[][], len = 1) => pitches.flatMap((ch, i) => ch.map((pitch, k) => ({ id: `n${i}_${k}`, pitch, start: i * len, duration: len, velocity: 0.8 })));
  const region = (trackId: string, n: ReturnType<typeof notes>) => p.regions.push({ id: `r_${trackId}`, trackId, name: 'x', start: 0, length: 16, notes: n } as Project['regions'][number]);
  region(ids.bass, notes([[36], [36], [43], [41]]));
  region(ids.keys, notes([[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]], 4));
  region(ids.lead, notes([[72], [74], [76], [79], [76], [74]]));
  return { p, ids };
}

describe('mix pilot: roles', () => {
  it('reads names (Italian and English), presets and notes', () => {
    const { p, ids } = song();
    const role = (id: string) => roleOf(p.tracks.find((t) => t.id === id)!, noteFacts(p, id));
    expect(role(ids.drums)).toBe('drums');
    expect(role(ids.bass)).toBe('bass');
    expect(role(ids.keys)).toBe('harmony');
    expect(role(ids.pad)).toBe('texture');
    expect(role(ids.lead)).toBe('lead');
    expect(role(ids.vox)).toBe('vocal');
    const kick = makeTrack(p, 'drums', 'kit-808', 'Cassa');
    expect(autoRole(kick)).toBe('kick');
    const low = makeTrack(p, 'instrument', 'felt-piano', 'Left hand');
    expect(autoRole(low, { meanPitch: 40, polyphony: 0 })).toBe('bass');
    expect(autoRole(low, { meanPitch: 72, polyphony: 0.05 })).toBe('lead');
    const guitar = makeTrack(p, 'audio', 'audio', 'Audio 3');
    expect(autoRole(guitar, { dominant: 'bass' })).toBe('bass');
  });

  it("the user's role wins", () => {
    const { p, ids } = song();
    const t = p.tracks.find((x) => x.id === ids.keys)!;
    t.role = 'lead';
    expect(roleOf(t, noteFacts(p, t.id))).toBe('lead');
  });
});

function measures(p: Project, lufs: Record<string, number>): Record<string, TrackMeasure> {
  return Object.fromEntries(p.tracks.map((t) => [t.id, { lufs: lufs[t.id] ?? -20 }]));
}

describe('mix pilot: the proposal', () => {
  it('trims every track to the working level and balances the faders by role', () => {
    const { p, ids } = song();
    p.tracks.find((t) => t.id === ids.keys)!.volume = 0.4; // −6 dB on the fader
    const m = measures(p, { [ids.keys]: -26, [ids.drums]: -10 });
    const plan = planTracks({ project: p, profile: PROFILES.pop, measures: m, masking: [], facts: {}, fmt });
    // Piano: −26 with a −6 dB fader → −20 pre-fader → trim +2 to reach −18.
    expect(plan.tracks[ids.keys].fx!.trim).toBeCloseTo(WORKING_LEVEL - (-26 + 6), 5);
    expect(plan.tracks[ids.drums].fx!.trim).toBeCloseTo(-8, 5);
    // Pop: the vocal is the loudest role (0 dB); harmony 8 dB under it (two harmony-ish tracks? no: piano alone).
    expect(faderToDb(plan.tracks[ids.vox].volume)).toBeCloseTo(0, 0);
    expect(faderToDb(plan.tracks[ids.keys].volume)).toBeCloseTo(PROFILES.pop.balance.harmony, 0);
    expect(faderToDb(plan.tracks[ids.bass].volume)).toBeCloseTo(PROFILES.pop.balance.bass, 0);
  });

  it('cuts the less important track where two mask each other, high-passes, sidechains and pans', () => {
    const { p, ids } = song();
    const masking: MaskPair[] = [
      { a: ids.keys, b: ids.vox, band: 'mid', score: 0.7 },
      { a: ids.drums, b: ids.bass, band: 'bass', score: 0.6 },
    ];
    const facts = Object.fromEntries(p.tracks.map((t) => [t.id, noteFacts(p, t.id)]));
    const plan = planTracks({ project: p, profile: PROFILES.pop, measures: measures(p, {}), masking, facts, fmt });
    const keys = plan.tracks[ids.keys].fx!;
    // Masking 0.7 → −(1 + 3 × 0.8) = −3.4, in half-dB steps.
    expect(keys.eq.bands).toEqual([{ hz: 1000, gain: -3.5, q: 1.2 }]);
    expect(plan.tracks[ids.vox].fx!.eq.bands ?? []).toEqual([]);
    // The piano's lowest note is F3 (53, 174.6 Hz): high-pass an octave under.
    expect(keys.eq.hpf).toEqual({ on: true, hz: 87 });
    expect(plan.tracks[ids.bass].fx!.eq.hpf).toBeUndefined();
    expect(plan.tracks[ids.drums].fx!.eq.hpf).toBeUndefined();
    // Pop wants the kick → bass sidechain; no EQ cut for that pair.
    expect(plan.tracks[ids.bass].fx!.comp).toMatchObject({ on: true, sidechain: { sourceTrackId: ids.drums, amount: 0.7 } });
    expect(plan.tracks[ids.bass].fx!.eq.bands ?? []).toEqual([]);
    // Low end, lead and voice in the middle; piano and pad mirrored.
    for (const id of [ids.drums, ids.bass, ids.lead, ids.vox]) expect(plan.tracks[id].pan).toBe(0);
    expect(plan.tracks[ids.keys].pan).toBe(-plan.tracks[ids.pad].pan);
    expect(Math.abs(plan.tracks[ids.keys].pan)).toBeCloseTo(PROFILES.pop.panWidth, 5);
    // Sends from the genre.
    expect(plan.tracks[ids.vox].reverb).toBe(PROFILES.pop.reverb.vocal);
    expect(plan.tracks[ids.bass].reverb).toBe(0);
    expect(plan.decisions.some((d) => d.kind === 'eq' && d.trackId === ids.keys)).toBe(true);
    // Hip-hop has the sidechain too; rock doesn't: then the bass gets a cut instead.
    const rock = planTracks({ project: p, profile: PROFILES.rock, measures: measures(p, {}), masking, facts, fmt });
    expect(rock.tracks[ids.bass].fx!.comp.sidechain).toBeUndefined();
    expect(rock.tracks[ids.drums].fx!.eq.bands ?? []).toEqual([]);
    expect(rock.tracks[ids.bass].fx!.eq.bands?.length).toBe(1);
  });

  it('leaves muted and silent tracks alone', () => {
    const { p, ids } = song();
    p.tracks.find((t) => t.id === ids.pad)!.mute = true;
    const plan = planTracks({ project: p, profile: PROFILES.pop, measures: measures(p, { [ids.lead]: -Infinity }), masking: [], facts: {}, fmt });
    expect(plan.tracks[ids.pad]).toBeUndefined();
    expect(plan.tracks[ids.lead]).toBeUndefined();
  });
});

describe('mix pilot: the knob', () => {
  it('amount 0 is the song unchanged, 1 the full proposal, and in between a blend', () => {
    const { p, ids } = song();
    const before = mixOf(p.tracks.find((t) => t.id === ids.keys)!);
    const plan = planTracks({ project: p, profile: PROFILES.pop, measures: measures(p, {}), masking: [{ a: ids.keys, b: ids.vox, band: 'mid', score: 0.8 }], facts: {}, fmt });
    const full = plan.tracks[ids.keys];
    expect(blendTrack(before, full, 0)).toEqual(before);
    expect(blendTrack(before, full, 1)).toEqual(full);
    const half = blendTrack(before, full, 0.5);
    expect(half.fx!.eq.bands![0].gain).toBeCloseTo(full.fx!.eq.bands![0].gain / 2, 1);
    expect(half.pan).toBeCloseTo(full.pan / 2, 2);
    expect(faderToDb(half.volume)).toBeCloseTo((faderToDb(before.volume) + faderToDb(full.volume)) / 2, 0);
    expect(half.fx!.eq.hpf!.hz).toBeGreaterThan(20);
    expect(half.fx!.eq.hpf!.hz).toBeLessThan(full.fx!.eq.hpf!.hz);
  });

  it('the master: nothing at 0, the platform target at any dose above it', () => {
    const fmtM = (k: string) => k;
    const { master } = planMaster(undefined, { bandsDb: { bass: -20, lowmid: -22, mid: -24, highmid: -30, presence: -34, air: -40 }, peakDb: -4 }, PROFILES.edm, 'club', fmtM);
    expect(master.limiter).toMatchObject({ on: true, targetLufs: -8, ceilingDbtp: -1 });
    expect(master.glue.threshold).toBe(-10);
    expect(blendMaster(null, master, 0)).toBeNull();
    const half = blendMaster(null, master, 0.5)!;
    expect(half.limiter).toEqual(master.limiter);
    expect(half.eq.tilt).toBeCloseTo(master.eq.tilt / 2, 1);
    expect(half.glue.ratio).toBeCloseTo(1.5, 2);
    expect(blendMaster(null, master, 1)).toEqual(master);
    const cd = planMaster(undefined, { bandsDb: {}, peakDb: -4 }, PROFILES.pop, 'cd', fmtM).master;
    expect(cd.limiter).toMatchObject({ targetLufs: -9, ceilingDbtp: -0.5 });
  });

  it('measures the spectral tilt in dB per octave', () => {
    // Equal power per octave (pink): flat.
    const pink = { bass: 0, lowmid: 0, mid: 0, highmid: 0, presence: 0, air: 0 };
    const oct = { bass: Math.log2(250 / 60), lowmid: 1, mid: 2, highmid: 1, presence: Math.log2(6000 / 4000), air: Math.log2(20000 / 6000) };
    const perBand = (slope: number) => Object.fromEntries(Object.entries(oct).map(([b, o]) => {
      const lo = { bass: 60, lowmid: 250, mid: 500, highmid: 2000, presence: 4000, air: 6000 }[b]!;
      const centre = Math.log2((lo * Math.pow(2, o / 2)) / 1000);
      return [b, slope * centre + 10 * Math.log10(o)];
    }));
    expect(spectralTilt(perBand(0))).toBeCloseTo(0, 5);
    expect(spectralTilt(perBand(-4))).toBeCloseTo(-4, 5);
    expect(spectralTilt(pink)).not.toBeNaN();
  });
});

describe('export for platforms', () => {
  it('a limiter linked to the mix makes the stems add up to the limited mix', () => {
    const fs = 48000;
    const n = fs;
    const a = [new Float32Array(n), new Float32Array(n)];
    const b = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      a[0][i] = a[1][i] = 0.9 * Math.exp(-(t % 0.25) * 20) * Math.sin(2 * Math.PI * 60 * t);
      b[0][i] = 0.5 * Math.sin(2 * Math.PI * 440 * t);
      b[1][i] = 0.5 * Math.sin(2 * Math.PI * 660 * t);
    }
    const mix = [0, 1].map((c) => a[c].map((x, i) => x + b[c][i]));
    const run = (sig: Float32Array[], key: Float32Array[] | null) => {
      const lim = new TruePeakLimiter(fs, { channels: 2, ceilingDb: -1, inputGainDb: 6 });
      const out = [new Float32Array(n), new Float32Array(n)];
      for (let i = 0; i < n; i += 128) {
        const o = [out[0].subarray(i, i + 128), out[1].subarray(i, i + 128)];
        lim.process(sig.map((c) => c.subarray(i, i + 128)), o, key ? key.map((c) => c.subarray(i, i + 128)) : null);
      }
      return out;
    };
    const master = run(mix, null);
    const sa = run(a, mix);
    const sb = run(b, mix);
    const sum = [0, 1].map((c) => sa[c].map((x, i) => x + sb[c][i]));
    expect(residual(master, sum)).toBeLessThan(-60);
    // Unlinked, each stem would be limited on its own and the sum would differ.
    const ua = run(a, null);
    const ub = run(b, null);
    expect(residual(master, [0, 1].map((c) => ua[c].map((x, i) => x + ub[c][i])))).toBeGreaterThan(-40);
  });

  it('writes 24-bit WAVs, and 16-bit with TPDF dither', () => {
    const n = 4800;
    const ch = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) ch[0][i] = ch[1][i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    const w24 = encodePcm(ch, 48000, 24);
    expect(w24.length).toBe(44 + n * 2 * 3);
    const d24 = decodeWav(Buffer.from(w24));
    expect(d24.sampleRate).toBe(48000);
    expect(Math.max(...[...d24.channels[0]].map((x, i) => Math.abs(x - ch[0][i])))).toBeLessThan(1e-6);
    const w16 = encodePcm(ch, 44100, 16, true);
    const d16 = decodeWav(Buffer.from(w16));
    const err = [...d16.channels[0]].map((x, i) => x - ch[0][i]);
    // Triangular dither: within ±1.5 LSB (+ the 32767/32768 scale), not constant, about zero on average.
    expect(Math.max(...err.map(Math.abs))).toBeLessThan(2.1 / 32768);
    expect(Math.abs(err.reduce((s, x) => s + x, 0) / n)).toBeLessThan(0.1 / 32768);
    expect(new Set(err.map((x) => Math.round(x * 32768))).size).toBeGreaterThan(1);
    // Same song, same file.
    expect(encodePcm(ch, 44100, 16, true)).toEqual(w16);
  });
});

describe('mix pilot as an OMEP engine (mix.assist)', () => {
  it('answers from the context: params by role, valid manifest and contribution', async () => {
    const { BUILTINS } = await import('../ensemble/builtin');
    const { buildContext } = await import('../ensemble/context');
    const { validate } = await import('../../omep/lib/schemas.mjs');
    const engine = BUILTINS.find((e) => e.manifest.engine.id === 'openband-pilot')!;
    expect(validate('manifest', engine.manifest)).toEqual([]);
    const { p, ids } = song();
    const context = await buildContext(p);
    const c = await engine.run('mix.assist', { context, request: { text: 'a lo-fi mix' }, seed: 1 });
    expect(validate('contribution', c)).toEqual([]);
    const params = c.params as { genre: string; tracks: Record<string, { role: string; fader_db: number; pan: number }> };
    expect(params.genre).toBe('lofi');
    expect(params.tracks[ids.vox].role).toBe('vocal');
    expect(params.tracks[ids.bass].pan).toBe(0);
    expect(params.tracks[ids.keys].pan).toBe(-params.tracks[ids.pad].pan);
    expect(Math.max(...Object.values(params.tracks).map((t) => t.fader_db))).toBe(0);
  });
});
