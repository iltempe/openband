// OpenBand's relay for online engines (SPEC v0.6 §9-bis): a stateless proxy the user deploys on their own
// account (Cloudflare Worker or Vercel function, see README.md), so the online studio can use fal.ai
// without the provider key ever being in the browser. It:
//   - forwards /fal/<path> to https://queue.fal.run/<path> (GET, POST, PUT), adding the key it keeps as
//     a secret (FAL_KEY);
//   - forwards GET /media?url=https://….fal.media/… (the audio fal returns), without the key;
//   - answers only requests carrying the user's own token (RELAY_TOKEN, header x-relay-token), from the
//     origins they allow (ALLOWED_ORIGINS, comma-separated; the OpenBand studio by default);
//   - keeps and logs nothing: no console calls, no storage.

const FAL = 'https://queue.fal.run';
const DEFAULT_ORIGINS = ['https://iltempe.github.io', 'https://www.openband.it'];
const MAX_BODY = 12 * 1024 * 1024;

/** Compare without leaking the length of the common prefix. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const json = (status, body, cors) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });

/** The relay: env = { FAL_KEY, RELAY_TOKEN, ALLOWED_ORIGINS? }; upstream = fetch (replaceable in tests). */
export async function handle(request, env, upstream = fetch) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS).split(',') : DEFAULT_ORIGINS).map((s) => s.trim()).filter(Boolean);
  const okOrigin = !origin || allowed.includes(origin) || allowed.includes('*');
  const cors = okOrigin && origin ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-headers': 'content-type, x-relay-token', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' } : {};
  if (request.method === 'OPTIONS') return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
  if (!okOrigin) return json(403, { error: 'origin not allowed' }, {});
  if (!env.FAL_KEY || !env.RELAY_TOKEN) return json(500, { error: 'the relay is missing FAL_KEY or RELAY_TOKEN' }, cors);
  if (!sameSecret(request.headers.get('x-relay-token') ?? '', String(env.RELAY_TOKEN))) return json(401, { error: 'wrong relay token' }, cors);

  let target;
  let withKey = false;
  if (url.pathname.startsWith('/fal/')) {
    target = `${FAL}/${url.pathname.slice(5)}${url.search}`;
    withKey = true;
    if (!['GET', 'POST', 'PUT'].includes(request.method)) return json(405, { error: 'method not allowed' }, cors);
  } else if (url.pathname === '/media' && request.method === 'GET') {
    const media = url.searchParams.get('url') ?? '';
    let host = '';
    try {
      host = new URL(media).hostname;
    } catch {
      // not a URL
    }
    if (!/^https:/.test(media) || !(host === 'fal.media' || host.endsWith('.fal.media') || host === 'storage.googleapis.com')) return json(400, { error: 'only fal media URLs' }, cors);
    target = media;
  } else return json(404, { error: 'not found: use /fal/<model> or /media?url=' }, cors);

  const body = request.method === 'GET' ? undefined : await request.arrayBuffer();
  if (body && body.byteLength > MAX_BODY) return json(413, { error: 'request too large' }, cors);
  const res = await upstream(target, {
    method: request.method,
    headers: { ...(withKey ? { authorization: `Key ${env.FAL_KEY}` } : {}), ...(body ? { 'content-type': request.headers.get('content-type') ?? 'application/json' } : {}) },
    body,
  });
  // Only what the studio needs back: the body and its type (no cookies, no upstream headers).
  return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store', ...cors } });
}

export default { fetch: (request, env) => handle(request, env) };
