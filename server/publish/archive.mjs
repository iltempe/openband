// Internet Archive (SPEC v0.6 G6): its S3-like API. Each file is PUT to s3.us.archive.org/<item>/<file>
// with the user's own keys (LOW access:secret, from archive.org/account/s3.php); the first one creates the
// item with its metadata in x-archive-meta-* headers. Permanent and public: the page says so before.
import fs from 'node:fs';

/** Header values are sent uri(...)-encoded, so any title, accent or line break survives. */
const enc = (v) => `uri(${encodeURIComponent(String(v))})`;

export function archiveHeaders(meta) {
  const h = {};
  for (const [k, v] of Object.entries(meta)) {
    const key = k.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (Array.isArray(v)) v.forEach((x, i) => (h[`x-archive-meta${String(i + 1).padStart(2, '0')}-${key}`] = enc(x)));
    else h[`x-archive-meta-${key}`] = enc(v);
  }
  return h;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const archive = {
  id: 'archive',
  name: 'Internet Archive',
  auth: 'keys',
  fields: [
    { key: 'access', label: 'S3 access key', secret: false },
    { key: 'secret', label: 'S3 secret key', secret: true },
  ],
  help: 'https://archive.org/account/s3.php',
  endpoints: (mock) => ({ s3: mock ? `${mock}/archive-s3` : 'https://s3.us.archive.org', site: mock ? `${mock}/archive` : 'https://archive.org' }),
  configured: (cfg) => !!(cfg.access && cfg.secret),

  async upload({ cfg, pkg, files, endpoints, onProgress, fetchImpl = fetch, retryDelay = 1000 }) {
    if (!this.configured(cfg)) throw new Error('Internet Archive: add your S3 keys in Release → Accounts (archive.org/account/s3.php)');
    const { identifier, meta } = pkg;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{4,99}$/.test(identifier)) throw new Error(`Internet Archive: "${identifier}" is not a valid item identifier`);
    const total = files.reduce((a, f) => a + f.size, 0);
    let done = 0;
    for (const [i, f] of files.entries()) {
      const headers = {
        authorization: `LOW ${cfg.access}:${cfg.secret}`,
        'content-type': f.type || 'application/octet-stream',
        'content-length': String(f.size),
        'x-archive-size-hint': String(total),
        ...(i === 0 ? { 'x-archive-auto-make-bucket': '1', ...archiveHeaders(meta) } : {}),
      };
      const url = `${endpoints.s3}/${identifier}/${encodeURIComponent(f.name)}`;
      // The Archive answers 503 SlowDown when busy: wait and try again, a few times.
      for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(url, { method: 'PUT', headers, body: fs.readFileSync(f.path) });
        if (res.ok) break;
        const body = await res.text();
        if ((res.status === 503 || res.status === 500) && attempt < 4) {
          await wait(retryDelay * 2 ** attempt);
          continue;
        }
        if (res.status === 403) throw new Error(`Internet Archive refused the keys (${/<Code>(\w+)/.exec(body)?.[1] ?? 403}): check them at archive.org/account/s3.php`);
        throw new Error(`Internet Archive: ${f.name} failed (${res.status} ${/<Message>([^<]+)/.exec(body)?.[1] ?? ''})`.trim());
      }
      done += f.size;
      onProgress?.(done / total, f.name);
    }
    return { id: identifier, url: `${endpoints.site}/details/${identifier}` };
  },

  async status({ id, endpoints, fetchImpl = fetch }) {
    const res = await fetchImpl(`${endpoints.site}/metadata/${encodeURIComponent(id)}`);
    const json = res.ok ? await res.json() : null;
    return json?.metadata ? { state: 'live', url: `${endpoints.site}/details/${id}`, files: (json.files ?? []).map((f) => f.name) } : { state: 'processing' };
  },
};
