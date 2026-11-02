// Ready-made sets of tests, added with one click and editable. Thresholds are starting points.
import { parseTest } from './parse';
import type { SongTest } from './types';

/** Integrated loudness and true peak that streaming services normalise to. */
const STREAMING = ['master.lufs_i tra -16 e -12', 'master.true_peak <= -1'];

export const SUITES: Record<string, { name: string; lines: string[] }> = {
  streaming: { name: 'Ready for streaming', lines: STREAMING },
  vocals: { name: 'Vocals up front', lines: ['in ritornello: voce.lufs >= armonia.lufs + 3 dB', 'in strofa: voce.lufs >= armonia.lufs + 3 dB'] },
  lows: { name: 'Clean low end', lines: ['basso: mono sotto 120 Hz', 'cassa vs basso: masking 40–120 Hz <= 0.6'] },
  clip: { name: 'No clipping', lines: ['master.true_peak <= 0'] },
  stable: { name: 'Stable against the approved version', lines: ['rispetto a approvata: ogni traccia ± 1.5 dB per sezione'] },
};

export const suiteTests = (id: string, uid: () => string): SongTest[] => {
  const s = SUITES[id];
  if (!s) throw new Error(`No such set. Sets: ${Object.keys(SUITES).join(', ')}`);
  return s.lines.map((l) => parseTest(l, uid()));
};
