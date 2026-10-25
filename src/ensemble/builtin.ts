// OpenBand's own algorithms as OMEP engines (SPEC v0.6 §4): in-page, instant, deterministic, MIT. The
// router treats them like any other performer; they read only the Song Context Package.
import { BEATS_PER_BAR, keyInterval, parseChord } from '../music';
import { DRUM_STYLES, generateDrums, spansFor, type DrumStyle } from '../generate/drummer';
import { searchLoops, type LoopManifest } from '../loops';
import { MIX_ROLES, type MixRole, type SectionKind } from '../types';
import { GENRES, PROFILES } from '../pilot/plan';
import { PLATFORM_TARGETS } from '../audio/master';
import type { Capability, Contribution, Manifest, OmepLicense, Scp, ScpNote, ToolInput } from './types';
import type { Project } from '../types';
import { emptyProject, makeTrack } from '../store';
import { suggest } from '../suggest/engine';
import { ENTER, segment } from '../arranger/arrange';
import { ENERGY_SHAPES, shapeCurve, type EnergyShape } from '../arranger/energy';
import { demucsEngine } from '../separate/engine';
import { voiceEngine } from '../sing/engine';

export const OPENBAND_LICENSE: OmepLicense = { code: 'MIT', weights: null, commercial: 'yes', attribution: null, conditions: null, url: 'https://github.com/iltempe/openband/blob/main/LICENSE' };
const CC0: OmepLicense = { code: 'MIT', weights: 'CC0-1.0', commercial: 'yes', attribution: null, conditions: null, url: 'https://creativecommons.org/publicdomain/zero/1.0/' };

export interface BuiltinEngine {
  manifest: Manifest;
  run(capability: Capability, input: ToolInput): Promise<Contribution>;
}

const manifestOf = (id: string, name: string, capabilities: Manifest['capabilities'], license = OPENBAND_LICENSE, outputs = ['application/x-omep-notes']): Manifest => ({
  omep: '1.0',
  engine: { id, name, version: '1.0.0', homepage: 'https://github.com/iltempe/openband' },
  license,
  runtime: { where: 'builtin', device: ['cpu'], realtime: true },
  capabilities,
  outputs,
  languages: ['en', 'it'],
  determinism: 'seeded',
});

/** The scope in beats (from the song start), and its length in bars. */
export function scopeOf(scp: Scp) {
  const fromBar = scp.scope?.from_bar ?? 1;
  const toBar = scp.scope?.to_bar ?? fromBar + scp.song.length_bars;
  return { fromBar, toBar, bars: toBar - fromBar, from: (fromBar - 1) * BEATS_PER_BAR, to: (toBar - 1) * BEATS_PER_BAR };
}

const words = (input: ToolInput) => `${input.request?.text ?? ''} ${input.request?.style ?? ''} ${input.context.intent?.text ?? ''} ${(input.context.constraints?.soft?.style ?? []).join(' ')}`.toLowerCase();

// ---------------------------------------------------------------- drummer (F24) as symbolic.drums
const drummer: BuiltinEngine = {
  manifest: manifestOf('openband-drummer', 'OpenBand Drummer', { 'symbolic.drums': { conditioning: ['bpm', 'meter', 'sections', 'energy', 'text'] } }),
  async run(_cap, input) {
    const scp = input.context;
    const s = scopeOf(scp);
    const w = words(input);
    const style: DrumStyle = (DRUM_STYLES.find((x) => w.includes(x)) ?? (/\blofi|lo fi\b/.test(w) ? 'lo-fi' : /hip.?hop|boom/.test(w) ? 'boom-bap' : 'pop')) as DrumStyle;
    const energy = input.request?.complexity ?? scp.intent?.energy ?? 0.5;
    const sections = (scp.sections ?? []).map((x) => ({ start: (x.from_bar - 1) * BEATS_PER_BAR, length: x.bars * BEATS_PER_BAR, kind: x.kind as SectionKind }));
    const notes: ScpNote[] = generateDrums(spansFor(sections, s.from, s.to), {
      style,
      complexity: Math.max(0, Math.min(1, energy)),
      loudness: 0.7,
      swing: style === 'shuffle' || style === 'boom-bap' || style === 'lo-fi' ? 0.5 : 0,
      fills: 'end_of_section',
      seed: input.seed ?? 1,
    })
      .filter((n) => n.start >= s.from - 0.05 && n.start < s.to)
      .map((n) => ({ pitch: n.pitch, start: +Math.max(0, n.start - s.from).toFixed(4), duration: n.duration, velocity: n.velocity }));
    return { kind: 'notes', notes, claims: { bpm: scp.song.bpm, length_bars: s.bars, meter: scp.song.meter }, provenance: { engine: 'openband-drummer', engine_version: '1.0.0', model_hash: 'none', seed: input.seed ?? 1, capability: 'symbolic.drums', prompt: style }, license: OPENBAND_LICENSE };
  },
};

// ---------------------------------------------------------------- chords as symbolic.accompany
/** A plain progression in the key when the song has no harmony yet: I–V–vi–IV, or i–VI–III–VII. */
function defaultProgression(key: string): string[] {
  const minor = /m$/.test(key);
  const tonic = key.replace(/m$/, '');
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const at = (semis: number, q: string) => names[(keyInterval('C', tonic) + semis + 120) % 12] + q;
  return minor ? [at(0, 'm'), at(8, ''), at(3, ''), at(10, '')] : [at(0, ''), at(7, ''), at(9, 'm'), at(5, '')];
}

const chords: BuiltinEngine = {
  manifest: manifestOf('openband-chords', 'OpenBand Chords', { 'symbolic.accompany': { conditioning: ['key', 'chords', 'text', 'range'] } }),
  async run(_cap, input) {
    const scp = input.context;
    const s = scopeOf(scp);
    const w = words(input);
    const style = /arpegg|arpeg|broken|plucked|picking/.test(w) ? 'arpeggio' : /stab|stabs|staccato|funky/.test(w) ? 'stabs' : 'block';
    const octave = /\b(low|bass|grave|basso)\b/.test(w) ? 2 : /\b(high|bright|acut|alto)\b/.test(w) ? 4 : 3;
    // The chord sounding at each bar of the scope.
    const harmony = [...(scp.harmony ?? [])].sort((a, b) => a.bar + (a.beat ?? 0) / 4 - (b.bar + (b.beat ?? 0) / 4));
    const fallback = defaultProgression(scp.song.key);
    const chordAt = (bar: number) => {
      let c: string | null = null;
      for (const h of harmony) if (h.bar <= bar) c = h.chord;
      return c ?? fallback[(bar - s.fromBar) % fallback.length];
    };
    const notes: ScpNote[] = [];
    for (let b = 0; b < s.bars; b++) {
      const at = b * BEATS_PER_BAR;
      let pitches: number[];
      try {
        pitches = parseChord(chordAt(s.fromBar + b), octave);
      } catch {
        continue;
      }
      if (style === 'arpeggio') {
        const seq = [...pitches, pitches[0] + 12];
        for (let i = 0; i < BEATS_PER_BAR * 2; i++) notes.push({ pitch: seq[i % seq.length], start: at + i * 0.5, duration: 0.5, velocity: i === 0 ? 0.75 : 0.6 });
      } else if (style === 'stabs') {
        for (let i = 0; i < BEATS_PER_BAR; i++) for (const pitch of pitches) notes.push({ pitch, start: at + i + 0.5, duration: 0.35, velocity: 0.7 });
      } else for (const pitch of pitches) notes.push({ pitch, start: at, duration: BEATS_PER_BAR, velocity: 0.65 });
    }
    return { kind: 'notes', notes, claims: { key: scp.song.key, length_bars: s.bars }, provenance: { engine: 'openband-chords', engine_version: '1.0.0', model_hash: 'none', seed: input.seed ?? 1, capability: 'symbolic.accompany', prompt: style }, license: OPENBAND_LICENSE };
  },
};

// ---------------------------------------------------------------- CC0 loop library (F24) as music.add_layer
let manifestLoader: () => Promise<LoopManifest> = async () => (await import('../loopsLive')).loadManifest();
/** For tests: where the loop manifest comes from, and how a loop's relative URL becomes absolute. */
export const setLoopSource = (load: () => Promise<LoopManifest>, base?: string) => {
  manifestLoader = load;
  if (base) loopBase = base;
};
let loopBase = typeof location !== 'undefined' ? location.href : 'https://iltempe.github.io/openband/';

const loops: BuiltinEngine = {
  manifest: manifestOf('openband-loops', 'OpenBand CC0 loops', { 'music.add_layer': { conditioning: ['bpm', 'key', 'text'], roles: ['drums', 'bass', 'harmony', 'texture', 'lead'] } }, CC0, ['audio/wav']),
  async run(_cap, input) {
    const scp = input.context;
    const s = scopeOf(scp);
    const role = input.request?.role ?? scp.intent?.role;
    const query = `${input.request?.text ?? scp.intent?.text ?? ''} ${role ?? ''}`.trim();
    const found = searchLoops(await manifestLoader(), { query, bpm: scp.song.bpm, key: scp.song.key, limit: 8 });
    if (!found.length) throw new Error('No loop in the library fits this request');
    // Same seed, same pick among the close matches.
    const pick = found[(input.seed ?? 1) % Math.min(3, found.length)];
    // Manifest URLs are relative to the site ("loops/…"), as the loop library uses them.
    const uri = pick.url.startsWith('https://') ? pick.url : new URL(pick.url, loopBase).href;
    return {
      kind: 'audio',
      files: [{ uri, role: 'layer', format: 'wav' }],
      claims: { bpm: pick.bpm, ...(pick.key ? { key: pick.key } : {}), length_bars: pick.bars },
      provenance: { engine: 'openband-loops', engine_version: '1.0.0', model_hash: 'none', seed: input.seed ?? 1, capability: 'music.add_layer', prompt: `${pick.id} (${pick.name}, by ${pick.author}, CC0)` },
      license: CC0,
      alignment: { start_bar: s.fromBar },
    };
  },
};

// ---------------------------------------------------------------- the mix pilot (G1) as mix.assist
/**
 * From the context alone (track roles, the genre in the request): the static part of the pilot — fader
 * offsets, pan and sends by role, the master's target. Inside OpenBand, mix_pilot also listens to the
 * song (trims, EQ cuts, sidechain) and applies the result; this is what an outside director gets.
 */
const pilot: BuiltinEngine = {
  manifest: manifestOf('openband-pilot', 'OpenBand Mix Pilot', { 'mix.assist': { conditioning: ['text', 'stems'] } }, OPENBAND_LICENSE, ['application/x-omep-params']),
  async run(_cap, input) {
    const w = words(input);
    const genre = GENRES.find((g) => w.includes(g)) ?? (/hip.?hop|rap|trap/.test(w) ? 'hiphop' : /lo.?fi/.test(w) ? 'lofi' : /dance|house|techno/.test(w) ? 'edm' : /folk|songwriter|cantautor/.test(w) ? 'acoustic' : 'pop');
    const profile = PROFILES[genre];
    const tracks = (input.context.tracks ?? []).map((t) => (MIX_ROLES.includes(t.role as MixRole) ? { ...t, role: t.role as MixRole } : { ...t, role: 'harmony' as MixRole }));
    const top = Math.max(...tracks.map((t) => profile.balance[t.role]), -99);
    const spread = tracks.filter((t) => t.role === 'harmony' || t.role === 'texture');
    const params = {
      genre,
      platform: profile.platform,
      target: PLATFORM_TARGETS[profile.platform],
      tracks: Object.fromEntries(
        tracks.map((t) => {
          const i = spread.indexOf(t);
          const pan = i < 0 || (i === spread.length - 1 && spread.length % 2) ? 0 : (i % 2 ? 1 : -1) * profile.panWidth;
          return [t.id, { role: t.role, fader_db: +(profile.balance[t.role] - top).toFixed(1), pan, reverb: profile.reverb[t.role], delay: profile.delay[t.role] }];
        }),
      ),
      master: { tilt_db_per_octave: profile.tilt, width: profile.width, mono_below_hz: 120 },
    };
    return { kind: 'params', params, claims: {}, provenance: { engine: 'openband-pilot', engine_version: '1.0.0', model_hash: 'none', seed: input.seed ?? 1, capability: 'mix.assist', prompt: genre }, license: OPENBAND_LICENSE };
  },
};

// ---------------------------------------------------------------- ghost notes (G3) as symbolic.continue / harmonize
/** The SCP as a tiny song: its chords on a keys track, its melody on a lead track (from scope.from_bar). */
function songOf(scp: Scp): Project {
  const s = scopeOf(scp);
  const p = emptyProject();
  p.key = scp.song.key;
  p.bpm = scp.song.bpm;
  const keys = makeTrack(p, 'instrument', 'felt-piano', 'Chords');
  const lead = makeTrack(p, 'instrument', 'neon-lead', 'Melody');
  p.tracks = [keys, lead];
  const harmony = [...(scp.harmony ?? [])].sort((a, b) => a.bar + (a.beat ?? 0) / 4 - (b.bar + (b.beat ?? 0) / 4));
  const chordNotes = harmony.flatMap((h, i) => {
    const at = (h.bar - 1) * BEATS_PER_BAR + (h.beat ? h.beat - 1 : 0);
    const next = harmony[i + 1];
    const end = next ? (next.bar - 1) * BEATS_PER_BAR + (next.beat ? next.beat - 1 : 0) : at + (h.beats ?? BEATS_PER_BAR);
    try {
      return parseChord(h.chord, 4).map((pitch, k) => ({ id: `c${i}_${k}`, pitch, start: at, duration: Math.max(0.5, end - at), velocity: 0.6 }));
    } catch {
      return [];
    }
  });
  const melody = scp.melody?.notes ?? [];
  p.regions = [
    { id: 'chords', trackId: keys.id, name: 'Chords', start: 0, length: Math.max(BEATS_PER_BAR, ...chordNotes.map((n) => n.start + n.duration)), notes: chordNotes },
    { id: 'melody', trackId: lead.id, name: 'Melody', start: s.from, length: Math.max(BEATS_PER_BAR, s.to - s.from), notes: melody.map((n, i) => ({ id: `m${i}`, pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity ?? 0.8 })) },
  ];
  return p;
}

const ghost: BuiltinEngine = {
  manifest: manifestOf('openband-ghost', 'OpenBand Ghost notes', { 'symbolic.continue': { conditioning: ['key', 'chords', 'melody'] }, 'symbolic.harmonize': { conditioning: ['key', 'melody'] } }),
  async run(cap, input) {
    const scp = input.context;
    const kind = cap === 'symbolic.harmonize' ? 'harmonize' : 'continue';
    const best = suggest(songOf(scp), 'melody', { kind, seed: input.seed ?? 1, count: 1 }).suggestions[0];
    return {
      kind: 'notes',
      notes: (best?.notes ?? []).map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity })),
      claims: { key: scp.song.key, length_bars: scopeOf(scp).bars },
      provenance: { engine: 'openband-ghost', engine_version: '1.0.0', model_hash: 'none', seed: input.seed ?? 1, capability: cap, prompt: best ? best.reasons.join('; ') + (best.chords ? ` (${best.chords.join(' ')})` : '') : 'nothing to continue' },
      license: OPENBAND_LICENSE,
    };
  },
};

// ---------------------------------------------------------------- draw the song (G2) as music.arrange
/**
 * The plan for an energy curve (request.shape and request.length_bars, or request.points): sections,
 * which tracks (by role) play in each, and the transitions. Inside OpenBand arrange_from_energy applies it
 * to the song's own material; an outside director gets the plan.
 */
const arranger: BuiltinEngine = {
  manifest: manifestOf('openband-arranger', 'OpenBand Arranger', { 'music.arrange': { conditioning: ['sections', 'energy', 'text'] } }, OPENBAND_LICENSE, ['application/x-omep-params']),
  async run(_cap, input) {
    const r = input.request ?? {};
    const shape = (ENERGY_SHAPES as readonly string[]).includes(String(r.shape)) ? (r.shape as EnergyShape) : 'pop';
    const length = Number(r.length_bars) || Math.max(32, input.context.song.length_bars);
    const curve = Array.isArray(r.points) ? { points: r.points as { bar: number; energy: number }[], length_bars: length } : shapeCurve(shape, length);
    const segs = segment(curve);
    const tracks = (input.context.tracks ?? []).map((t) => ({ ...t, role: (MIX_ROLES.includes(t.role as MixRole) ? t.role : 'harmony') as MixRole }));
    const sections = segs.map((s) => ({ kind: s.kind, from_bar: s.start + 1, bars: s.bars, energy: +s.energy.toFixed(2), tracks: tracks.filter((t) => s.energy + 1e-6 >= ENTER[t.role]).map((t) => t.id) }));
    return { kind: 'params', params: { length_bars: curve.length_bars, shape: 'shape' in curve ? curve.shape : null, sections }, claims: { length_bars: curve.length_bars }, provenance: { engine: 'openband-arranger', engine_version: '1.0.0', model_hash: 'none', seed: input.seed ?? 1, capability: 'music.arrange', prompt: shape }, license: OPENBAND_LICENSE };
  },
};

export const BUILTINS: BuiltinEngine[] = [drummer, chords, loops, pilot, ghost, arranger, demucsEngine, voiceEngine];
