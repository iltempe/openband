// A stand-in for the publishing platforms (SPEC v0.6 G6 acceptance: every adapter tested against a mock of
// its endpoints). Internet Archive's S3 API (keys, auto-made items, x-archive-meta headers, 503 SlowDown) and
// Wikimedia: OAuth 2.0 with PKCE (S256 checked, single-use refresh tokens, tokens that expire early) and the
// MediaWiki chunked upload (offsets checked, a chunk that fails once). /__mock/state shows what arrived;
// POST /__mock/config sets failures. Run alone: node server/fixtures/fake-platforms.mjs [port]
import crypto from 'node:crypto';
import http from 'node:http';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rnd = () => crypto.randomBytes(12).toString('hex');

export function createFakePlatforms({ archiveKeys = { access: 'ACCESS', secret: 'SECRET' }, wikimediaClient = 'commons-client' } = {}) {
  const state = {
    archive: {},
    commons: { files: {}, stash: {} },
    oauth: { codes: {}, access: {}, refresh: {} },
    config: { archive503: 0, expireNext: false, failChunk: null },
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
