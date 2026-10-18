// Stereo image: correlation, width (side/mid) overall and per band, mono compatibility.
import { averageSpectrum, bandPowers, BANDS, type BandId } from './spectrum';

export interface StereoStats {
  /** −1 (anti-phase) … +1 (mono). */
  correlation: number;
  /** Side/mid energy ratio: 0 = mono, 1 = as much side as mid. */
  width: number;
  widthByBand: Record<BandId, number>;
  /** Level lost when summing to mono, dB (0 for mono material, ~3 for uncorrelated). */
  monoLossDb: number;
}

export function stereo(left: Float32Array, right: Float32Array, sampleRate: number): StereoStats {
  let lr = 0, ll = 0, rr = 0, mm = 0, ss = 0;
  const mid = new Float32Array(left.length);
  const side = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) {
    const l = left[i];
    const r = right[i];
    lr += l * r;
    ll += l * l;
    rr += r * r;
    mid[i] = (l + r) / 2;
    side[i] = (l - r) / 2;
    mm += mid[i] * mid[i];
    ss += side[i] * side[i];
  }
  const correlation = ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1;
  const mb = bandPowers(averageSpectrum(mid), sampleRate);
  const sb = bandPowers(averageSpectrum(side), sampleRate);
  const widthByBand = Object.fromEntries(BANDS.map((b) => [b.id, mb[b.id] > 0 ? +(sb[b.id] / mb[b.id]).toFixed(3) : 0])) as Record<BandId, number>;
  const stereoPower = (ll + rr) / 2;
  return {
    correlation: +correlation.toFixed(3),
    width: mm > 0 ? +(ss / mm).toFixed(3) : 0,
    widthByBand,
    monoLossDb: mm > 0 ? +(10 * Math.log10(stereoPower / mm)).toFixed(2) : stereoPower > 0 ? 99 : 0,
  };
}
