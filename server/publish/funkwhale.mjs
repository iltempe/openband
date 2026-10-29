// Funkwhale (SPEC v0.6 G6): a federated server, the user's own instance. Its app is created by the user in
// the instance's settings (an app made without signing in can't get write scopes), with the redirect URL
// OpenBand shows and the scopes read:libraries write:libraries; then OAuth (PKCE too, which Funkwhale
// accepts), a library of the user's with the visibility asked (everyone, instance, me — libraries can't be
// made through the API), and POST /api/v1/uploads/ with import_status "pending", followed until the track
// is there. Instances differ: some want MusicBrainz metadata; a licence code the instance doesn't know is
// dropped (and said), not a failed upload.
import fs from 'node:fs';
import { bearer } from './oauth.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const instanceOf = (cfg) => String(cfg.instance ?? '').trim().replace(/\/+$/, '');
const PRIVACY = { public: 'everyone', unlisted: 'instance', private: 'me' };

export const funkwhale = {
  id: 'funkwhale',
  name: 'Funkwhale',
  auth: 'oauth',
  fields: [
    { key: 'instance', label: 'Your instance (https://…)', secret: false },
    { key: 'client_id', label: 'Application ID (Settings → Applications → New, scopes read:libraries write:libraries)', secret: false },
    { key: 'client_secret', label: 'Application secret', secret: true },
  ],
  help: 'https://docs.funkwhale.audio/developer/api/authentication.html',
  // The instance is the user's: in tests, the mock stands for it.
  endpoints: (mock, cfg = {}) => {
    const base = mock ? `${mock}/funkwhale` : instanceOf(cfg);
    return { base, authorize: `${base}/authorize`, token: `${base}/api/v1/oauth/token/`, tokenV2: `${base}/api/v2/oauth/token`, api: `${base}/api/v1` };
  },
  configured: (cfg) => !!(instanceOf(cfg) && /^https?:\/\//.test(instanceOf(cfg)) && cfg.client_id && cfg.client_secret),
  scopes: ['read:libraries', 'write:libraries'],

  /** The token, at /api/v1/oauth/token/ (Funkwhale 1.x), or /api/v2/oauth/token where that is the one. */
  async exchange({ token, clientId, clientSecret, redirectUri, code, verifier }, fetchImpl = fetch) {
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier });
    for (const url of [token, token.replace(/\/api\/v1\/oauth\/token\/$/, '/api/v2/oauth/token')]) {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form });
      if (res.status === 404) continue;
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.access_token) throw new Error(`Funkwhale refused the sign-in (${res.status}${json?.error ? `: ${json.error_description ?? json.error}` : ''})`);
      return { access: json.access_token, refresh: json.refresh_token, expires_at: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : null };
    }
    throw new Error('This server has no Funkwhale token endpoint: check the instance address');
  },

  async upload({ store, pkg, files, privacy = 'public', endpoints, onProgress, fetchImpl = fetch, retryDelay = 1000 }) {
    const audio = files.find((f) => f.role === 'audio') ?? files[0];
    if (!audio) throw new Error('Funkwhale: nothing to upload');
    let token = await bearer(store, 'funkwhale', endpoints, { fetchImpl });
    const call = async (url, init = {}) => {
      for (let renewed = false; ; renewed = true) {
        const res = await fetchImpl(url, { ...init, headers: { accept: 'application/json', ...init.headers, authorization: `Bearer ${token}` } });
        if (res.status === 401 && !renewed) {
          token = await bearer(store, 'funkwhale', endpoints, { force: true, fetchImpl });
          continue;
        }
        return res;
      }
    };
    // The user's library with the visibility asked.
    const level = PRIVACY[privacy] ?? 'everyone';
    const libs = await call(`${endpoints.api}/libraries/?scope=me&page_size=100`);
    if (!libs.ok) throw new Error(`Funkwhale: could not list your libraries (${libs.status})`);
    const list = (await libs.json()).results ?? [];
    const lib = list.find((l) => l.privacy_level === level && /openband/i.test(l.name ?? '')) ?? list.find((l) => l.privacy_level === level);
    if (!lib) throw new Error(`Funkwhale: you have no library visible to "${level}" on this instance — make one there (Library → Add content), then publish again`);

    let dropped = null;
    const send = async (meta) => {
      const body = new FormData();
      body.append('audio_file', await fs.openAsBlob(audio.path, { type: audio.type }), audio.name);
      body.append('library', lib.uuid);
      body.append('import_status', 'pending');
      body.append('import_reference', String(pkg.import_reference ?? '').slice(0, 50));
      body.append('import_metadata', JSON.stringify(meta));
      return call(`${endpoints.api}/uploads/`, { method: 'POST', body });
    };
    onProgress?.(0.05, audio.name);
    let res = await send(pkg.metadata);
    let json = await res.json().catch(() => ({}));
    // A licence code the instance doesn't know: once more without it.
    if (res.status === 400 && pkg.metadata?.license && JSON.stringify(json).includes('license')) {
      dropped = pkg.metadata.license;
      const { license: _drop, ...rest } = pkg.metadata;
      res = await send(rest);
      json = await res.json().catch(() => ({}));
    }
    if (!res.ok) throw new Error(`Funkwhale refused the upload (${res.status}: ${JSON.stringify(json).slice(0, 200)})`);
    onProgress?.(0.6, 'processing');
    // The instance imports it in the background: follow it until the track is there (or a while).
    let up = json;
    for (let i = 0; i < 30 && up.import_status === 'pending'; i++) {
      await wait(retryDelay);
      const q = await call(`${endpoints.api}/uploads/?page_size=50&ordering=-creation_date`);
      const found = q.ok ? ((await q.json()).results ?? []).find((u) => u.uuid === json.uuid) : null;
      if (found) up = found;
    }
    if (up.import_status === 'errored' || up.import_status === 'skipped') throw new Error(`Funkwhale could not import it (${up.import_status}: ${JSON.stringify(up.import_details ?? {}).slice(0, 200)})`);
    onProgress?.(1, audio.name);
    const url = up.track?.id ? `${endpoints.base}/library/tracks/${up.track.id}` : `${endpoints.base}/library`;
    return { id: json.uuid, url, ...(up.import_status !== 'finished' ? { note: 'Still being imported by the instance' } : {}), ...(dropped ? { note: `The instance didn't know the licence "${dropped}": uploaded without it — set it there` } : {}) };
  },

  async status({ id, endpoints, store, fetchImpl = fetch }) {
    const token = await bearer(store, 'funkwhale', endpoints, { fetchImpl }).catch(() => null);
    const res = await fetchImpl(`${endpoints.api}/uploads/?page_size=50&ordering=-creation_date`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const up = res.ok ? ((await res.json()).results ?? []).find((u) => u.uuid === id) : null;
    return up ? { state: up.import_status === 'finished' ? 'live' : up.import_status, url: up.track?.id ? `${endpoints.base}/library/tracks/${up.track.id}` : undefined } : { state: 'missing' };
  },
};
