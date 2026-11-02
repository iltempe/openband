// Vertical video limits. They change often: this table says when it was last checked. No connection to any
// platform here: OpenBand exports the file, and the user posts it.
export const CHECKED = '2026-11-02';

export interface ClipPreset {
  id: string;
  name: string;
  maxSeconds: number;
  /** Loudness for phones, and the ceiling. */
  lufs: number;
  ceiling: number;
  /** Fractions of the frame the app covers with its buttons and caption. */
  safe: { right: number; bottom: number; top: number };
}

export const CLIP_PRESETS: ClipPreset[] = [
  { id: 'tiktok', name: 'TikTok', maxSeconds: 60, lufs: -14, ceiling: -1, safe: { right: 0.14, bottom: 0.2, top: 0.08 } },
  { id: 'reels', name: 'Instagram Reels', maxSeconds: 90, lufs: -14, ceiling: -1, safe: { right: 0.14, bottom: 0.2, top: 0.08 } },
  { id: 'shorts', name: 'YouTube Shorts', maxSeconds: 60, lufs: -14, ceiling: -1, safe: { right: 0.12, bottom: 0.18, top: 0.06 } },
];
export const presetOf = (id?: string) => CLIP_PRESETS.find((p) => p.id === id) ?? CLIP_PRESETS[0];
