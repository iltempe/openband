// The Content-Security-Policy of public OpenBand instances — one source for the Docker image (served by
// the Node server with OPENBAND_CSP=1), Netlify / Cloudflare Pages (dist/_headers, written at build) and
// Vercel (vercel.json, checked against this in a test).
//
// connect-src: the bridge on this computer, the AI APIs of the in-browser chat (and local AI servers such
// as Ollama), the WAM plugin catalog and
// the collaboration servers, the relay for online engines and the model hosts of in-browser engines. Anything else (importing a sound from an arbitrary URL in the browser, other
// plugin hosts) is blocked on such instances unless the admin adds it here or in their own headers.
export const WAM_HOST = 'https://www.webaudiomodules.com';
export const DEFAULT_COLLAB = ['wss://y-webrtc-eu.fly.dev'];
/** The AI providers the in-browser chat can call with the user's key (local servers: http://127.0.0.1 / localhost). */
export const AI_APIS = ['https://api.anthropic.com', 'https://api.openai.com', 'https://generativelanguage.googleapis.com'];
/** Where users deploy their relay for online engines (deploy/relay/): the provider key stays there. */
export const RELAY_HOSTS = ['https://*.workers.dev', 'https://*.vercel.app'];
/** Where models for in-browser engines are downloaded from, with the user's OK (Demucs: Hugging Face and its CDN). */
export const MODEL_HOSTS = ['https://huggingface.co', 'https://*.hf.co'];

export function contentSecurityPolicy({ collab = DEFAULT_COLLAB, extraConnect = [] } = {}) {
  const directives = {
    'default-src': ["'self'"],
    // Plugins are ES modules from the WAM host; audio worklets and workers come from blob: URLs.
    'script-src': ["'self'", "'wasm-unsafe-eval'", 'blob:', WAM_HOST],
    'worker-src': ["'self'", 'blob:'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', WAM_HOST],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    'img-src': ["'self'", 'data:', 'blob:', WAM_HOST],
    'media-src': ["'self'", 'data:', 'blob:'],
    'connect-src': ["'self'", 'ws://127.0.0.1:*', 'ws://localhost:*', 'http://127.0.0.1:*', 'http://localhost:*', ...AI_APIS, ...RELAY_HOSTS, ...MODEL_HOSTS, WAM_HOST, ...collab, ...extraConnect],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'frame-ancestors': ["'self'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

/** Cache rules shared by every host: hashed assets forever, the page and the service worker never. */
export const CACHE_RULES = [
  { path: '/assets/*', value: 'public, max-age=31536000, immutable' },
  { path: '/index.html', value: 'no-cache' },
  { path: '/sw.js', value: 'no-cache' },
  { path: '/version.json', value: 'no-cache' },
  { path: '/config.json', value: 'no-cache' },
];
