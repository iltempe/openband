// Typographic covers (SPEC v0.6 G6): deterministic for a style, a palette and a seed, so the release keeps
// only the recipe. Square, 3000 px (every platform's size), PNG. Drawn on a canvas in the page.
import { seeded } from '../audio/instruments';

export const COVER_STYLES = ['bold', 'grid', 'waves', 'minimal'] as const;
export const PALETTES: Record<string, [string, string, string]> = {
  night: ['#0f1020', '#9b6bff', '#f5f3ff'],
  sunset: ['#2b1020', '#ff7a59', '#ffe8d6'],
  ocean: ['#071c2c', '#3cc8ff', '#e6f7ff'],
  forest: ['#0d1f14', '#6ee7a8', '#f0fff4'],
  paper: ['#f4efe6', '#1d1d1f', '#c2410c'],
  mono: ['#111111', '#eeeeee', '#888888'],
};

export interface CoverRecipe {
  style: string;
  palette: string;
  seed: number;
}

/** Draw a cover on a canvas context of size×size. */
export function drawCover(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, size: number, r: CoverRecipe, text: { title: string; artist?: string }) {
  const [bg, accent, ink] = PALETTES[r.palette] ?? PALETTES.night;
  const rnd = seeded(r.seed);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  if (r.style === 'grid') {
    const n = 6 + Math.floor(rnd() * 5);
    const cell = size / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (rnd() < 0.45) continue;
        ctx.globalAlpha = 0.25 + rnd() * 0.75;
        ctx.fillStyle = rnd() < 0.7 ? accent : ink;
        const s = cell * (0.3 + rnd() * 0.6);
        ctx.fillRect(i * cell + (cell - s) / 2, j * cell + (cell - s) / 2, s, s);
      }
  } else if (r.style === 'waves') {
    ctx.lineWidth = size / 180;
    for (let k = 0; k < 14; k++) {
      ctx.strokeStyle = k % 3 === 0 ? ink : accent;
      ctx.globalAlpha = 0.3 + 0.7 * (k / 14);
      const f = 1 + rnd() * 4;
      const ph = rnd() * Math.PI * 2;
      const y0 = size * (0.15 + k * 0.05);
      ctx.beginPath();
      for (let x = 0; x <= size; x += size / 200) ctx.lineTo(x, y0 + Math.sin((x / size) * Math.PI * 2 * f + ph) * size * 0.04);
      ctx.stroke();
    }
  } else if (r.style === 'bold') {
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(size * (0.3 + rnd() * 0.4), size * (0.3 + rnd() * 0.3), size * (0.22 + rnd() * 0.15), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = ink;
    ctx.fillRect(0, size * (0.62 + rnd() * 0.08), size, size * 0.012);
  } else {
    ctx.fillStyle = accent;
    ctx.fillRect(size * 0.08, size * 0.08, size * 0.012, size * 0.84);
  }
  ctx.restore();
  // The words: title large, artist smaller, left-aligned at the bottom.
  ctx.fillStyle = ink;
  ctx.textBaseline = 'alphabetic';
  const margin = size * 0.08;
  let fs = size * 0.11;
  const font = (px: number, w = 800) => `${w} ${px}px "Inter", "Helvetica Neue", Arial, sans-serif`;
  ctx.font = font(fs);
  while (ctx.measureText(text.title).width > size - margin * 2 && fs > size * 0.04) ctx.font = font((fs *= 0.92));
  ctx.fillText(text.title, margin, size - margin - (text.artist ? size * 0.07 : 0));
  if (text.artist) {
    ctx.globalAlpha = 0.8;
    ctx.font = font(size * 0.045, 500);
    ctx.fillText(text.artist, margin, size - margin);
    ctx.globalAlpha = 1;
  }
}

/** The cover as PNG bytes. */
export async function coverPng(r: CoverRecipe, text: { title: string; artist?: string }, size = 3000): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  drawCover(ctx, size, r, text);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}
