// SoundCloud (SPEC v0.6 G6): OAuth 2.1 with PKCE through secure.soundcloud.com — the user's own app, whose
// client secret stays in the local OpenBand — then one multipart POST /tracks with the master (FLAC), the
// artwork and the metadata: licence (every Creative Commons one, in SoundCloud's words), sharing, tags.
import fs from 'node:fs';
import { bearer } from './oauth.mjs';

export const soundcloud = {
  id: 'soundcloud',
  name: 'SoundCloud',
  auth: 'oauth',
  fields: [
    { key: 'client_id', label: 'Client ID (your app on soundcloud.com/you/apps)', secret: false },
    { key: 'client_secret', label: 'Client secret', secret: true },
  ],
  help: 'https://soundcloud.com/you/apps',
  endpoints: (mock) => ({
    authorize: mock ? `${mock}/soundcloud/authorize` : 'https://secure.soundcloud.com/authorize',
    token: mock ? `${mock}/soundcloud/oauth/token` : 'https://secure.soundcloud.com/oauth/token',
    api: mock ? `${mock}/soundcloud/api` : 'https://api.soundcloud.com',
  }),
  configured: (cfg) => !!(cfg.client_id && cfg.client_secret),
  scopes: [],

  async upload({ store, pkg, files, endpoints, onProgress, fetchImpl = fetch }) {
    const audio = files.find((f) => f.role === 'audio') ?? files[0];
    const art = files.find((f) => f.role === 'artwork');
    if (!audio) throw new Error('SoundCloud: nothing to upload');
    let token = await bearer(store, 'soundcloud', endpoints, { fetchImpl });
    const form = async () => {
      const body = new FormData();
      for (const [k, v] of Object.entries(pkg.track ?? {})) if (v !== undefined && v !== null && v !== '') body.append(`track[${k}]`, String(v));
      body.append('track[asset_data]', await fs.openAsBlob(audio.path, { type: audio.type }), audio.name);
      if (art) body.append('track[artwork_data]', await fs.openAsBlob(art.path, { type: art.type }), art.name);
      return body;
    };
    onProgress?.(0.05, audio.name);
    for (let renewed = false; ; renewed = true) {
      const res = await fetchImpl(`${endpoints.api}/tracks`, { method: 'POST', headers: { authorization: `OAuth ${token}`, accept: 'application/json' }, body: await form() });
      if (res.status === 401 && !renewed) {
        token = await bearer(store, 'soundcloud', endpoints, { force: true, fetchImpl });
        continue;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`SoundCloud refused the upload (${res.status}${json.errors?.[0]?.error_message ? `: ${json.errors[0].error_message}` : json.error ? `: ${json.error}` : ''})`);
      onProgress?.(1, audio.name);
      return { id: String(json.id), url: json.permalink_url ?? `https://soundcloud.com/tracks/${json.id}` };
    }
  },

  async status({ id, endpoints, store, fetchImpl = fetch }) {
    const token = store ? await bearer(store, 'soundcloud', endpoints, { fetchImpl }).catch(() => null) : null;
    const res = await fetchImpl(`${endpoints.api}/tracks/${encodeURIComponent(id)}`, { headers: token ? { authorization: `OAuth ${token}` } : {} });
    const json = res.ok ? await res.json() : null;
    return json ? { state: json.state === 'finished' ? 'live' : json.state ?? 'processing', url: json.permalink_url } : { state: 'missing' };
  },
};
