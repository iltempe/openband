// Wikimedia Commons (SPEC v0.6 G6): OAuth 2.0 with PKCE through meta.wikimedia.org (the user's own
// consumer, non-confidential: no secret needed), then the MediaWiki API's chunked upload — chunks to the
// stash, each retried where it failed, then the file published with the description page the studio wrote
// ({{Information}} and the licence template). Free licences only; the studio checks before.
import fs from 'node:fs';
import { bearer } from './oauth.mjs';

const CHUNK = 4 * 1024 * 1024;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const commons = {
  id: 'wikimedia',
  name: 'Wikimedia Commons',
  auth: 'oauth',
  fields: [
    { key: 'client_id', label: 'OAuth 2.0 client (consumer) key', secret: false },
    { key: 'client_secret', label: 'Client secret (only for a confidential consumer)', secret: true, optional: true },
    { key: 'access_token', label: 'Or: the access token of an owner-only consumer (no sign-in needed)', secret: true, optional: true },
  ],
  help: 'https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose/oauth2',
  endpoints: (mock) => {
    const meta = mock ? `${mock}/meta` : 'https://meta.wikimedia.org';
    return { authorize: `${meta}/w/rest.php/oauth2/authorize`, token: `${meta}/w/rest.php/oauth2/access_token`, api: mock ? `${mock}/commons/w/api.php` : 'https://commons.wikimedia.org/w/api.php' };
  },
  configured: (cfg) => !!(cfg.client_id || cfg.access),
  scopes: [],

  async upload({ store, pkg, files, endpoints, onProgress, fetchImpl = fetch, retryDelay = 1000 }) {
    const f = files[0];
    if (!f) throw new Error('Wikimedia Commons: nothing to upload');
    let token = await bearer(store, 'wikimedia', endpoints, { fetchImpl });
    // One API call, with the bearer; renewed once if the wiki says it expired.
    const api = async (params, { file, method = 'POST' } = {}) => {
      for (let renewed = false; ; renewed = true) {
        let res;
        if (method === 'GET') res = await fetchImpl(`${endpoints.api}?${new URLSearchParams({ ...params, format: 'json' })}`, { headers: { authorization: `Bearer ${token}` } });
        else {
          const body = new FormData();
          for (const [k, v] of Object.entries({ ...params, format: 'json' })) body.append(k, String(v));
          if (file) body.append('chunk', new Blob([file.data]), file.name);
          res = await fetchImpl(endpoints.api, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });
        }
        const json = await res.json().catch(() => ({ error: { code: `http-${res.status}`, info: res.statusText } }));
        const expired = res.status === 401 || /mwoauth-invalid-authorization|invalid_token/.test(json?.error?.code ?? '');
        if (expired && !renewed) {
          token = await bearer(store, 'wikimedia', endpoints, { force: true, fetchImpl });
          continue;
        }
        if (!res.ok && !json.error) json.error = { code: `http-${res.status}`, info: res.statusText };
        return json;
      }
    };
    const csrf = (await api({ action: 'query', meta: 'tokens' }, { method: 'GET' }))?.query?.tokens?.csrftoken;
    if (!csrf || csrf === '+\\') throw new Error('Wikimedia Commons did not give an edit token: sign in again');

    const data = fs.readFileSync(f.path);
    let filekey;
    for (let offset = 0; offset < data.length; ) {
      const chunk = data.subarray(offset, Math.min(offset + CHUNK, data.length));
      const params = { action: 'upload', stash: 1, filename: pkg.filename, filesize: data.length, offset, ignorewarnings: 1, token: csrf, ...(filekey ? { filekey } : {}) };
      let r;
      for (let attempt = 0; ; attempt++) {
        r = await api(params, { file: { data: chunk, name: pkg.filename } });
        if (!r.error) break;
        // A failed chunk is sent again from the same offset (the stash keeps what arrived).
        if (attempt < 3 && /^http-5|internal_api_error|stashfailed|backend-fail/.test(r.error.code)) {
          await wait(retryDelay * 2 ** attempt);
          continue;
        }
        throw new Error(`Wikimedia Commons: ${r.error.info || r.error.code}`);
      }
      filekey = r.upload?.filekey ?? filekey;
      offset = r.upload?.result === 'Continue' ? Number(r.upload.offset) : data.length;
      onProgress?.(Math.min(0.95, offset / data.length), pkg.filename);
    }
    const done = await api({ action: 'upload', filename: pkg.filename, filekey, comment: pkg.comment, text: pkg.text, token: csrf });
    if (done.error) throw new Error(`Wikimedia Commons: ${done.error.info || done.error.code}`);
    if (done.upload?.result !== 'Success') {
      const w = done.upload?.warnings ?? {};
      throw new Error(`Wikimedia Commons did not publish it: ${w.exists ? `a file named "${pkg.filename}" exists already — change the title` : w.duplicate ? 'the same file is already on Commons' : JSON.stringify(w)}`);
    }
    onProgress?.(1, pkg.filename);
    const title = `File:${done.upload.filename}`;
    return { id: title, url: done.upload.imageinfo?.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}` };
  },

  async status({ id, endpoints, fetchImpl = fetch }) {
    const res = await fetchImpl(`${endpoints.api}?${new URLSearchParams({ action: 'query', titles: id, prop: 'imageinfo', iiprop: 'url', format: 'json' })}`);
    const pages = Object.values((await res.json().catch(() => ({})))?.query?.pages ?? {});
    const info = pages[0]?.imageinfo?.[0];
    return info ? { state: 'live', url: info.descriptionurl } : { state: 'missing' };
  },
};
