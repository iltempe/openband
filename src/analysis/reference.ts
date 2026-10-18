// Reference matching: compare the mix with a commercial track after matching their loudness. Pure.
import { loudness } from './loudness';
import { FRAME, bandPowers, bandsDb, BANDS, mono, thirdOctaves, type BandId } from './spectrum';
import { powerSpectrum } from './fft';
import { stereo } from './stereo';

export interface MasterProfile {
  lufs_integrated: number;
  true_peak_dbtp: number;
  crest_db: number;
  lra: number;
  correlation: number;
  width: number;
  bands_db: Record<BandId, number>;
  third_octaves_db: number[];
  seconds: number;
}

export interface StemBands {
  id: string;
  name: string;
  bands_db: Record<BandId, number>;
}

export interface RefSuggestion {
  action: 'eq' | 'gain' | 'compress' | 'width';
  target: string;
  band?: BandId;
  gain_db?: number;
  reason: string;
}

export interface Comparison {
  loudness_diff_lu: number;
  true_peak_diff_db: number;
  crest_diff_db: number;
  width_diff: number;
  /** Mix minus reference, per band, after loudness matching (negative = the mix has less). */
  tonal_diff_db: Record<BandId, number>;
  /** Same on the 31 third-octave bands (for the overlay). */
  third_octave_diff_db: number[];
  suggestions: RefSuggestion[];
}

const FLOOR = -120;
const fin = (x: number) => (Number.isFinite(x) ? x : FLOOR);
const r1 = (x: number) => +fin(x).toFixed(1);
const r2 = (x: number) => +x.toFixed(2);
const half = (x: number) => Math.round(x * 2) / 2;

export const BAND_HZ: Record<BandId, string> = Object.fromEntries(BANDS.map((b) => [b.id, `${b.lo >= 1000 ? b.lo / 1000 + 'k' : b.lo}–${b.hi >= 1000 ? b.hi / 1000 + 'k' : b.hi} Hz`])) as Record<BandId, string>;

/**
 * Mean spectrum and RMS over the frames that actually play (gated like the loudness measure), so
 * silence before, between or after the music doesn't change the tonal balance.
 */
export function gatedSpectrum(x: Float32Array, n = FRAME) {
  const hop = n / 2;
  const energies: number[] = [];
  for (let off = 0; off + n <= Math.max(n, x.length); off += hop) {
    let e = 0;
    for (let i = off; i < Math.min(x.length, off + n); i++) e += x[i] * x[i];
    energies.push(e / n);
    if (off + n >= x.length) break;
  }
  // Like BS.1770: an absolute gate at -70 dBFS, then a relative one 10 dB under the mean of what's left.
  const loud = energies.filter((e) => e > 1e-7);
  const gate = Math.max(1e-7, (loud.reduce((a, b) => a + b, 0) / (loud.length || 1)) * 0.1);
  const spec = new Float64Array(n / 2 + 1);
  const frame = new Float64Array(n / 2 + 1);
  let used = 0;
  let ms = 0;
  energies.forEach((e, k) => {
    if (e < gate) return;
    powerSpectrum(x, k * hop, n, frame);
    for (let i = 0; i < spec.length; i++) spec[i] += frame[i];
    ms += e;
    used++;
  });
  for (let i = 0; i < spec.length; i++) spec[i] /= used || 1;
  return { spec, rmsDb: used ? 10 * Math.log10(ms / used) : -Infinity };
}

/** Loudness, dynamics, stereo image and tonal balance of a (stereo) signal. */
export function masterProfile(channels: Float32Array[], sampleRate: number): MasterProfile {
  const L = loudness(channels, sampleRate);
  const { spec, rmsDb } = gatedSpectrum(mono(channels));
  const st = channels.length > 1 ? stereo(channels[0], channels[1], sampleRate) : { correlation: 1, width: 0 };
  const bands = bandsDb(bandPowers(spec, sampleRate));
  return {
    lufs_integrated: r1(L.integrated),
    true_peak_dbtp: r1(L.truePeak),
    crest_db: r1(Number.isFinite(rmsDb) ? L.samplePeak - rmsDb : 0),
    lra: r1(L.lra),
    correlation: st.correlation,
    width: st.width,
    bands_db: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, r1(v)])) as Record<BandId, number>,
    third_octaves_db: thirdOctaves(spec, sampleRate).map(r1),
    seconds: +(channels[0].length / sampleRate).toFixed(2),
  };
}

/** Band energies relative to the integrated loudness: what's left is the tonal balance. */
export const normalizedBands = (p: MasterProfile) =>
  Object.fromEntries(BANDS.map((b) => [b.id, fin(p.bands_db[b.id]) - fin(p.lufs_integrated)])) as Record<BandId, number>;

/** Tonal and dynamic differences of the mix from the reference, with concrete suggestions. */
export function compareProfiles(mix: MasterProfile, ref: MasterProfile, stems: StemBands[] = [], lang: 'en' | 'it' = 'en'): Comparison {
  const it = lang === 'it';
  const nm = normalizedBands(mix);
  const nr = normalizedBands(ref);
  const tonal = Object.fromEntries(BANDS.map((b) => [b.id, r1(nm[b.id] - nr[b.id])])) as Record<BandId, number>;
  const third = mix.third_octaves_db.map((v, i) => r1(fin(v) - fin(mix.lufs_integrated) - (fin(ref.third_octaves_db[i]) - fin(ref.lufs_integrated))));
  const loud = r1(fin(mix.lufs_integrated) - fin(ref.lufs_integrated));
  const crest = r1(mix.crest_db - ref.crest_db);
  const width = r2(mix.width - ref.width);
  const s: RefSuggestion[] = [];

  if (Math.abs(loud) >= 1) {
    const g = half(Math.max(-12, Math.min(12, -loud)));
    s.push({
      action: 'gain',
      target: 'master',
      gain_db: g,
      reason: it
        ? `Il mix è ${Math.abs(loud)} LU ${loud < 0 ? 'più basso' : 'più forte'} della reference${loud < 0 && mix.true_peak_dbtp > -1 - g ? ' (alzandolo serve un limiter per non superare -1 dBTP)' : ''}`
        : `The mix is ${Math.abs(loud)} LU ${loud < 0 ? 'quieter' : 'louder'} than the reference${loud < 0 && mix.true_peak_dbtp > -1 - g ? ' (raising it needs a limiter to stay under -1 dBTP)' : ''}`,
    });
  }

  for (const b of BANDS) {
    const d = tonal[b.id];
    // Bands that are nearly empty in both (e.g. sub in an acoustic track) aren't worth chasing.
    if (Math.abs(d) < 1.5 || Math.max(nm[b.id], nr[b.id]) < -60) continue;
    if (d < 0) {
      s.push({
        action: 'eq',
        target: 'master',
        band: b.id,
        gain_db: half(Math.min(4, -d * 0.7)),
        reason: it ? `Il mix ha ${-d} dB in meno della reference a ${BAND_HZ[b.id]}` : `The mix has ${-d} dB less than the reference at ${BAND_HZ[b.id]}`,
      });
    } else {
      // Too much: cut it on the track that puts the most energy there.
      const top = [...stems].sort((x, y) => fin(y.bands_db[b.id]) - fin(x.bands_db[b.id]))[0];
      s.push({
        action: 'eq',
        target: top ? top.id : 'master',
        band: b.id,
        gain_db: -half(Math.min(6, d * 0.8)),
        reason: it
          ? `Accumulo a ${BAND_HZ[b.id]} (+${d} dB sulla reference)${top ? `: ${top.name} è la traccia più energica lì` : ''}`
          : `Build-up at ${BAND_HZ[b.id]} (+${d} dB over the reference)${top ? `: ${top.name} is the loudest track there` : ''}`,
      });
    }
  }

  if (crest >= 3)
    s.push({ action: 'compress', target: 'master', reason: it ? `Il mix è più dinamico della reference (crest +${crest} dB): comprimi o limita di più` : `The mix is more dynamic than the reference (crest +${crest} dB): compress or limit more` });
  else if (crest <= -3)
    s.push({ action: 'compress', target: 'master', reason: it ? `Il mix è più schiacciato della reference (crest ${crest} dB): meno compressione` : `The mix is more squashed than the reference (crest ${crest} dB): ease off the compression` });

  if (width <= -0.1)
    s.push({ action: 'width', target: 'master', reason: it ? 'Il mix è più stretto della reference: allarga il pan di pad, chitarre e cori' : 'The mix is narrower than the reference: pan pads, guitars and backing parts wider' });
  else if (width >= 0.1)
    s.push({ action: 'width', target: 'master', reason: it ? 'Il mix è più largo della reference: controlla la compatibilità mono' : 'The mix is wider than the reference: check mono compatibility' });

  return { loudness_diff_lu: loud, true_peak_diff_db: r1(mix.true_peak_dbtp - ref.true_peak_dbtp), crest_diff_db: crest, width_diff: width, tonal_diff_db: tonal, third_octave_diff_db: third, suggestions: s };
}

/** Linear gain that plays the reference at the mix's loudness. */
export const matchGain = (mixLufs: number, refLufs: number) => (Number.isFinite(mixLufs) && Number.isFinite(refLufs) && mixLufs > -100 && refLufs > -100 ? Math.pow(10, (mixLufs - refLufs) / 20) : 1);
