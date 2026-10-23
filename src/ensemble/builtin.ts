// OpenBand's own algorithms as OMEP engines (SPEC v0.6 §4): in-page, instant, deterministic, MIT. The
// router treats them like any other performer; they read only the Song Context Package.
import { BEATS_PER_BAR, keyInterval, parseChord } from '../music';
import { DRUM_STYLES, generateDrums, spansFor, type DrumStyle } from '../generate/drummer';
import { searchLoops, type LoopManifest } from '../loops';
import type { SectionKind } from '../types';
import type { Capability, Contribution, Manifest, OmepLicense, Scp, ScpNote, ToolInput } from './types';

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

export const BUILTINS: BuiltinEngine[] = [drummer, chords, loops];
