// The music generation gateway's runtime (docs/adr/0004-music-gateway.md): what every provider driver
// needs, once — HTTP with retries and a concurrency limit, polling, errors in one shape, audio files
// recognised by their bytes, and the "brief" (what a song is, in the words music services take).
// No Node-only APIs except in writeAudio (the engine's side): drivers use `http` from here.

/** One shape for every provider's errors; `code` says what the user can do about it. */
export class GatewayError extends Error {
  constructor(code, provider, message, { retryable = false, retryAfterS, suggestion, requestId, status } = {}) {
    super(message);
    Object.assign(this, { code, provider, retryable, ...(retryAfterS ? { retryAfterS } : {}), ...(suggestion ? { suggestion } : {}), ...(requestId ? { requestId } : {}), ...(status ? { status } : {}) });
  }
}

/** The generic meaning of an HTTP status, when a driver has nothing more specific. */
export function errorFor(provider, status, text = '', extra = {}) {
  const name = { auth: 'the key was refused', credits: 'out of credits', rate: 'too many requests', region: 'not available in this region', unavailable: 'the service is busy or down' };
  const code = status === 401 ? 'auth' : status === 402 ? 'credits' : status === 403 ? 'auth' : status === 429 ? 'rate' : status >= 500 ? 'unavailable' : 'bad_request';
  const msg = `${provider}: ${name[code] ?? `request refused (HTTP ${status})`}${text ? ` — ${String(text).slice(0, 300)}` : ''}`;
  return new GatewayError(code, provider, msg, { retryable: code === 'rate' || code === 'unavailable', status, ...extra });
}

/** A semaphore: at most `n` requests to a provider at once (ElevenLabs allows 2 on most plans). */
export function limiter(n = 2) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, ok, fail } = queue.shift();
    fn().then(ok, fail).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((ok, fail) => (queue.push({ fn, ok, fail }), next()));
}

const sleep = (ms, signal) =>
  new Promise((ok, fail) => {
    const t = setTimeout(ok, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), fail(new GatewayError('cancelled', '', 'cancelled'))), { once: true });
  });

/**
 * The HTTP client a driver gets: base URL, auth headers, retries on 429/5xx (Retry-After honoured, at
 * most `retries` times), a timeout per request, and the driver's own error parser.
 */
export function httpClient({ provider, base, headers = {}, fetch: f = globalThis.fetch, retries = 3, timeoutMs = 120000, parseError, limit = limiter(4), signal, hosts }) {
  const allowed = hosts ? new Set(hosts) : null;
  const go = async (path, init = {}) => {
    const url = /^https?:\/\//.test(path) ? path : `${base.replace(/\/+$/, '')}${path}`;
    const host = new URL(url).host;
    // The provider's own hosts only — except the files it hands back (its CDN), and only over HTTPS.
    if (allowed && !allowed.has(host) && !(init.anyHost && url.startsWith('https://'))) throw new GatewayError('bad_request', provider, `${provider}: refusing to call ${host} (not one of the provider's hosts)`);
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? timeoutMs);
      signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
      let res;
      try {
        res = await f(url, { ...init, headers: { ...(init.auth === false ? {} : headers), ...(init.headers ?? {}) }, signal: ctrl.signal });
      } catch (e) {
        clearTimeout(t);
        if (signal?.aborted) throw new GatewayError('cancelled', provider, 'cancelled');
        if (attempt < retries) {
          await sleep(1000 * 2 ** attempt, signal);
          continue;
        }
        throw new GatewayError(ctrl.signal.aborted ? 'timeout' : 'unavailable', provider, `${provider} is not answering (${e.cause?.code ?? e.message})`, { retryable: true });
      }
      clearTimeout(t);
      if (res.ok || (init.accept && init.accept.includes(res.status))) return res;
      const text = await res.text().catch(() => '');
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      const err = parseError?.(res.status, body, text, res.headers) ?? errorFor(provider, res.status, text);
      if (err.retryable && attempt < retries) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt, signal);
        continue;
      }
      throw err;
    }
  };
  return {
    base,
    request: (path, init) => limit(() => go(path, init)),
    async json(path, init = {}) {
      const res = await this.request(path, { ...init, ...(init.json !== undefined ? { method: init.method ?? 'POST', body: JSON.stringify(init.json), headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } } : {}) });
      return res.json();
    },
    async bytes(path, init) {
      const res = await this.request(path, init);
      return { bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers, status: res.status };
    },
  };
}

/**
 * Poll until `check` says done: { done: true, value } — or throws. Progress goes to `onProgress`.
 * Waits `everyMs` between tries (growing to 3× on long jobs), up to `timeoutMs`.
 */
export async function pollUntil(check, { everyMs = 3000, timeoutMs = 20 * 60_000, signal, onProgress } = {}) {
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    const r = await check(i);
    if (r.done) return r.value;
    onProgress?.(r);
    if (Date.now() - t0 > timeoutMs) throw new GatewayError('timeout', '', `still not finished after ${Math.round(timeoutMs / 60000)} minutes`);
    await sleep(Math.min(everyMs * (1 + Math.floor(i / 20)), everyMs * 3), signal);
  }
}

/** What an audio file is, by its first bytes (providers' Content-Types are not always right). */
export function sniffAudio(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const s = String.fromCharCode(...b.slice(0, 4));
  if (s === 'RIFF') return 'wav';
  if (s === 'fLaC') return 'flac';
  if (s === 'OggS') return 'ogg';
  if (s.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

/** Raw 16-bit little-endian PCM → a WAV file (for providers that stream PCM). */
export function wavFromPcm16(pcm, sampleRate = 48000, channels = 2) {
  const data = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  const out = new Uint8Array(44 + data.length);
  const dv = new DataView(out.buffer);
  const w = (o, t) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, 36 + data.length, true);
  w(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

export const base64ToBytes = (b64) => Uint8Array.from(atob(String(b64).replace(/\s+/g, '')), (c) => c.charCodeAt(0));

/** The song's audio the studio sent (context_audio): bytes and what it is. */
export async function contextAudio(scp, fetchImpl = globalThis.fetch) {
  const uri = scp.context_audio?.mix_uri;
  if (!uri) return null;
  let bytes;
  if (uri.startsWith('data:')) bytes = base64ToBytes(uri.slice(uri.indexOf(',') + 1));
  else if (uri.startsWith('file:')) {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    bytes = new Uint8Array(readFileSync(fileURLToPath(uri)));
  } else bytes = new Uint8Array(await (await fetchImpl(uri)).arrayBuffer());
  return { bytes, format: sniffAudio(bytes) ?? 'wav', fromBar: scp.context_audio.from_bar ?? scp.scope?.from_bar ?? 1 };
}

// ---------------------------------------------------------------- the brief

const bpb = (scp) => Number(String(scp.song?.meter ?? '4/4').split('/')[0]) || 4;
export const secondsPerBar = (scp) => (bpb(scp) * 60) / (scp.song?.bpm || 120);

/** The scope in seconds: from the song start, and long. */
export function scopeTimes(scp) {
  const from = scp.scope?.from_bar ?? 1;
  const to = scp.scope?.to_bar ?? from + (scp.song?.length_bars ?? 8);
  const spb = secondsPerBar(scp);
  return { start: (from - 1) * spb, seconds: Math.max(1, (to - from) * spb), fromBar: from, toBar: to, bars: to - from };
}

/** "D minor" for "Dm". */
export const keyWords = (key = '') => {
  const m = /^([A-G][#b]?)(m)?$/.exec(String(key).trim());
  return m ? `${m[1]} ${m[2] ? 'minor' : 'major'}` : '';
};

/** The style in words: the request, the intent, the soft style constraints. */
export function styleText(scp, request = {}) {
  const parts = [request.text, request.style, scp.intent?.text, scp.intent?.instrument, ...(scp.constraints?.soft?.style ?? [])].filter(Boolean);
  return [...new Set(parts.map((p) => String(p).trim()).filter(Boolean))].join(', ');
}

/** Style plus tempo and key in words: for providers without fields for them. */
export function promptText(scp, request = {}, { tempo = true, key = true } = {}) {
  return [styleText(scp, request), tempo && scp.song?.bpm ? `${Math.round(scp.song.bpm)} bpm` : '', key ? keyWords(scp.song?.key) : ''].filter(Boolean).join(', ');
}

const SECTION = { intro: 'Intro', verse: 'Verse', prechorus: 'Pre-Chorus', pre_chorus: 'Pre-Chorus', chorus: 'Chorus', bridge: 'Bridge', outro: 'Outro', solo: 'Solo', break: 'Break', interlude: 'Interlude' };
export const sectionName = (kind) => SECTION[kind] ?? (kind ? kind[0].toUpperCase() + kind.slice(1) : 'Verse');

/** The sections in scope, with their length in ms and their lyric lines. */
export function sectionsInScope(scp) {
  const s = scopeTimes(scp);
  const lines = scp.lyrics?.lines ?? [];
  const out = [];
  for (const sec of (scp.sections ?? []).slice().sort((a, b) => a.from_bar - b.from_bar)) {
    const from = Math.max(sec.from_bar, s.fromBar);
    const to = Math.min(sec.from_bar + sec.bars, s.toBar);
    if (to <= from) continue;
    out.push({ id: sec.id, name: sectionName(sec.kind), kind: sec.kind, bars: to - from, ms: Math.round((to - from) * secondsPerBar(scp) * 1000), energy: sec.energy, lines: lines.filter((l) => l.section_id === sec.id).map((l) => l.text).filter(Boolean) });
  }
  return out;
}

/** Lyrics with section markers ("[Verse]\n…"), or null for an instrumental. */
export function lyricsWithMarkers(scp, request = {}) {
  if (typeof request.lyrics === 'string' && request.lyrics.trim()) return request.lyrics;
  const lines = scp.lyrics?.lines ?? [];
  if (!lines.some((l) => l.text?.trim())) return null;
  const secs = sectionsInScope(scp);
  if (secs.some((s) => s.lines.length)) return secs.filter((s) => s.lines.length).map((s) => `[${s.name}]\n${s.lines.join('\n')}`).join('\n\n');
  return lines.map((l) => l.text).filter(Boolean).join('\n');
}

/**
 * Names of artists, songs or labels are refused by some services (ElevenLabs) and risky for all: a
 * prompt that says "in the style of …" or "like <Name>" is flagged before it is sent.
 */
export function promptRisks(text = '') {
  const m = /\b(in the style of|like|sounds? like|alla|come|stile di)\s+([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,3})/.exec(text);
  return m ? `“${m[2]}” looks like the name of an artist or a song: music services refuse those, describe the sound instead (genre, instruments, mood, era)` : null;
}

/** The engine's side: write the bytes to a temporary file and give its file:// URI. */
export async function writeAudio(bytes, prefix = 'omep-cloud') {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const format = sniffAudio(bytes) ?? 'wav';
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${format}`);
  fs.writeFileSync(file, bytes);
  return { uri: pathToFileURL(file).href, format };
}
