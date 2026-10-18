// Spectrogram image data (pure): log-frequency STFT columns mapped to a perceptual colormap.
import { powerSpectrum } from './fft';

// Magma-like colormap stops (dark → bright).
const STOPS: [number, number, number][] = [
  [4, 4, 16], [40, 17, 89], [101, 26, 128], [161, 48, 126], [222, 73, 104], [251, 135, 97], [254, 201, 141], [252, 253, 191],
];
function color(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export const SPEC_FMIN = 30;
export const SPEC_FMAX = 16000;

/** RGBA pixels (width × height) of the spectrogram of x; frequency is logarithmic, low at the bottom. */
export function spectrogramPixels(x: Float32Array, sampleRate: number, width: number, height: number, floorDb = -100, topDb = -10): Uint8ClampedArray {
  const N = 4096;
  const px = new Uint8ClampedArray(width * height * 4);
  const spec = new Float64Array(N / 2 + 1);
  const hop = x.length / width;
  const logMin = Math.log(SPEC_FMIN);
  const logMax = Math.log(SPEC_FMAX);
  // Bin range for each pixel row.
  const rows = Array.from({ length: height }, (_, y) => {
    const f0 = Math.exp(logMin + ((height - 1 - y) / height) * (logMax - logMin));
    const f1 = Math.exp(logMin + ((height - y) / height) * (logMax - logMin));
    const k0 = Math.max(1, Math.floor((f0 * N) / sampleRate));
    const k1 = Math.max(k0 + 1, Math.ceil((f1 * N) / sampleRate));
    return [k0, Math.min(N / 2, k1)];
  });
  for (let col = 0; col < width; col++) {
    powerSpectrum(x, Math.floor(col * hop - N / 2 + hop / 2), N, spec);
    for (let y = 0; y < height; y++) {
      const [k0, k1] = rows[y];
      let p = 0;
      for (let k = k0; k < k1; k++) p = Math.max(p, spec[k]);
      const dB = p > 0 ? 10 * Math.log10(p) : floorDb;
      const [r, g, b] = color((dB - floorDb) / (topDb - floorDb));
      const o = (y * width + col) * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  }
  return px;
}
