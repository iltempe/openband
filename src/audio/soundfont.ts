// Minimal SoundFont 2 (.sf2) reader: lists presets and turns one preset into sampler zones.
// Supports key ranges, root key/tuning, loop points, attenuation and the volume envelope;
// modulators, filters and LFOs are ignored. Stereo pairs are reduced to their left channel.

export interface SfPresetInfo {
  index: number;
  name: string;
  bank: number;
  program: number;
}

export interface SfZone {
  sampleIndex: number;
  lo: number;
  hi: number;
  root: number;
  /** cents */
  tune: number;
  /** In frames relative to the sample start; undefined when the zone doesn't loop. */
  loopStart?: number;
  loopEnd?: number;
  gain: number;
  attack: number;
  release: number;
}

export interface SfSample {
  name: string;
  pcm: Float32Array;
  sampleRate: number;
}

interface Gen {
  [oper: number]: number;
}
interface Bag {
  gens: Gen;
}

// Generator operators we read.
const G = {
  startAddrsOffset: 0,
  endAddrsOffset: 1,
  startloopAddrsOffset: 2,
  endloopAddrsOffset: 3,
  startAddrsCoarse: 4,
  endAddrsCoarse: 12,
  attackVolEnv: 34,
  releaseVolEnv: 38,
  instrument: 41,
  keyRange: 43,
  velRange: 44,
  startloopAddrsCoarse: 45,
  initialAttenuation: 48,
  endloopAddrsCoarse: 50,
  coarseTune: 51,
  fineTune: 52,
  sampleID: 53,
  sampleModes: 54,
  overridingRootKey: 58,
} as const;
const RANGE_GENS = new Set<number>([G.keyRange, G.velRange]);

interface ShdrEntry {
  name: string;
  start: number;
  end: number;
  startLoop: number;
  endLoop: number;
  sampleRate: number;
  originalPitch: number;
  pitchCorrection: number;
  sampleType: number;
}

export class SoundFont {
  readonly presets: SfPresetInfo[] = [];
  private presetZones: Bag[][] = [];
  private instZones: Bag[][] = [];
  private shdr: ShdrEntry[] = [];
  private smpl!: Int16Array;

  constructor(data: ArrayBuffer) {
    const v = new DataView(data);
    const id = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    if (id(0) !== 'RIFF' || id(8) !== 'sfbk') throw new Error('Not a SoundFont 2 file (.sf2)');
    const chunks = new Map<string, { off: number; len: number }>();
    const walk = (start: number, end: number) => {
      let o = start;
      while (o + 8 <= end) {
        const cid = id(o);
        const len = v.getUint32(o + 4, true);
        if (cid === 'LIST') walk(o + 12, o + 8 + len);
        else chunks.set(cid, { off: o + 8, len });
        o += 8 + len + (len & 1);
      }
    };
    walk(12, v.byteLength);
    const need = (c: string) => {
      const ch = chunks.get(c);
      if (!ch) throw new Error(`Damaged SoundFont: missing "${c}" chunk`);
      return ch;
    };
    const str = (o: number, n: number) => {
      let s = '';
      for (let i = 0; i < n; i++) {
        const c = v.getUint8(o + i);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    };

    const smpl = need('smpl');
    this.smpl = new Int16Array(data.slice(smpl.off, smpl.off + (smpl.len & ~1)));

    const readGens = (c: string) => {
      const ch = need(c);
      const out: [number, number][] = [];
      for (let o = ch.off; o + 4 <= ch.off + ch.len; o += 4) {
        const oper = v.getUint16(o, true);
        // Ranges pack lo/hi bytes; store as lo | hi << 8. Everything else is a signed 16-bit amount.
        out.push([oper, RANGE_GENS.has(oper) ? v.getUint8(o + 2) | (v.getUint8(o + 3) << 8) : v.getInt16(o + 2, true)]);
      }
      return out;
    };
    const readBags = (c: string) => {
      const ch = need(c);
      const out: number[] = [];
      for (let o = ch.off; o + 4 <= ch.off + ch.len; o += 4) out.push(v.getUint16(o, true));
      return out;
    };
    const zonesFor = (bagStart: number, bagEnd: number, bags: number[], gens: [number, number][]) => {
      const zones: Bag[] = [];
      for (let b = bagStart; b < bagEnd; b++) {
        const g: Gen = {};
        for (let i = bags[b]; i < bags[b + 1] && i < gens.length; i++) g[gens[i][0]] = gens[i][1];
        zones.push({ gens: g });
      }
      return zones;
    };

    const pgen = readGens('pgen');
    const pbag = readBags('pbag');
    const igen = readGens('igen');
    const ibag = readBags('ibag');

    const phdr = need('phdr');
    const nPresets = Math.floor(phdr.len / 38) - 1; // last record is the terminal "EOP"
    for (let i = 0; i < nPresets; i++) {
      const o = phdr.off + i * 38;
      const bag = v.getUint16(o + 24, true);
      const nextBag = v.getUint16(o + 38 + 24, true);
      this.presets.push({ index: i, name: str(o, 20), program: v.getUint16(o + 20, true), bank: v.getUint16(o + 22, true) });
      this.presetZones.push(zonesFor(bag, nextBag, pbag, pgen));
    }
    this.presets.sort((a, b) => a.bank - b.bank || a.program - b.program);

    const inst = need('inst');
    const nInst = Math.floor(inst.len / 22) - 1;
    for (let i = 0; i < nInst; i++) {
      const o = inst.off + i * 22;
      this.instZones.push(zonesFor(v.getUint16(o + 20, true), v.getUint16(o + 22 + 20, true), ibag, igen));
    }

    const sh = need('shdr');
    const nSamples = Math.floor(sh.len / 46) - 1;
    for (let i = 0; i < nSamples; i++) {
      const o = sh.off + i * 46;
      this.shdr.push({
        name: str(o, 20),
        start: v.getUint32(o + 20, true),
        end: v.getUint32(o + 24, true),
        startLoop: v.getUint32(o + 28, true),
        endLoop: v.getUint32(o + 32, true),
        sampleRate: v.getUint32(o + 36, true),
        originalPitch: v.getUint8(o + 40),
        pitchCorrection: v.getInt8(o + 41),
        sampleType: v.getUint16(o + 44, true),
      });
    }
  }

  /** Percussion presets live in bank 128 by convention. */
  isDrumPreset(p: SfPresetInfo) {
    return p.bank === 128;
  }

  /** Zones of a preset plus the samples they use (sample indexes refer to the returned array). */
  buildPreset(presetIndex: number): { zones: SfZone[]; samples: SfSample[] } {
    const pz = this.presetZones[presetIndex];
    if (!pz) throw new Error(`Preset ${presetIndex} not found`);
    const [pGlobal, pLocal] = splitGlobal(pz, G.instrument);
    const zones: SfZone[] = [];
    const used = new Map<string, number>();
    const samples: SfSample[] = [];

    for (const p of pLocal) {
      const pg = { ...pGlobal, ...p.gens };
      const instZones = this.instZones[pg[G.instrument]];
      if (!instZones) continue;
      const [iGlobal, iLocal] = splitGlobal(instZones, G.sampleID);
      const hasLeft = iLocal.some((z) => this.shdr[z.gens[G.sampleID]]?.sampleType === 4);

      for (const z of iLocal) {
        const g = { ...iGlobal, ...z.gens };
        const sh = this.shdr[g[G.sampleID]];
        if (!sh || sh.sampleType & 0x8000) continue; // ROM samples aren't stored in the file
        if (hasLeft && sh.sampleType === 2) continue; // keep only the left side of stereo pairs
        if (!inRange(g[G.velRange], 100) || !inRange(pg[G.velRange], 100)) continue;
        const [klo, khi] = intersect(range(g[G.keyRange]), range(pg[G.keyRange]));
        if (klo > khi) continue;

        const add = (oper: number) => (g[oper] ?? 0) + (pg[oper] ?? 0);
        const start = sh.start + (g[G.startAddrsOffset] ?? 0) + (g[G.startAddrsCoarse] ?? 0) * 32768;
        const end = sh.end + (g[G.endAddrsOffset] ?? 0) + (g[G.endAddrsCoarse] ?? 0) * 32768;
        if (end <= start || end > this.smpl.length) continue;
        const loops = ((g[G.sampleModes] ?? 0) & 1) === 1;
        const loopStart = sh.startLoop + (g[G.startloopAddrsOffset] ?? 0) + (g[G.startloopAddrsCoarse] ?? 0) * 32768 - start;
        const loopEnd = sh.endLoop + (g[G.endloopAddrsOffset] ?? 0) + (g[G.endloopAddrsCoarse] ?? 0) * 32768 - start;

        const key = `${start}:${end}`;
        let si = used.get(key);
        if (si === undefined) {
          si = samples.length;
          used.set(key, si);
          const pcm = new Float32Array(end - start);
          for (let i = 0; i < pcm.length; i++) pcm[i] = this.smpl[start + i] / 32768;
          samples.push({ name: sh.name, pcm, sampleRate: sh.sampleRate });
        }
        const rootKey = g[G.overridingRootKey] ?? -1;
        zones.push({
          sampleIndex: si,
          lo: klo,
          hi: khi,
          root: rootKey >= 0 && rootKey <= 127 ? rootKey : sh.originalPitch > 127 ? 60 : sh.originalPitch,
          tune: add(G.coarseTune) * 100 + add(G.fineTune) + sh.pitchCorrection,
          ...(loops && loopEnd - loopStart > 8 && loopEnd <= end - start ? { loopStart, loopEnd } : {}),
          // EMU-style attenuation: centibels scaled by 0.4, as most players do.
          gain: Math.pow(10, (-add(G.initialAttenuation) * 0.4) / 200),
          attack: timecents(g[G.attackVolEnv], pg[G.attackVolEnv], 0.002),
          release: timecents(g[G.releaseVolEnv], pg[G.releaseVolEnv], 0.06),
        });
      }
    }
    return { zones, samples };
  }
}

function splitGlobal(zones: Bag[], terminal: number): [Gen, Bag[]] {
  if (zones.length && zones[0].gens[terminal] === undefined) return [zones[0].gens, zones.slice(1)];
  return [{}, zones];
}
const range = (packed?: number): [number, number] => (packed === undefined ? [0, 127] : [packed & 0xff, packed >> 8]);
const intersect = (a: [number, number], b: [number, number]): [number, number] => [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
const inRange = (packed: number | undefined, x: number) => {
  const [lo, hi] = range(packed);
  return x >= lo && x <= hi;
};
/** Instrument timecents plus preset offset → seconds. */
function timecents(inst: number | undefined, preset: number | undefined, fallback: number) {
  if (inst === undefined && preset === undefined) return fallback;
  const tc = (inst ?? -12000) + (preset ?? 0);
  return Math.min(8, Math.max(0.001, Math.pow(2, tc / 1200)));
}
