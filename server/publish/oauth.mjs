// OAuth for the publishing platforms (SPEC v0.6 G6): authorization code with PKCE (S256), the local server
// as the redirect target and broker (it holds the client secret, when the platform has one), tokens
// refreshed before they expire — and once more if the platform says one expired early. Refresh tokens may be
// single-use: the new one always replaces the old.
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

/** The authorize URL to open, and what the callback needs to finish. */
export function authorizeUrl({ authorize, clientId, redirectUri, scopes = [], extra = {} }) {
  const { verifier, challenge } = pkce();
  const state = b64url(crypto.randomBytes(16));
  const u = new URL(authorize);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  if (scopes.length) u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return { url: u.toString(), state, verifier };
}

async function tokenRequest(tokenUrl, params, fetchImpl = fetch) {
  const res = await fetchImpl(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok || !json?.access_token) throw new Error(`The platform refused the sign-in (${res.status}${json?.error ? `: ${json.error_description || json.error}` : ''})`);
  return { access: json.access_token, refresh: json.refresh_token, expires_at: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : null };
}

export const exchangeCode = ({ token, clientId, clientSecret, redirectUri, code, verifier }, fetchImpl) =>
  tokenRequest(token, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier }, fetchImpl);

export const refreshToken = ({ token, clientId, clientSecret, refresh }, fetchImpl) => tokenRequest(token, { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: clientSecret }, fetchImpl);

/**
 * A bearer for a platform: the stored token, refreshed when it is about to expire (or when force is set,
 * after the platform refused it). Saves what it gets.
 */
export async function bearer(store, platform, oauth, { force = false, fetchImpl } = {}) {
  const cfg = store.get(platform);
  if (!cfg.access) throw new Error(`Not signed in to ${platform}: sign in from Release → Accounts first`);
  const stale = force || (cfg.expires_at && cfg.expires_at - Date.now() < 60000);
  if (!stale) return cfg.access;
  if (!cfg.refresh) throw new Error(`The ${platform} sign-in expired: sign in again from Release → Accounts`);
  const t = await refreshToken({ token: oauth.token, clientId: cfg.client_id, clientSecret: cfg.client_secret, refresh: cfg.refresh }, fetchImpl).catch((e) => {
    store.set(platform, { access: null, refresh: null, expires_at: null });
    throw new Error(`The ${platform} sign-in expired and could not be renewed (${e.message}): sign in again`);
  });
  store.set(platform, { access: t.access, refresh: t.refresh ?? cfg.refresh, expires_at: t.expires_at });
  return t.access;
}
