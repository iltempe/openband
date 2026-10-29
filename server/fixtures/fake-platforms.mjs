// A stand-in for the publishing platforms (SPEC v0.6 G6 acceptance: every adapter tested against a mock of
// its endpoints). Internet Archive's S3 API (keys, auto-made items, x-archive-meta headers, 503 SlowDown) and
// Wikimedia: OAuth 2.0 with PKCE (S256 checked, single-use refresh tokens, tokens that expire early) and the
// MediaWiki chunked upload (offsets checked, a chunk that fails once). /__mock/state shows what arrived;
// POST /__mock/config sets failures. Run alone: node server/fixtures/fake-platforms.mjs [port]
import crypto from 'node:crypto';
import http from 'node:http';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rnd = () => crypto.randomBytes(12).toString('hex');

export function createFakePlatforms({ archiveKeys = { access: 'ACCESS', secret: 'SECRET' }, wikimediaClient = 'commons-client', apps = { soundcloud: { id: 'sc-client', secret: 'sc-secret' }, google: { id: 'yt-client', secret: 'yt-secret' }, mixcloud: { id: 'mc-client', secret: 'mc-secret' }, funkwhale: { id: 'fw-client', secret: 'fw-secret' } } } = {}) {
  const state = {
    archive: {},
    commons: { files: {}, stash: {} },
    oauth: { codes: {}, access: {}, refresh: {} },
    config: { archive503: 0, expireNext: false, failChunk: null, scExpireNext: false, ytFailAt: null, ytExpireNext: false, mcRateLimit: 0, fwV2Only: false, fwLicenses: ['cc0-1.0', 'cc-by-4.0', 'cc-by-sa-4.0', 'cc-by-nc-4.0', 'cc-by-nc-sa-4.0', 'cc-by-nd-4.0', 'cc-by-nc-nd-4.0'] },
    soundcloud: { tracks: [] },
    youtube: { sessions: {}, videos: [] },
    mixcloud: { tokens: {}, uploads: [], codes: {} },
    funkwhale: { uploads: [], polls: 0 },
    log: [],
  };
  const body = (req) => new Promise((ok) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => ok(Buffer.concat(parts)));
  });
  const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
  const issue = () => {
    const access = rnd();
    const refresh = rnd();
    state.oauth.access[access] = { expires: Date.now() + 4 * 3600e3 };
    state.oauth.refresh[refresh] = true;
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 14400 };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    state.log.push(`${req.method} ${p}`);
    if (p === '/__mock/state') return json(res, 200, state);
    if (p === '/__mock/config') return Object.assign(state.config, JSON.parse(String(await body(req)) || '{}')), json(res, 200, state.config);

    // ---- Internet Archive
    const s3 = /^\/archive-s3\/([^/]+)\/(.+)$/.exec(p);
    if (s3 && req.method === 'PUT') {
      const data = await body(req);
      if (req.headers.authorization !== `LOW ${archiveKeys.access}:${archiveKeys.secret}`) return res.writeHead(403).end('<Error><Code>InvalidAccessKeyId</Code><Message>bad keys</Message></Error>');
      if (state.config.archive503 > 0) {
        state.config.archive503--;
        return res.writeHead(503).end('<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>');
      }
      const [, id, file] = s3;
      let item = state.archive[id];
      if (!item) {
        if (req.headers['x-archive-auto-make-bucket'] !== '1') return res.writeHead(404).end('<Error><Code>NoSuchBucket</Code><Message>no item</Message></Error>');
        const meta = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const m = /^x-archive-meta(\d*)-(.+)$/.exec(k);
          if (!m) continue;
          const value = /^uri\((.*)\)$/.exec(String(v)) ? decodeURIComponent(/^uri\((.*)\)$/.exec(String(v))[1]) : String(v);
          meta[m[2]] = m[1] ? [...(meta[m[2]] ?? []), value] : value;
        }
        item = state.archive[id] = { meta, files: {} };
      }
      item.files[decodeURIComponent(file)] = { size: data.length, type: req.headers['content-type'], sha1: crypto.createHash('sha1').update(data).digest('hex') };
      return res.writeHead(200).end();
    }
    const md = /^\/archive\/metadata\/(.+)$/.exec(p);
    if (md) {
      const item = state.archive[decodeURIComponent(md[1])];
      return json(res, 200, item ? { metadata: { identifier: md[1], ...item.meta }, files: Object.keys(item.files).map((name) => ({ name })) } : {});
    }

    // ---- Wikimedia OAuth 2.0
    if (p === '/meta/w/rest.php/oauth2/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== wikimediaClient) return res.writeHead(400).end('unknown client');
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return res.writeHead(400).end('PKCE required');
      const code = rnd();
      state.oauth.codes[code] = { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') };
      // The user approves at once.
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (p === '/meta/w/rest.php/oauth2/access_token' && req.method === 'POST') {
      const f = new URLSearchParams(String(await body(req)));
      if (f.get('client_id') !== wikimediaClient) return json(res, 401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = state.oauth.codes[f.get('code')];
        delete state.oauth.codes[f.get('code')];
        if (!c || c.redirect !== f.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
        if (b64url(crypto.createHash('sha256').update(f.get('code_verifier') ?? '').digest()) !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return json(res, 200, issue());
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (!state.oauth.refresh[f.get('refresh_token')]) return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token already used' });
        delete state.oauth.refresh[f.get('refresh_token')]; // single use
        state.oauth.refreshed = (state.oauth.refreshed ?? 0) + 1;
        return json(res, 200, issue());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    // ---- Wikimedia Commons API
    if (p === '/commons/w/api.php') {
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const raw = req.method === 'POST' ? await body(req) : null;
      // Reading pages needs no sign-in.
      if (req.method === 'GET' && url.searchParams.get('prop') === 'imageinfo') {
        const f = state.commons.files[String(url.searchParams.get('titles')).replace(/^File:/, '')];
        return json(res, 200, { query: { pages: { 1: f ? { title: url.searchParams.get('titles'), imageinfo: [{ descriptionurl: f.url }] } : { missing: '' } } } });
      }
      if (!auth || !state.oauth.access[auth] || state.oauth.access[auth].expires < Date.now()) return json(res, 401, { error: { code: 'mwoauth-invalid-authorization', info: 'The authorization headers in your request are not valid: Invalid access token' } });
      if (state.config.expireNext) {
        state.config.expireNext = false;
        state.oauth.access[auth].expires = 0;
        return json(res, 401, { error: { code: 'mwoauth-invalid-authorization', info: 'Invalid access token' } });
      }
      const q = req.method === 'GET' ? url.searchParams : await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const get = (k) => (q.get(k) === null ? null : q.get(k));
      if (get('action') === 'query' && get('meta') === 'tokens') return json(res, 200, { query: { tokens: { csrftoken: 'csrf123+\\' } } });
      if (get('action') === 'upload') {
        if (get('token') !== 'csrf123+\\') return json(res, 200, { error: { code: 'badtoken', info: 'Invalid CSRF token.' } });
        if (get('stash') === '1') {
          const offset = Number(get('offset'));
          const chunk = Buffer.from(await q.get('chunk').arrayBuffer());
          if (state.config.failChunk === offset) {
            state.config.failChunk = null;
            return json(res, 503, { error: { code: 'http-503', info: 'Service Unavailable' } });
          }
          const key = get('filekey') || `stash-${rnd()}`;
          const st = (state.commons.stash[key] ??= { parts: [], size: 0, filesize: Number(get('filesize')), chunks: 0 });
          if (offset !== st.size) return json(res, 200, { error: { code: 'stashfailed', info: `offset ${offset}, expected ${st.size}` } });
          st.parts.push(chunk);
          st.size += chunk.length;
          st.chunks++;
          return json(res, 200, { upload: st.size < st.filesize ? { result: 'Continue', offset: st.size, filekey: key } : { result: 'Success', filekey: key } });
        }
        const st = state.commons.stash[get('filekey')];
        if (!st || st.size !== st.filesize) return json(res, 200, { error: { code: 'missingresult', info: 'No stashed file' } });
        const filename = String(get('filename')).replace(/ /g, '_');
        if (state.commons.files[filename]) return json(res, 200, { upload: { result: 'Warning', warnings: { exists: filename } } });
        const data = Buffer.concat(st.parts);
        const fileUrl = `http://${req.headers.host}/commons/wiki/File:${encodeURIComponent(filename)}`;
        // MediaWiki saves LF (forms send CRLF).
        state.commons.files[filename] = { size: data.length, sha1: crypto.createHash('sha1').update(data).digest('hex'), text: String(get('text')).replace(/\r\n/g, '\n'), comment: get('comment'), chunks: st.chunks, url: fileUrl };
        return json(res, 200, { upload: { result: 'Success', filename, imageinfo: { descriptionurl: fileUrl } } });
      }
      return json(res, 200, { error: { code: 'badvalue', info: 'unknown action' } });
    }
    // ---- SoundCloud and Google: OAuth 2.0 with PKCE and the app's secret
    const oauthApp = p.startsWith('/soundcloud/') ? 'soundcloud' : p.startsWith('/google/') ? 'google' : null;
    if (oauthApp && (p === '/soundcloud/authorize' || p === '/google/auth')) {
      const q = url.searchParams;
      if (q.get('client_id') !== apps[oauthApp].id) return res.writeHead(400).end('unknown client');
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return res.writeHead(400).end('PKCE required');
      if (oauthApp === 'google' && (!/youtube\.upload/.test(q.get('scope') ?? '') || q.get('access_type') !== 'offline')) return res.writeHead(400).end('scope youtube.upload and access_type=offline expected');
      const code = rnd();
      state.oauth.codes[code] = { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), app: oauthApp };
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (oauthApp && (p === '/soundcloud/oauth/token' || p === '/google/token') && req.method === 'POST') {
      const f = new URLSearchParams(String(await body(req)));
      if (f.get('client_id') !== apps[oauthApp].id || f.get('client_secret') !== apps[oauthApp].secret) return json(res, 401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = state.oauth.codes[f.get('code')];
        delete state.oauth.codes[f.get('code')];
        if (!c || c.app !== oauthApp || c.redirect !== f.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
        if (b64url(crypto.createHash('sha256').update(f.get('code_verifier') ?? '').digest()) !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return json(res, 200, issue());
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (!state.oauth.refresh[f.get('refresh_token')]) return json(res, 400, { error: 'invalid_grant' });
        delete state.oauth.refresh[f.get('refresh_token')];
        state.oauth.refreshed = (state.oauth.refreshed ?? 0) + 1;
        return json(res, 200, issue());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    const tokenOk = (header, scheme) => {
      const t = new RegExp(`^${scheme} (.+)$`).exec(header ?? '')?.[1];
      return !!t && !!state.oauth.access[t] && state.oauth.access[t].expires > Date.now() ? t : null;
    };
    const expire = (key, t) => {
      if (!state.config[key]) return false;
      state.config[key] = false;
      state.oauth.access[t].expires = 0;
      return true;
    };
    // ---- SoundCloud API
    if (p === '/soundcloud/api/tracks' && req.method === 'POST') {
      const raw = await body(req);
      const t = tokenOk(req.headers.authorization, 'OAuth');
      if (!t || expire('scExpireNext', t)) return json(res, 401, { error: 'invalid_token' });
      const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const fields = {};
      for (const [k, v] of form) fields[k] = typeof v === 'string' ? v : { name: v.name, size: v.size, type: v.type };
      const id = 1000 + state.soundcloud.tracks.length;
      state.soundcloud.tracks.push({ id, fields });
      return json(res, 201, { id, permalink_url: `http://${req.headers.host}/soundcloud/site/track-${id}` });
    }
    // ---- YouTube: the resumable upload
    if (p === '/youtube/upload/youtube/v3/videos' && req.method === 'POST') {
      const raw = await body(req);
      const t = tokenOk(req.headers.authorization, 'Bearer');
      if (!t || expire('ytExpireNext', t)) return json(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Invalid Credentials' } });
      if (url.searchParams.get('uploadType') !== 'resumable') return json(res, 400, { error: { message: 'resumable expected' } });
      const sid = rnd();
      state.youtube.sessions[sid] = { meta: JSON.parse(String(raw)), total: Number(req.headers['x-upload-content-length']), type: req.headers['x-upload-content-type'], received: [], size: 0, puts: 0 };
      return res.writeHead(200, { location: `http://${req.headers.host}/youtube/session/${sid}` }).end();
    }
    const yt = /^\/youtube\/session\/(\w+)$/.exec(p);
    if (yt && req.method === 'PUT') {
      const raw = await body(req);
      const s = state.youtube.sessions[yt[1]];
      if (!s) return res.writeHead(404).end();
      if (!tokenOk(req.headers.authorization, 'Bearer')) return json(res, 401, { error: { code: 401 } });
      const cr = String(req.headers['content-range'] ?? '');
      const answer = () => {
        if (s.size === s.total) {
          const id = `vid${state.youtube.videos.length + 1}`;
          if (!s.id) state.youtube.videos.push({ id, ...s.meta, size: s.size, puts: s.puts });
          s.id ??= id;
          return json(res, 200, { id: s.id, kind: 'youtube#video' });
        }
        return res.writeHead(308, s.size ? { range: `bytes=0-${s.size - 1}` } : {}).end();
      };
      if (/^bytes \*\//.test(cr)) return answer();
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
      if (!m) return json(res, 400, { error: { message: 'Content-Range' } });
      s.puts++;
      if (state.config.ytFailAt === Number(m[1])) {
        state.config.ytFailAt = null;
        // Half of the piece arrived before the connection dropped.
        const half = Math.floor(raw.length / 2);
        s.received.push(raw.subarray(0, half));
        s.size += half;
        return json(res, 503, { error: { code: 503, message: 'Backend Error' } });
      }
      if (Number(m[1]) !== s.size) return json(res, 400, { error: { message: `expected ${s.size}` } });
      s.received.push(raw);
      s.size += raw.length;
      return answer();
    }
    // ---- Mixcloud: OAuth with a GET exchange and no state, then the upload
    if (p === '/mixcloud/oauth/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== apps.mixcloud.id) return res.writeHead(400).end('unknown client');
      const code = rnd();
      state.mixcloud.codes[code] = q.get('redirect_uri');
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (p === '/mixcloud/oauth/access_token') {
      const q = url.searchParams;
      const redirect = state.mixcloud.codes[q.get('code')];
      delete state.mixcloud.codes[q.get('code')];
      if (q.get('client_id') !== apps.mixcloud.id || q.get('client_secret') !== apps.mixcloud.secret || !redirect || redirect !== q.get('redirect_uri')) return json(res, 400, { error: { type: 'OAuthException', message: 'bad code' } });
      const token = rnd();
      state.mixcloud.tokens[token] = true;
      return json(res, 200, { access_token: token });
    }
    if (p === '/mixcloud/api/upload/' && req.method === 'POST') {
      const raw = await body(req);
      if (!state.mixcloud.tokens[url.searchParams.get('access_token')]) return json(res, 401, { error: { type: 'OAuthException', message: 'Invalid token' } });
      if (state.config.mcRateLimit > 0) {
        state.config.mcRateLimit--;
        return json(res, 403, { error: { type: 'RateLimitException', message: 'Too many requests', retry_after: 1 } });
      }
      const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const fields = {};
      for (const [k, v] of form) fields[k] = typeof v === 'string' ? v : { name: v.name, size: v.size, type: v.type, head: Buffer.from(await v.slice(0, 3).arrayBuffer()).toString('latin1') };
      const key = `/openband-user/${String(fields.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}/`;
      state.mixcloud.uploads.push({ key, fields });
      return json(res, 200, { result: { success: true, key, message: 'Uploaded' } });
    }
    // ---- Funkwhale: an instance (OAuth with PKCE optional, libraries, uploads imported in the background)
    if (p === '/funkwhale/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== apps.funkwhale.id) return res.writeHead(400).end('unknown client');
      if (!/write:libraries/.test(q.get('scope') ?? '')) return res.writeHead(400).end('write:libraries expected');
      const code = rnd();
      state.oauth.codes[code] = { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), app: 'funkwhale' };
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if ((p === '/funkwhale/api/v1/oauth/token/' && !state.config.fwV2Only) || p === '/funkwhale/api/v2/oauth/token') {
      const f = new URLSearchParams(String(await body(req)));
      if (f.get('client_id') !== apps.funkwhale.id || f.get('client_secret') !== apps.funkwhale.secret) return json(res, 401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = state.oauth.codes[f.get('code')];
        delete state.oauth.codes[f.get('code')];
        if (!c || c.app !== 'funkwhale' || c.redirect !== f.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
        if (c.challenge && b64url(crypto.createHash('sha256').update(f.get('code_verifier') ?? '').digest()) !== c.challenge) return json(res, 400, { error: 'invalid_grant' });
        state.funkwhale.tokenPath = p;
        return json(res, 200, issue());
      }
      if (f.get('grant_type') === 'refresh_token' && state.oauth.refresh[f.get('refresh_token')]) {
        delete state.oauth.refresh[f.get('refresh_token')];
        state.oauth.refreshed = (state.oauth.refreshed ?? 0) + 1;
        return json(res, 200, issue());
      }
      return json(res, 400, { error: 'invalid_grant' });
    }
    if (p.startsWith('/funkwhale/api/v1/') && p !== '/funkwhale/api/v1/oauth/token/') {
      const raw = req.method === 'POST' ? await body(req) : null;
      if (!tokenOk(req.headers.authorization, 'Bearer')) return json(res, 401, { detail: 'Authentication credentials were not provided.' });
      if (p === '/funkwhale/api/v1/libraries/') return json(res, 200, { count: 3, results: ['me', 'instance', 'everyone'].map((l) => ({ uuid: `lib-${l}`, name: l, privacy_level: l })) });
      if (p === '/funkwhale/api/v1/uploads/' && req.method === 'POST') {
        const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const meta = JSON.parse(String(form.get('import_metadata') ?? '{}'));
        if (!meta.title) return json(res, 400, { import_metadata: { title: ['This field is required.'] } });
        if (meta.license && !state.config.fwLicenses.includes(meta.license)) return json(res, 400, { import_metadata: { license: [`Object with code=${meta.license} does not exist.`] } });
        if (!['draft', 'pending'].includes(String(form.get('import_status')))) return json(res, 400, { import_status: ['Newly created Uploads need to have import_status of draft or pending'] });
        const f = form.get('audio_file');
        const up = { uuid: rnd(), library: form.get('library'), import_status: 'pending', import_reference: form.get('import_reference'), import_metadata: meta, size: f?.size, filename: f?.name, track: null };
        state.funkwhale.uploads.push(up);
        return json(res, 201, up);
      }
      if (p === '/funkwhale/api/v1/uploads/' && req.method === 'GET') {
        // The instance finishes importing on the second look.
        state.funkwhale.polls++;
        for (const u of state.funkwhale.uploads) if (u.import_status === 'pending' && state.funkwhale.polls >= 2) Object.assign(u, { import_status: 'finished', track: { id: 41 + state.funkwhale.uploads.indexOf(u), title: u.import_metadata.title } });
        return json(res, 200, { count: state.funkwhale.uploads.length, results: [...state.funkwhale.uploads].reverse() });
      }
    }
    res.writeHead(404).end();
  });
  return {
    state,
    listen: (port = 0) => new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server.address().port))),
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = createFakePlatforms();
  const port = await fake.listen(Number(process.argv[2] ?? 0));
  console.log(`fake platforms on http://127.0.0.1:${port}`);
}
