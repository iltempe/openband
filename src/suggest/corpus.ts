// The ghost notes' bundled corpus (G3): short melodies and chord progressions written for OpenBand and
// released as CC0 (public domain) — no tune is taken from anywhere. They teach the models the common
// shapes of pop, folk and jazz-ish writing; the song itself and the user's own songs weigh more.
//
// Melodies: "step.dur" pairs — step in the key's scale (0 = tonic, 7 = the octave above, −1 the note
// below the tonic), dur in sixteenths; "r.dur" is a rest. Key-free: they fit major and minor alike.
// Progressions: scale degrees 1–7, one per bar (or "4 5" for two in a bar), minor keys read them in minor.

export const MELODIES: string[] = [
  '0.4 1.4 2.4 0.4 2.4 3.4 4.8',
  '4.4 4.2 3.2 2.4 1.4 2.8 r.8',
  '2.2 2.2 2.4 2.2 1.2 0.4 1.8 r.8',
  '0.6 1.2 2.4 4.4 3.6 2.2 1.8',
  '4.2 5.2 4.2 3.2 2.4 0.4 1.4 2.4 0.8',
  '7.4 6.2 5.2 4.4 2.4 3.2 4.2 5.4 4.8',
  '0.2 2.2 4.2 7.2 6.4 4.4 5.2 4.2 2.4 0.8',
  '2.4 1.4 0.4 -1.4 0.8 r.8',
  '4.2 4.2 5.4 4.4 7.4 6.8 r.4',
  '0.4 0.2 1.2 2.4 2.2 3.2 4.4 3.4 2.8',
  '2.6 3.2 4.4 2.4 1.6 2.2 0.8',
  '5.4 4.4 3.4 2.4 1.4 2.4 0.8',
  '0.2 1.2 2.2 3.2 4.4 4.4 5.2 4.2 3.2 2.2 1.8',
  '4.3 4.1 4.4 5.4 4.4 2.4 3.4 1.4 2.8',
  '2.4 4.4 3.2 2.2 1.4 2.4 r.4 0.8',
  '7.2 6.2 7.4 4.4 5.2 4.2 5.4 2.8',
  '0.4 4.4 3.4 2.2 1.2 0.4 1.4 -1.4 0.4',
  '2.2 3.2 4.2 2.2 3.4 1.4 2.2 0.2 1.4 -1.4 0.8',
  '4.4 4.4 2.4 4.4 5.6 4.2 2.8',
  '0.8 2.8 4.8 7.8',
  '3.4 2.4 1.4 0.4 1.4 2.4 3.8',
  '4.6 3.2 2.4 3.4 4.4 2.4 1.8',
  '2.2 2.2 1.2 2.2 r.2 2.2 1.2 2.2 3.4 2.4 1.8',
  '0.4 2.4 1.4 3.4 2.4 4.4 3.4 5.4 4.8',
  '7.4 4.4 5.4 2.4 3.4 0.4 1.8',
  '4.2 2.2 4.2 2.2 5.2 3.2 5.2 3.2 4.4 2.4 0.8',
  '1.4 2.2 1.2 0.4 -1.4 -3.8 r.8',
  '2.3 2.1 3.2 2.2 1.4 r.2 0.2 1.2 2.2 1.8',
  '4.8 3.4 2.4 1.12 r.4',
  '0.2 0.2 4.4 4.2 5.2 4.4 3.2 2.2 1.4 0.8',
  '5.2 4.2 5.2 6.2 7.4 6.2 5.2 4.8 r.8',
  '2.4 3.2 2.2 1.4 0.4 2.4 3.2 2.2 1.8',
  '-3.4 -1.4 0.4 1.4 2.8 1.4 0.4',
  '4.2 r.2 4.2 r.2 3.2 2.2 3.2 4.2 2.8 r.8',
  '0.6 2.2 4.4 6.4 7.8 r.8',
  '7.2 7.2 6.2 5.2 4.4 4.4 3.2 2.2 1.2 0.2 1.8',
  '2.4 2.4 3.4 4.4 4.4 3.4 2.4 1.4 0.4 0.4 1.4 2.4 2.6 1.2 1.8',
  '4.4 5.2 6.2 7.4 4.4 3.4 2.2 1.2 0.8',
  '1.2 2.2 3.4 1.2 2.2 3.4 4.2 3.2 2.2 1.2 0.8',
  '0.3 1.1 2.4 4.4 3.3 2.1 1.4 2.4 r.4',
];

export const PROGRESSIONS: string[] = [
  '1 5 6 4', '1 6 4 5', '6 4 1 5', '1 4 5 1', '1 4 6 5', '2 5 1 1', '1 6 2 5', '4 5 3 6',
  '1 3 4 4', '1 5 4 4', '6 5 4 5', '1 4 1 5', '1 1 4 4 5 5 1 1', '4 1 5 6', '1 5 6 3 4 1 4 5',
  '6 4 5 1', '1 7 6 5', '2 4 5 1', '1 2 4 5', '4 4 1 1 5 4 1 5', '1 6 4 5 1 6 4 5', '6 2 5 1',
  '1 4 2 5', '3 6 2 5', '1 5 4 5', '4 5 6 6', '1 1 6 6 4 4 5 5', '6 6 4 4 1 1 5 5', '1 3 6 4', '2 5 3 6',
];

/** A melody of the corpus → notes in scale steps: {step | null (rest), dur in sixteenths}. */
export function parseMelody(m: string): { step: number | null; dur: number }[] {
  return m.split(/\s+/).map((tok) => {
    const [a, b] = tok.split('.');
    return { step: a === 'r' ? null : Number(a), dur: Number(b) };
  });
}
