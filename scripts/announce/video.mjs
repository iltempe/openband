// The release as a 9:16 animation for social media: drawn on a canvas in headless Chrome, frame by frame so it's
// the same on any machine, with a soft chord under it. One title card, one card per point, and the download.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { shortPoint } from './notes.mjs';

const W = 1080;
const H = 1920;
const FPS = 30;
const CHROMES = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];

/** Runs in the page. `t` in seconds. Pure drawing: a frame depends on `t` alone. */
function draw(ctx, t, s) {
  const { W, H, title, version, cards, intro, each, outro } = s;
  const ease = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#120f1f');
  grad.addColorStop(1, '#0c0d11');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Bars that breathe, like a meter.
  const bars = 28;
  for (let i = 0; i < bars; i++) {
    const a = 0.5 + 0.5 * Math.sin(t * 2.2 + i * 0.55) * Math.sin(t * 0.7 + i * 0.21);
    const h = 90 + a * 260;
    const x = (i / bars) * W;
    const g = ctx.createLinearGradient(0, H - h, 0, H);
    g.addColorStop(0, 'rgba(255,122,89,.65)');
    g.addColorStop(0.5, 'rgba(177,76,255,.5)');
    g.addColorStop(1, 'rgba(60,200,255,.15)');
    ctx.fillStyle = g;
    ctx.fillRect(x + 6, H - h, W / bars - 12, h);
  }
  const wrap = (text, width) => {
    const out = [];
    let line = '';
    for (const word of text.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width && line) (out.push(line), (line = word));
      else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  const block = (text, y, size, weight, color, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px Inter, -apple-system, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    const lines = wrap(text, W - 180);
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y + i * size * 1.22));
    ctx.globalAlpha = 1;
    return y + lines.length * size * 1.22;
  };
  const slide = (from) => 60 * (1 - ease((t - from) / 0.5));
  const fade = (from, to) => ease((t - from) / 0.5) * (1 - ease((t - to + 0.4) / 0.4));
  block('OpenBand', 190, 54, 700, '#eef0f6', 0.9);
  if (t < intro) {
    block(`v${version}`, 760 + slide(0), 60, 600, '#b14cff', fade(0, intro));
    block(title, 880 + slide(0.2), 104, 800, '#ffffff', fade(0.2, intro));
    return;
  }
  const end = intro + cards.length * each;
  if (t < end) {
    const i = Math.floor((t - intro) / each);
    const from = intro + i * each;
    block(`${i + 1} / ${cards.length}`, 620, 44, 600, '#3cc8ff', fade(from, from + each));
    block(cards[i], 760 + slide(from), 82, 750, '#ffffff', fade(from, from + each));
    return;
  }
  const a = ease((t - end) / 0.5);
  block('Scaricala gratis', 800, 72, 600, '#eef0f6', a);
  block('openband.it', 930, 112, 800, '#ffffff', a);
  block('Open source · Mac, Windows, Linux, web', 1110, 42, 500, '#9095a8', a);
}

export async function renderVideo({ version, title, points, out, chrome = CHROMES.find((p) => fs.existsSync(p)) }) {
  if (!chrome) throw new Error('No Chrome found');
  const cards = points.map((p) => shortPoint(p));
  const intro = 2.6;
  const each = 3.2;
  const outro = 3;
  const duration = intro + cards.length * each + outro;
  const scene = { W, H, title, version, cards, intro, each, outro };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const audio = 'aevalsrc=0.05*sin(2*PI*220*t)*(1+0.3*sin(2*PI*0.5*t))+0.04*sin(2*PI*277.18*t)+0.04*sin(2*PI*329.63*t)+0.03*sin(2*PI*110*t):s=48000:c=stereo';
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-f', 'lavfi', '-i', audio, '-t', String(duration), '-af', `afade=t=in:d=1,afade=t=out:st=${duration - 1.5}:d=1.5`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<canvas id=c width=${W} height=${H}></canvas>`);
    await page.evaluate((src, sc) => {
      const fn = new Function(`return (${src})`)();
      const ctx = document.getElementById('c').getContext('2d');
      window.frame = (t) => (fn(ctx, t, sc), document.getElementById('c').toDataURL('image/jpeg', 0.92).split(',')[1]);
    }, draw.toString(), scene);
    const frames = Math.ceil(duration * FPS);
    for (let i = 0; i < frames; i++) {
      const b64 = await page.evaluate((t) => window.frame(t), i / FPS);
      if (!ff.stdin.write(Buffer.from(b64, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
    }
  } finally {
    await browser.close();
  }
  ff.stdin.end();
  await new Promise((resolve, reject) => ff.on('close', (c) => (c ? reject(new Error(`ffmpeg ${c}`)) : resolve())));
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
  return { file: out, size: probe, seconds: duration, bytes: fs.statSync(out).size };
}
