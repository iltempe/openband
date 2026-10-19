// Moving the open song from the online demo to the studio served on this computer, when the browser
// won't let the demo talk to it: the song travels in the URL fragment (never sent to any server), or by
// postMessage when it is too big for a URL.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { useStore } from './store';

/** Sites allowed to hand a song over (keep in step with the server's OPENBAND_ALLOWED_ORIGINS default). */
export const TRUSTED_ORIGINS = ['https://iltempe.github.io'];
const MAX_FRAGMENT = 1_500_000;

const toB64url = (u8: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export const encodeProject = (project: unknown) => toB64url(gzipSync(strToU8(JSON.stringify(project))));
export const decodeProject = (s: string) => JSON.parse(strFromU8(gunzipSync(fromB64url(s))));

/** Open the local studio with the current song. Returns the window (or null if blocked). */
export function openLocalStudio(port: number) {
  const project = useStore.getState().project;
  const payload = encodeProject(project);
  const base = `http://127.0.0.1:${port}/`;
  if (payload.length <= MAX_FRAGMENT) return window.open(`${base}#project=${payload}`, '_blank');
  const w = window.open(`${base}#import=opener`, '_blank');
  const onMsg = (ev: MessageEvent) => {
    if (ev.source !== w || ev.data?.type !== 'openband-ready') return;
    w?.postMessage({ type: 'openband-project', project }, ev.origin);
    window.removeEventListener('message', onMsg);
  };
  window.addEventListener('message', onMsg);
  return w;
}

/** On startup of the local studio: take the song handed over, if any. Returns true when one was loaded. */
export function consumeHandoff(): boolean {
  const hash = location.hash;
  if (hash.startsWith('#project=')) {
    history.replaceState(null, '', location.pathname + location.search);
    try {
      useStore.getState().loadProject(decodeProject(hash.slice('#project='.length)));
      useStore.getState().notify('Song brought over from the online demo');
      return true;
    } catch {
      useStore.getState().notify('Could not read the song from the link');
      return false;
    }
  }
  if (hash === '#import=opener' && window.opener) {
    history.replaceState(null, '', location.pathname + location.search);
    const onMsg = (ev: MessageEvent) => {
      if (!TRUSTED_ORIGINS.includes(ev.origin) || ev.data?.type !== 'openband-project') return;
      window.removeEventListener('message', onMsg);
      useStore.getState().loadProject(ev.data.project);
      useStore.getState().notify('Song brought over from the online demo');
    };
    window.addEventListener('message', onMsg);
    (window.opener as Window).postMessage({ type: 'openband-ready' }, '*');
    return true;
  }
  return false;
}
