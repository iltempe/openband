// OpenBand relay on Vercel (Edge Function): the same handler as the Cloudflare Worker. See ../README.md.
import { handle } from '../relay.mjs';

export const config = { runtime: 'edge' };

/** Every path comes here as /api/…; the handler expects /fal/… and /media at the root. */
export default (request) => {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api/, '') || '/';
  return handle(new Request(url, request), process.env);
};
