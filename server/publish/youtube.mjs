// YouTube (SPEC v0.6 G6): OAuth 2.0 with Google (the user's own OAuth client, a desktop one: the secret
// stays in the local OpenBand), then the Data API's resumable upload: the session opened with the video's
// snippet and status, the MP4 sent in 8 MiB pieces, and after a failure the upload asks how much arrived
// and goes on from there. A video upload costs quota (about 100 a day per project).
import fs from 'node:fs';
import { bearer } from './oauth.mjs';

const CHUNK = 8 * 1024 * 1024; // a multiple of 256 KiB, as the API wants
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const youtube = {
  id: 'youtube',
  name: 'YouTube',
  auth: 'oauth',
  fields: [
    { key: 'client_id', label: 'OAuth client ID (Google Cloud, a "Desktop app" client with the YouTube Data API)', secret: false },
    { key: 'client_secret', label: 'Client secret', secret: true },
  ],
  help: 'https://console.cloud.google.com/apis/credentials',
  endpoints: (mock) => ({
    authorize: mock ? `${mock}/google/auth` : 'https://accounts.google.com/o/oauth2/v2/auth',
    token: mock ? `${mock}/google/token` : 'https://oauth2.googleapis.com/token',
    upload: mock ? `${mock}/youtube/upload/youtube/v3/videos` : 'https://www.googleapis.com/upload/youtube/v3/videos',
    api: mock ? `${mock}/youtube/youtube/v3` : 'https://www.googleapis.com/youtube/v3',
  }),
  configured: (cfg) => !!(cfg.client_id && cfg.client_secret),
  scopes: ['https://www.googleapis.com/auth/youtube.upload'],
  // A refresh token, and asked again for it each time the user signs in.
  authorizeExtra: { access_type: 'offline', prompt: 'consent' },

  async upload({ store, pkg, files, endpoints, onProgress, fetchImpl = fetch, retryDelay = 1000 }) {
    const video = files.find((f) => f.role === 'video') ?? files[0];
    if (!video) throw new Error('YouTube: the video is missing');
    let token = await bearer(store, 'youtube', endpoints, { fetchImpl });
    // One call with the bearer, renewed once if Google says it expired.
    const call = async (url, init) => {
      for (let renewed = false; ; renewed = true) {
        const res = await fetchImpl(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
        if (res.status === 401 && !renewed) {
          token = await bearer(store, 'youtube', endpoints, { force: true, fetchImpl });
          continue;
        }
        return res;
      }
    };
    const init = await call(`${endpoints.upload}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(video.size) },
      body: JSON.stringify({ snippet: pkg.snippet, status: pkg.status }),
    });
    if (!init.ok) throw new Error(`YouTube refused the upload (${init.status}${await reason(init)})`);
    const session = init.headers.get('location');
    if (!session) throw new Error('YouTube gave no upload session');

    const fd = await fs.promises.open(video.path, 'r');
    try {
      let at = 0;
      let failures = 0;
      for (;;) {
        const n = Math.min(CHUNK, video.size - at);
        const piece = Buffer.alloc(n);
        await fd.read(piece, 0, n, at);
        let res;
        try {
          res = await call(session, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${at}-${at + n - 1}/${video.size}` }, body: piece });
        } catch {
          res = null;
        }
        if (res && (res.status === 200 || res.status === 201)) {
          const json = await res.json();
          onProgress?.(1, video.name);
          return { id: json.id, url: `https://www.youtube.com/watch?v=${json.id}` };
        }
        if (res && res.status === 308) {
          at = nextByte(res.headers.get('range'));
          failures = 0;
          onProgress?.(at / video.size, video.name);
          continue;
        }
        // Interrupted (network, 5xx): ask how much arrived, and go on from there.
        if ((!res || res.status >= 500) && failures < 5) {
          failures++;
          await wait(retryDelay * 2 ** (failures - 1));
          const q = await call(session, { method: 'PUT', headers: { 'content-range': `bytes */${video.size}` } }).catch(() => null);
          if (q && (q.status === 200 || q.status === 201)) {
            const json = await q.json();
            return { id: json.id, url: `https://www.youtube.com/watch?v=${json.id}` };
          }
          if (q && q.status === 308) at = nextByte(q.headers.get('range'));
          continue;
        }
        throw new Error(`YouTube: the upload stopped (${res?.status ?? 'no answer'}${res ? await reason(res) : ''})`);
      }
    } finally {
      await fd.close();
    }
  },

  async status({ id, endpoints, store, fetchImpl = fetch }) {
    const token = await bearer(store, 'youtube', endpoints, { fetchImpl }).catch(() => null);
    const res = await fetchImpl(`${endpoints.api}/videos?part=status,processingDetails&id=${encodeURIComponent(id)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const item = res.ok ? (await res.json()).items?.[0] : null;
    return item ? { state: item.status?.uploadStatus === 'processed' ? 'live' : item.status?.uploadStatus ?? 'processing', url: `https://www.youtube.com/watch?v=${id}` } : { state: 'missing' };
  },
};

/** "bytes=0-1048575" → 1048576; no Range header: nothing has arrived. */
const nextByte = (range) => (range ? Number(/-(\d+)$/.exec(range)?.[1] ?? -1) + 1 : 0);

async function reason(res) {
  const j = await res.json().catch(() => null);
  const e = j?.error;
  const why = e?.errors?.[0]?.reason ?? e?.status;
  return e ? `: ${why ? `${why} — ` : ''}${e.message ?? ''}` : '';
}
