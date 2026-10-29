// Mixcloud (SPEC v0.6 G6): OAuth 2.0 with the user's own app (the code exchanged for a token with the
// client secret, in the local OpenBand; Mixcloud tokens don't expire and it returns no state, so the
// callback is per platform), then one multipart POST /upload/ with the MP3, the picture (≤ 10 MB), the
// name, the description and at most 5 tags. When Mixcloud says "too many requests", it waits as told.
import fs from 'node:fs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const mixcloud = {
  id: 'mixcloud',
  name: 'Mixcloud',
  auth: 'oauth',
  redirectPerPlatform: true,
  fields: [
    { key: 'client_id', label: 'Client ID (your app on mixcloud.com/developers)', secret: false },
    { key: 'client_secret', label: 'Client secret', secret: true },
  ],
  help: 'https://www.mixcloud.com/developers/create/',
  endpoints: (mock) => ({
    authorize: mock ? `${mock}/mixcloud/oauth/authorize` : 'https://www.mixcloud.com/oauth/authorize',
    token: mock ? `${mock}/mixcloud/oauth/access_token` : 'https://www.mixcloud.com/oauth/access_token',
    api: mock ? `${mock}/mixcloud/api` : 'https://api.mixcloud.com',
    site: mock ? `${mock}/mixcloud/site` : 'https://www.mixcloud.com',
  }),
  configured: (cfg) => !!(cfg.client_id && cfg.client_secret),
  scopes: [],

  /** Mixcloud's exchange is a GET, and its token has no expiry and no refresh. */
  async exchange({ token, clientId, clientSecret, redirectUri, code }, fetchImpl = fetch) {
    const u = new URL(token);
    for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, client_secret: clientSecret, code })) u.searchParams.set(k, v);
    const res = await fetchImpl(u);
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.access_token) throw new Error(`Mixcloud refused the sign-in (${res.status}${json?.error ? `: ${json.error.message ?? json.error}` : ''})`);
    return { access: json.access_token, refresh: null, expires_at: null };
  },

  async upload({ cfg, pkg, files, endpoints, onProgress, fetchImpl = fetch, retryDelay = 1000 }) {
    if (!cfg.access) throw new Error('Not signed in to mixcloud: sign in from Release → Accounts first');
    const audio = files.find((f) => f.role === 'audio') ?? files[0];
    const picture = files.find((f) => f.role === 'artwork');
    if (!audio) throw new Error('Mixcloud: nothing to upload');
    const form = async () => {
      const body = new FormData();
      body.append('mp3', await fs.openAsBlob(audio.path, { type: 'audio/mpeg' }), audio.name);
      if (picture) body.append('picture', await fs.openAsBlob(picture.path, { type: picture.type }), picture.name);
      body.append('name', pkg.name);
      if (pkg.description) body.append('description', pkg.description);
      (pkg.tags ?? []).slice(0, 5).forEach((t, i) => body.append(`tags-${i}-tag`, t));
      return body;
    };
    onProgress?.(0.05, audio.name);
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${endpoints.api}/upload/?access_token=${encodeURIComponent(cfg.access)}`, { method: 'POST', body: await form() });
      const json = await res.json().catch(() => ({}));
      if (json.error?.type === 'RateLimitException' && attempt < 2) {
        await wait(Math.min(60, Number(json.error.retry_after) || 5) * retryDelay);
        continue;
      }
      if (json.error?.type === 'OAuthException') throw new Error('Mixcloud: the sign-in is no longer valid — sign in again from Release → Accounts');
      if (!res.ok || !json.result?.success) throw new Error(`Mixcloud refused the upload (${res.status}${json.error ? `: ${json.error.message ?? json.error.type}` : ''})`);
      onProgress?.(1, audio.name);
      return { id: json.result.key, url: `${endpoints.site}${json.result.key}` };
    }
  },

  async status({ id, endpoints, fetchImpl = fetch }) {
    const res = await fetchImpl(`${endpoints.api}${id}`);
    return res.ok ? { state: 'live', url: `${endpoints.site}${id}` } : { state: 'processing' };
  },
};
