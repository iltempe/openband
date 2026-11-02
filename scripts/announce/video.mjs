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
  const { W, H, title, version, cards, intro, each, theme } = s;
  const ease = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

  /** The animated graphic of a feature, around (cx, cy). */
  const scenes = {
    cassette() {
      const cx = W / 2, cy = 640, w = 780, h = 490;
      ctx.fillStyle = '#2a2230';
      ctx.beginPath(); ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 34); ctx.fill();
      ctx.fillStyle = '#f2e8d5';
      ctx.beginPath(); ctx.roundRect(cx - w / 2 + 40, cy - h / 2 + 34, w - 80, 150, 12); ctx.fill();
      ctx.fillStyle = '#221a10'; ctx.font = "700 46px Georgia, serif"; ctx.textAlign = 'center';
      ctx.fillText('Lato A', cx, cy - h / 2 + 124);
      ctx.fillStyle = '#17131c';
      ctx.beginPath(); ctx.roundRect(cx - 250, cy + 5, 500, 150, 75); ctx.fill();
      const wound = 0.5 + 0.5 * Math.sin(t * 0.25);
      [[cx - 170, 62 + wound * 30], [cx + 170, 92 - wound * 30]].forEach(([x, r]) => {
        ctx.fillStyle = '#4a3b2e'; ctx.beginPath(); ctx.arc(x, cy + 80, r, 0, 7); ctx.fill();
        ctx.fillStyle = '#f2e8d5'; ctx.beginPath(); ctx.arc(x, cy + 80, 44, 0, 7); ctx.fill();
        ctx.save(); ctx.translate(x, cy + 80); ctx.rotate(t * 3);
        ctx.fillStyle = '#221a10';
        for (let i = 0; i < 6; i++) { ctx.rotate(Math.PI / 3); ctx.fillRect(-5, 16, 10, 24); }
        ctx.restore();
      });
      for (let i = 0; i < 9; i++) {
        const a = ((t * 0.5 + i / 9) % 1), x = cx + 330 * Math.cos(a * 6.3 + i), y = 330 + a * 620;
        ctx.globalAlpha = 0.8 * Math.sin(a * Math.PI); ctx.fillStyle = '#ffb84d';
        ctx.font = '700 46px Georgia, serif'; ctx.fillText(i % 2 ? '♪' : '♫', x, y);
      }
      ctx.globalAlpha = 1;
    },
    box() {
      const left = 110, width = W - 220, cy = 620;
      const head = Math.min(width, ((t % 9) / 8) * width);
      const pauses = [0.34, 0.68];
      for (let x = 0; x < head; x += 9) {
        const u = x / width;
        if (pauses.some((p) => Math.abs(u - p) < 0.025)) continue;
        const a = (0.3 + 0.7 * Math.abs(Math.sin(x * 0.043) * Math.sin(x * 0.011 + 1))) * 190;
        ctx.fillStyle = u < 0.34 ? '#ff7a59' : u < 0.68 ? '#b14cff' : '#3cc8ff';
        ctx.fillRect(left + x, cy - a, 5, a * 2);
      }
      pauses.forEach((p, i) => {
        if (head < p * width) return;
        ctx.strokeStyle = '#eef0f6'; ctx.setLineDash([12, 10]); ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(left + p * width, cy - 240); ctx.lineTo(left + p * width, cy + 240); ctx.stroke(); ctx.setLineDash([]);
      });
      ['Brano 1', 'Brano 2', 'Brano 3'].forEach((n, i) => {
        if (head < (i * 0.34 + 0.12) * width) return;
        ctx.fillStyle = '#eef0f6'; ctx.font = '600 38px Inter, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(n, left + (i * 0.34 + 0.15) * width, cy + 300);
      });
      const on = Math.sin(t * 5) > 0;
      ctx.fillStyle = on ? '#ff4d5e' : '#5a1f28'; ctx.beginPath(); ctx.arc(W / 2 - 80, 320, 26, 0, 7); ctx.fill();
      ctx.fillStyle = '#eef0f6'; ctx.font = '800 60px Inter, sans-serif'; ctx.textAlign = 'left'; ctx.fillText('REC', W / 2 - 34, 342);
    },
    proposals() {
      const y0 = 340, y1 = 980, x = W / 2 - 170, k = ease((t % 8) / 5);
      ctx.lineWidth = 16; ctx.lineCap = 'round';
      ctx.strokeStyle = '#3cc8ff'; ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y0); ctx.stroke();
      ctx.strokeStyle = '#ff7a59'; ctx.beginPath(); ctx.moveTo(x, 880);
      const px = x + 340 * Math.min(1, k * 2), py = 880 - 200 * Math.min(1, k * 2);
      ctx.bezierCurveTo(x + 240, 860, px, 760, px, py);
      if (k > 0.5) { const m = (k - 0.5) * 2; ctx.lineTo(px, 680 - 170 * m); ctx.bezierCurveTo(px, 440, x + 200, 460, x + (340 * (1 - m)), 430 - 60 * m); }
      ctx.stroke();
      [[x, 880], [x, 700], [x, 520], [x, 370]].forEach(([a, b]) => { ctx.fillStyle = '#eef0f6'; ctx.beginPath(); ctx.arc(a, b, 24, 0, 7); ctx.fill(); });
      ctx.fillStyle = '#ff7a59'; ctx.beginPath(); ctx.arc(px, py, 24, 0, 7); ctx.fill();
      ctx.fillStyle = '#eef0f6'; ctx.font = '700 44px Inter, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('La tua canzone', x - 60, 1030);
      ctx.fillStyle = '#ff7a59'; ctx.font = '700 38px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Basso nuovo?', (x + px) / 2, py + 14); ctx.textAlign = 'left';
      if (k >= 1) { ctx.fillStyle = '#34d399'; ctx.font = '800 64px Inter, sans-serif'; ctx.fillText('✓ Unita', x + 60, 340); }
    },
    tests() {
      const rows = ['Voce sopra le chitarre', 'Master a −14 LUFS', 'Basso mono sotto 120 Hz', 'Niente clip'];
      const cycle = t % 8;
      rows.forEach((r, i) => {
        const y = 340 + i * 160, shown = ease((t - i * 0.3) / 0.4);
        const red = i === 0 && cycle > 3 && cycle < 6;
        ctx.globalAlpha = shown;
        ctx.fillStyle = '#1b1c26'; ctx.beginPath(); ctx.roundRect(100, y, W - 200, 124, 20); ctx.fill();
        ctx.fillStyle = red ? '#ff4d5e' : '#34d399'; ctx.beginPath(); ctx.arc(170, y + 62, 34, 0, 7); ctx.fill();
        ctx.fillStyle = '#0c0d11'; ctx.font = '800 46px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(red ? '✗' : '✓', 170, y + 78);
        ctx.fillStyle = '#eef0f6'; ctx.font = '600 44px Inter, sans-serif'; ctx.textAlign = 'left'; ctx.fillText(r, 230, y + 78);
        ctx.globalAlpha = 1;
      });
    },
    clips() {
      const pw = 400, ph = 711, px = W / 2 - pw / 2, py = 300;
      ctx.fillStyle = '#17181f'; ctx.beginPath(); ctx.roundRect(px - 16, py - 16, pw + 32, ph + 32, 44); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.roundRect(px, py, pw, ph, 30); ctx.clip();
      ctx.fillStyle = '#231a33'; ctx.fillRect(px, py, pw, ph);
      for (let i = 0; i < 26; i++) {
        const lane = (i * 7) % 8, s = (i * 0.45 + t * 0.9) % 11.7;
        const y = py + s * 70 - 120, l = 50 + (i * 13) % 70;
        ctx.fillStyle = ['#ff7a59', '#b14cff', '#3cc8ff', '#34d399'][i % 4];
        ctx.beginPath(); ctx.roundRect(px + 22 + lane * 45, y, 38, l, 8); ctx.fill();
      }
      ctx.fillStyle = '#ffffff'; ctx.fillRect(px, py + 560, pw, 5);
      ctx.restore();
      const p = (t % 4) / 4;
      ctx.strokeStyle = '#ffb84d'; ctx.lineWidth = 10; ctx.beginPath(); ctx.arc(W - 170, 420, 58, -1.57, -1.57 + p * 6.28); ctx.stroke();
      ctx.fillStyle = '#ffb84d'; ctx.font = '800 34px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('LOOP', W - 170, 432);
      ctx.fillStyle = '#eef0f6'; ctx.font = '700 44px Inter, sans-serif'; ctx.fillText('9:16', 170, 432);
    },
    devices() {
      const open = 0.5 + 0.5 * Math.sin(t * 1.3);
      const sx = 200, sy = 880, hy = 800 - open * 420;
      ctx.fillStyle = '#34d399'; ctx.beginPath(); ctx.roundRect(sx - 70, sy, 140, 46, 10); ctx.fill();
      ctx.fillStyle = '#0c0d11'; ctx.beginPath(); ctx.arc(sx, sy + 8, 14, 0, 7); ctx.fill();
      ctx.font = '120px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.fillText('✋', sx, hy);
      ctx.strokeStyle = 'rgba(52,211,153,.6)'; ctx.setLineDash([10, 12]); ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, hy + 30); ctx.stroke(); ctx.setLineDash([]);
      const x0 = 400, x1 = W - 90, base = 880, cut = x0 + (x1 - x0) * (0.25 + 0.65 * open);
      ctx.strokeStyle = '#b14cff'; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(x0, 520);
      ctx.lineTo(cut - 60, 520); ctx.bezierCurveTo(cut, 520, cut, 470, cut + 40, 560); ctx.bezierCurveTo(cut + 90, 700, cut + 110, base, Math.min(x1, cut + 170), base); ctx.stroke();
      ctx.fillStyle = '#eef0f6'; ctx.font = '700 46px Inter, sans-serif'; ctx.fillText('Filtro', (x0 + x1) / 2, 410);
    },
  };
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#120f1f');
  grad.addColorStop(1, '#0c0d11');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Bars that breathe, like a meter.
  const bars = scenes[theme] ? 0 : 28;
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
  // With a feature's graphic, it plays all along and the words sit under it, above what the apps cover.
  if (scenes[theme]) {
    const end = intro + cards.length * each;
    if (t < end) {
      ctx.textAlign = 'center';
      scenes[theme]();
      ctx.textAlign = 'center';
      ctx.lineCap = 'butt';
      if (t < intro) block(title, 1150 + slide(0.1), 84, 800, '#ffffff', fade(0.1, intro));
      else {
        const i = Math.floor((t - intro) / each);
        const from = intro + i * each;
        block(cards[i], 1150 + slide(from), 62, 700, '#ffffff', fade(from, from + each));
      }
      return;
    }
  }
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

export async function renderVideo({ version, title, points, out, theme, chrome = CHROMES.find((p) => fs.existsSync(p)) }) {
  if (!chrome) throw new Error('No Chrome found');
  const cards = points.map((p) => shortPoint(p));
  const intro = 2.6;
  const each = 3.2;
  const outro = 3;
  const duration = intro + cards.length * each + outro;
  const scene = { W, H, title, version, cards, intro, each, outro, theme };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const root = { cassette: 196, box: 220, proposals: 246.94, tests: 261.63, clips: 293.66, devices: 174.61 }[theme] ?? 220;
  const audio = `aevalsrc=0.05*sin(2*PI*${root}*t)*(1+0.3*sin(2*PI*0.5*t))+0.04*sin(2*PI*${root * 1.26}*t)+0.04*sin(2*PI*${root * 1.5}*t)+0.03*sin(2*PI*${root / 2}*t):s=48000:c=stereo`;
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
