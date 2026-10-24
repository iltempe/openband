// Export for platforms (G1): one zip with a master per platform at its loudness and true peak (24-bit
// WAV; 16-bit with TPDF dither for CD), the instrumental and a-cappella versions and stems by role —
// all through the same master chain with the limiter and the glue linked to the full mix, so the stems
// add back up to the master — and report.txt.
import { strToU8, zipSync } from 'fflate';
import type { MasterChain, Project } from '../types';
import { defaultMaster, PLATFORM_TARGETS, type Platform } from '../audio/master';
import { encodePcm, renderBuffer } from '../audio/render';
import { fitLimiter } from '../audio/fitLimiter';
import { loudness, truePeak } from '../analysis/loudness';
import { noteFacts, roleOf } from './roles';

export type StemGroup = 'drums' | 'bass' | 'harmony' | 'lead' | 'vocal' | 'fx';

export interface PlatformExportArgs {
  platforms: string[];
  stems?: boolean;
  versions?: ('instrumental' | 'acapella')[];
}

export interface PlatformReport {
  platform: Platform;
  file: string;
  lufs: number;
  true_peak_dbtp: number;
  lra: number;
  target_lufs: number;
  ceiling_dbtp: number;
  compliant: boolean;
}

const groupOf = (r: ReturnType<typeof roleOf>): StemGroup => (r === 'kick' ? 'drums' : r === 'texture' ? 'harmony' : r);

/** The tracks heard in the song (mute/solo respected) by stem group. */
export function stemGroups(p: Project): Partial<Record<StemGroup, string[]>> {
  const anySolo = p.tracks.some((t) => t.solo);
  const out: Partial<Record<StemGroup, string[]>> = {};
  for (const t of p.tracks.filter((x) => !x.mute && (!anySolo || x.solo))) (out[groupOf(roleOf(t, noteFacts(p, t.id)))] ??= []).push(t.id);
  return out;
}

const chans = (b: AudioBuffer) => [b.getChannelData(0), b.getChannelData(Math.min(1, b.numberOfChannels - 1))];
const r1 = (x: number) => Math.round(x * 10) / 10;

/** The song's chain set to a platform (limiter on at its target; the input gain still to be found). */
export function chainFor(p: Project, platform: Platform): MasterChain {
  const base = p.master ?? defaultMaster();
  const t = PLATFORM_TARGETS[platform];
  return { ...structuredClone(base), on: true, limiter: { ...base.limiter, on: true, targetLufs: t.lufs, ceilingDbtp: t.ceiling } };
}

export async function exportForPlatforms(p: Project, a: PlatformExportArgs, progress: (step: string) => void = () => {}) {
  const platforms = [...new Set(a.platforms.length ? a.platforms : ['spotify'])] as Platform[];
  for (const x of platforms) if (!PLATFORM_TARGETS[x]) throw new Error(`Unknown platform "${x}". Platforms: ${Object.keys(PLATFORM_TARGETS).join(', ')}`);
  const name = p.name.replace(/[^\w\- ]+/g, '').trim() || 'openband';
  const files: Record<string, Uint8Array> = {};
  const reports: PlatformReport[] = [];
  let first: { chain: MasterChain; sr: number; master: Float32Array[] } | null = null;
  const notes: string[] = [];

  for (const platform of platforms) {
    progress(platform);
    const chain = chainFor(p, platform);
    const fit = await fitLimiter(p, chain);
    chain.limiter.inputGainDb = fit.inputGainDb;
    const cd = platform === 'cd';
    const sr = cd ? 44100 : 48000;
    const buf = await renderBuffer({ ...p, master: chain }, { sampleRate: sr });
    const c = chans(buf);
    const l = loudness(c, sr);
    const tp = 20 * Math.log10(Math.max(truePeak(c[0]), truePeak(c[1]), 1e-9));
    const file = `${name} - ${platform}${cd ? ' (16-bit)' : ''}.wav`;
    files[file] = encodePcm(c, sr, cd ? 16 : 24, cd);
    const t = PLATFORM_TARGETS[platform];
    reports.push({ platform, file, lufs: r1(l.integrated), true_peak_dbtp: r1(tp), lra: r1(l.lra), target_lufs: t.lufs, ceiling_dbtp: t.ceiling, compliant: Math.abs(l.integrated - t.lufs) <= 1 && tp <= t.ceiling + 0.05 });
    if (!fit.reached) notes.push(`${platform}: ${r1(l.integrated)} LUFS — the target ${t.lufs} LUFS is out of reach without crushing the music; the master stops at the ceiling instead.`);
    first ??= { chain, sr, master: c };
  }

  // Versions and stems through the first platform's chain, linked to the full mix.
  const groups = stemGroups(p);
  const vocal = groups.vocal ?? [];
  const all = Object.values(groups).flat() as string[];
  const linked = async (ids: string[]) => chans(await renderBuffer({ ...p, master: first!.chain }, { sampleRate: first!.sr, linked: ids }));
  for (const v of a.versions ?? []) {
    const ids = v === 'instrumental' ? all.filter((id) => !vocal.includes(id)) : vocal;
    if (!ids.length || ids.length === all.length) {
      notes.push(v === 'instrumental' ? 'No instrumental: nothing in the song plays the vocal role (set_track_role).' : 'No a-cappella version: no track plays the vocal role (set_track_role).');
      continue;
    }
    progress(v);
    files[`${name} - ${v}.wav`] = encodePcm(await linked(ids), first!.sr, 24);
  }
  let residualDb: number | null = null;
  if (a.stems) {
    const sum = [new Float32Array(first!.master[0].length), new Float32Array(first!.master[0].length)];
    for (const [g, ids] of Object.entries(groups) as [StemGroup, string[]][]) {
      progress(`stem ${g}`);
      const c = await linked(ids);
      files[`stems/${name} - ${g}.wav`] = encodePcm(c, first!.sr, 24);
      for (let k = 0; k < 2; k++) for (let i = 0; i < sum[k].length && i < c[k].length; i++) sum[k][i] += c[k][i];
    }
    residualDb = residual(first!.master, sum);
  }

  const lines = [
    `${p.name} — export for platforms (OpenBand)`,
    '',
    ...reports.map((r) => `${r.platform.padEnd(10)} ${String(r.lufs).padStart(6)} LUFS  ${String(r.true_peak_dbtp).padStart(5)} dBTP  LRA ${String(r.lra).padStart(4)} LU   target ${r.target_lufs} LUFS / ${r.ceiling_dbtp} dBTP   ${r.compliant ? 'OK' : 'NOT COMPLIANT'}   ${r.file}`),
    '',
    ...(residualDb !== null ? [`Stems (${Object.keys(groups).join(', ')}) through the ${platforms[0]} master chain, limiter linked: their sum differs from the master by ${residualDb.toFixed(1)} dB (residual).`] : []),
    ...(a.versions?.length ? [`Versions (${a.versions.join(', ')}) through the ${platforms[0]} master chain, limiter linked.`] : []),
    ...notes,
    `Masters: 24-bit WAV at 48 kHz${platforms.includes('cd') ? '; CD: 16-bit at 44.1 kHz with TPDF dither' : ''}.`,
  ];
  files['report.txt'] = strToU8(lines.join('\n') + '\n');
  // WAVs don't compress: store them.
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: k.endsWith('.txt') ? 6 : 0 }]])));
  return { zip, filename: `${name} - for platforms.zip`, reports, stems: a.stems ? Object.keys(groups) : [], stem_residual_db: residualDb, notes };
}

/** Level of (a − b) relative to a, in dB (−∞ when identical). */
export function residual(a: Float32Array[], b: Float32Array[]) {
  let ea = 0;
  let ed = 0;
  for (let k = 0; k < a.length; k++)
    for (let i = 0; i < a[k].length; i++) {
      ea += a[k][i] * a[k][i];
      const d = a[k][i] - (b[k]?.[i] ?? 0);
      ed += d * d;
    }
  return ed === 0 ? -Infinity : 10 * Math.log10(ed / Math.max(ea, 1e-20));
}
