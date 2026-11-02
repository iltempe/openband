// The cassette's own player (D1.3): plain TypeScript and DOM, bundled into every cassette. No external request,
// ever: a cassette of today must still play when OpenBand is gone.
import { open, fingerprint, unlockKey } from '../cassette/crypto';
import { b64, newListener, sealReply, type Reply, type ReplyItem } from '../cassette/reply';
import { sendP2P } from '../cassette/p2p';
import { openManifest, parseLink, signerState, sideSeconds, type CassetteManifest, type CassetteTrack } from '../cassette/format';

declare global {
  interface Window {
    __CASSETTE__?: { manifest: string; blobs: Record<string, string>; lock?: { salt: string; iterations: number; sealed: string } };
  }
}

const IT = /^it/i.test(navigator.language);
const T = (en: string, it: string) => (IT ? it : en);
const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function read(path: string) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
const sealedManifest = () => (window.__CASSETTE__ ? bytes(window.__CASSETTE__.manifest) : read('c.bin'));
const sealedBlob = (id: string) => (window.__CASSETTE__ ? bytes(window.__CASSETTE__.blobs[id]) : read(`b/${id}.bin`));

function ask(message: string): Promise<string> {
  const f = $('form', 'unlock');
  const label = $('label', '', message);
  const input = $('input');
  input.type = 'password';
  input.autocomplete = 'off';
  label.append(input);
  const go = $('button', '', T('Open', 'Apri'));
  f.append(label, go);
  document.body.replaceChildren(f);
  input.focus();
  return new Promise((resolve) => f.addEventListener('submit', (e) => (e.preventDefault(), resolve(input.value))));
}

async function theKey(): Promise<string> {
  const { key } = parseLink(location.hash);
  if (key) return key;
  const lock = window.__CASSETTE__?.lock ?? (await read('lock.json').then((b) => JSON.parse(new TextDecoder().decode(b)), () => null));
  if (!lock) throw new Error(T('This link has no key.', 'Questo link non ha la chiave.'));
  for (let msg = T('Password', 'Password'); ; msg = T('Wrong password. Try again', 'Password sbagliata. Riprova')) {
    try {
      return await unlockKey(lock, await ask(msg));
    } catch {
      /* ask again */
    }
  }
}

/** Wow, flutter, a little saturation and hiss, in Web Audio; the file isn't touched. */
function tape(ctx: AudioContext, input: AudioNode, level: 'off' | 'soft' | 'worn') {
  if (level === 'off') return void input.connect(ctx.destination);
  const depth = level === 'worn' ? 0.0012 : 0.0005;
  const delay = ctx.createDelay(0.05);
  delay.delayTime.value = 0.01;
  const wow = ctx.createOscillator();
  wow.frequency.value = 0.7;
  const wowGain = ctx.createGain();
  wowGain.gain.value = depth;
  wow.connect(wowGain).connect(delay.delayTime);
  wow.start();
  const sat = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  const drive = level === 'worn' ? 2.2 : 1.3;
  for (let i = 0; i < 1024; i++) curve[i] = Math.tanh(((i / 512 - 1) * drive)) / Math.tanh(drive);
  sat.curve = curve;
  input.connect(delay).connect(sat).connect(ctx.destination);
  const n = ctx.sampleRate * 2;
  const hissBuf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = hissBuf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const hiss = ctx.createBufferSource();
  hiss.buffer = hissBuf;
  hiss.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 4000;
  const g = ctx.createGain();
  g.gain.value = 10 ** (-60 / 20);
  hiss.connect(hp).connect(g).connect(ctx.destination);
  hiss.start();
}

interface Ui {
  m: CassetteManifest;
  key: string;
  urls: Map<string, string>;
  audio: HTMLAudioElement;
  side: number;
  track: number;
}

async function urlOf(u: Ui, id: string, type: string) {
  const have = u.urls.get(id);
  if (have) return have;
  const url = URL.createObjectURL(new Blob([(await open(u.key, await sealedBlob(id))) as BlobPart], { type }));
  u.urls.set(id, url);
  return url;
}

// ---- the return tape ----

interface Listener {
  name: string;
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}

/** One identity per musician: not linkable between two of them. */
async function listener(m: CassetteManifest): Promise<Listener | null> {
  const slot = `openband.listener.${await fingerprint(m.author.signKey)}`;
  const saved = localStorage.getItem(slot);
  if (saved) return JSON.parse(saved) as Listener;
  const name = prompt(T('Your name, so they know who it is', 'Il tuo nome, così sa chi sei'));
  if (!name?.trim()) return null;
  const me = { name: name.trim(), ...(await newListener()) };
  localStorage.setItem(slot, JSON.stringify(me));
  return me;
}

const QUEUE = 'openband.cassette.queue';
const queued = (): { series: string; text: string; file: string }[] => JSON.parse(localStorage.getItem(QUEUE) ?? '[]');

/** The first road that works; the rest stays in the queue for the next time. */
async function deliver(u: Ui, text: string, say: (s: string) => void) {
  const { m } = u;
  for (const r of m.returns) {
    if (r.kind === 'https') {
      const ok = await fetch(`${r.url}/api/cassette/v1/inbox`, { method: 'POST', body: text }).then((x) => x.ok, () => false);
      if (ok) return say(T('Delivered.', 'Consegnato.'));
    }
    if (r.kind === 'webrtc' && (await sendP2P(r.signaling, r.room, text))) return say(T('Delivered.', 'Consegnato.'));
  }
  const file = `${m.title}-per-${m.artist}.risposta`;
  try {
    localStorage.setItem(QUEUE, JSON.stringify([...queued(), { series: m.seriesId, text, file }]));
  } catch {
    /* too big to keep: the file below is the way */
  }
  say(m.returns.length ? T(`Waiting for ${m.artist} to open the studio. You can also send it yourself.`, `In attesa che ${m.artist} apra lo studio. Puoi anche mandarlo tu.`) : T('Send it yourself.', 'Mandalo tu.'));
  const share = $('button', 'download', T('Send it', 'Mandalo'));
  share.onclick = async () => {
    const f = new File([text], file, { type: 'application/octet-stream' });
    if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f] }).catch(() => null);
    else {
      const a = $('a');
      a.href = URL.createObjectURL(f);
      a.download = file;
      a.click();
    }
  };
  document.querySelector('.returns')?.append(share);
}

function returnsBox(u: Ui, track: () => CassetteTrack, now: () => number) {
  const { m } = u;
  const box = $('section', 'returns');
  box.append($('h2', '', T('The return tape', 'Il nastro di ritorno')));
  const status = $('p', 'note');
  status.setAttribute('role', 'status');
  const say = (s: string) => (status.textContent = s);
  const send = async (items: ReplyItem[]) => {
    const me = await listener(m);
    if (!me) return;
    const t = track();
    const via = parseLink(location.hash).via ?? undefined;
    const reply: Reply = { format: 'openband-reply/1', id: b64(crypto.getRandomValues(new Uint8Array(9))), seriesId: m.seriesId, edition: m.edition, trackId: t.id, versionId: t.versionId, from: { name: me.name, key: me.publicKey }, createdAt: Date.now(), items, ...(via ? { via } : {}) };
    say(T('Sending…', 'Invio…'));
    await deliver(u, JSON.stringify(await sealReply(reply, me.privateKey, m.author.boxKey)), say);
  };
  const row = $('div', 'row');
  for (const [emoji, label] of [['✨', T('chills', 'brividi')], ['🔁', T('again!', 'ancora!')], ['🤔', T('not sure here', 'qui non mi convince')]]) {
    const b = $('button', 'react', `${emoji}`);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.onclick = () => void send([{ kind: 'reaction', t: now(), label: `${emoji} ${label}` }]);
    row.append(b);
  }
  box.append(row);
  const form = $('form', 'row');
  const input = $('input');
  input.placeholder = T('A word on this moment', 'Una parola su questo punto');
  input.setAttribute('aria-label', input.placeholder);
  const go = $('button', 'react', T('Send', 'Invia'));
  form.append(input, go);
  form.onsubmit = (e) => {
    e.preventDefault();
    if (input.value.trim()) void send([{ kind: 'comment', t: now(), text: input.value.trim() }]);
    input.value = '';
  };
  box.append(form);
  if (m.options.voiceNotes && typeof MediaRecorder !== 'undefined') {
    const rec = $('button', 'react', `🎙 ${T('Voice note', 'Vocale')}`);
    let recorder: MediaRecorder | null = null;
    rec.onclick = async () => {
      if (recorder) return recorder.stop();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      if (!stream) return say(T('The microphone needs an https link.', 'Il microfono vuole un link https.'));
      const at = now();
      const parts: Blob[] = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => parts.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((x) => x.stop());
        const type = recorder!.mimeType;
        recorder = null;
        rec.textContent = `🎙 ${T('Voice note', 'Vocale')}`;
        const blob = new Uint8Array(await new Blob(parts, { type }).arrayBuffer());
        await send([{ kind: 'voice', t: at, blob: b64(blob), type }]);
      };
      recorder.start();
      rec.textContent = `■ ${T('Stop', 'Ferma')}`;
      setTimeout(() => recorder?.stop(), 30000);
    };
    box.append(rec);
  }
  box.append(status);
  // Anything left from last time goes out now.
  const waiting = queued().filter((q) => q.series === m.seriesId);
  if (waiting.length) {
    localStorage.setItem(QUEUE, JSON.stringify(queued().filter((q) => q.series !== m.seriesId)));
    for (const q of waiting) void deliver(u, q.text, say);
  }
  return box;
}

function render(u: Ui, signNote: string) {
  const { m } = u;
  const root = $('main', 'cassette');
  const shell = $('div', 'shell');
  shell.append($('span', 'reel left'), $('span', 'reel right'), $('h1', '', m.title), $('p', 'artist', m.artist));
  const stamp = $('p', 'edition', `${T('Print', 'Stampa')} ${m.edition} · ${signNote}`);
  root.append(shell, stamp);
  if (m.dedication) root.append($('p', 'dedication', m.dedication));
  const flip = $('button', 'flip', '');
  const list = $('ol', 'tracks');
  const now = $('div', 'now');
  const bar = $('input');
  bar.type = 'range';
  bar.min = '0';
  bar.max = '1000';
  bar.value = '0';
  bar.className = 'bar';
  bar.setAttribute('aria-label', T('Position', 'Posizione'));
  const marks = $('div', 'marks');
  const line = $('p', 'lyric');
  line.setAttribute('aria-live', 'polite');
  const chord = $('p', 'chord');
  const note = $('p', 'note');
  const play = $('button', 'play', T('Play', 'Play'));
  const volumeRow = $('div', 'row');
  const saw = $('label', 'tape');
  const noise = $('input');
  noise.type = 'checkbox';
  noise.checked = m.options.tapeSound !== 'off';
  saw.append(noise, ` ${T('Tape sound', 'Suono del nastro')}`);
  volumeRow.append(saw);
  root.append(flip, list, now, marks, bar, chord, line, note, play, volumeRow);
  if (m.notes) root.append($('p', 'notes', m.notes));
  let ctx: AudioContext | null = null;
  const current = (): CassetteTrack => m.sides[u.side].tracks[u.track];

  const drawSide = () => {
    const side = m.sides[u.side];
    const other = m.sides[1 - u.side];
    flip.textContent = other?.tracks.length ? `${T('Turn over', 'Gira la cassetta')} → ${T('side', 'lato')} ${other.name}` : `${T('Side', 'Lato')} ${side.name}`;
    flip.disabled = !other?.tracks.length;
    list.replaceChildren(
      ...side.tracks.map((t, i) => {
        const li = $('li', i === u.track ? 'on' : '');
        const b = $('button', '', `${t.title} · ${time(t.durationS)}`);
        b.onclick = () => void load(i, true);
        li.append(b);
        return li;
      }),
    );
    now.textContent = `${T('Side', 'Lato')} ${side.name}, ${time(sideSeconds(side))}`;
  };

  async function load(i: number, start: boolean) {
    u.track = i;
    drawSide();
    const t = current();
    u.audio.src = await urlOf(u, t.audio.id, t.audio.type);
    note.textContent = t.note ?? '';
    marks.replaceChildren(...(t.sections ?? []).map((s) => {
      const x = $('span', 'tick');
      x.style.left = `${(s.startS / t.durationS) * 100}%`;
      x.title = s.name;
      return x;
    }));
    if ('mediaSession' in navigator) {
      const cover = await urlOf(u, m.jcard.cover.id, m.jcard.cover.type);
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: m.artist, album: m.title, artwork: [{ src: cover, sizes: '800x800', type: 'image/png' }] });
    }
    if (start) await u.audio.play();
  }

  const next = () => {
    const side = m.sides[u.side];
    if (u.track + 1 < side.tracks.length) void load(u.track + 1, true);
    else if (m.sides[u.side + 1]?.tracks.length) {
      u.side++;
      void load(0, true);
    } else document.body.classList.remove('rolling');
  };
  flip.onclick = () => {
    u.side = 1 - u.side;
    void load(0, !u.audio.paused);
  };
  play.onclick = async () => {
    if (!ctx && noise.checked && m.options.tapeSound !== 'off') {
      ctx = new AudioContext();
      tape(ctx, ctx.createMediaElementSource(u.audio), m.options.tapeSound);
    }
    if (u.audio.paused) {
      if (!u.audio.src) await load(0, false);
      await u.audio.play();
    } else u.audio.pause();
  };
  u.audio.onplay = () => (document.body.classList.add('rolling'), (play.textContent = T('Pause', 'Pausa')));
  u.audio.onpause = () => (document.body.classList.remove('rolling'), (play.textContent = T('Play', 'Play')));
  u.audio.onended = next;
  bar.oninput = () => (u.audio.currentTime = (Number(bar.value) / 1000) * current().durationS);
  u.audio.ontimeupdate = () => {
    const t = current();
    const s = u.audio.currentTime;
    bar.value = String((s / t.durationS) * 1000);
    line.textContent = t.lyrics?.find((l) => s >= l.t && s < l.end)?.text ?? '';
    chord.textContent = [...(t.chords ?? [])].reverse().find((c) => s >= c.t)?.chord ?? '';
  };
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => void u.audio.play());
    navigator.mediaSession.setActionHandler('pause', () => u.audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack', next);
    navigator.mediaSession.setActionHandler('previoustrack', () => void load(Math.max(0, u.track - 1), true));
  }
  document.body.replaceChildren(root);
  document.body.append(u.audio);
  drawSide();
  void urlOf(u, m.jcard.cover.id, m.jcard.cover.type).then((src) => (shell.style.backgroundImage = `url(${src})`));
  if (m.options.reactions) root.append(returnsBox(u, current, () => u.audio.currentTime));
  if (m.options.download) {
    const dl = $('button', 'download', T('Download the songs', 'Scarica i brani'));
    dl.onclick = async () => {
      for (const s of m.sides)
        for (const t of s.tracks) {
          const a = $('a');
          a.href = await urlOf(u, t.audio.id, t.audio.type);
          a.download = `${t.title} - ${m.artist}.m4a`;
          a.click();
        }
    };
    root.append(dl);
  }
}

async function main() {
  try {
    const key = await theKey();
    const { manifest: m, signed } = await openManifest(await sealedManifest(), key);
    if (!signed) throw new Error(T('This cassette has been altered.', 'Questa cassetta è stata alterata.'));
    const print = await fingerprint(m.author.signKey);
    const slot = `openband.cassette.signer.${m.seriesId}`;
    const state = signerState(localStorage.getItem(slot), print);
    if (state === 'first') localStorage.setItem(slot, print);
    const note = state === 'changed' ? T(`Not the same signature as before! ${print}`, `Non è la stessa firma di prima! ${print}`) : `${T('Signed', 'Firmata')} ${print}`;
    if (state === 'changed') document.body.classList.add('warn');
    render({ m, key, urls: new Map(), audio: new Audio(), side: 0, track: 0 }, note);
    if ('serviceWorker' in navigator && location.protocol === 'https:') void navigator.serviceWorker.register('sw.js').catch(() => null);
  } catch (e) {
    document.body.replaceChildren($('p', 'error', (e as Error).message));
  }
}

void main();
