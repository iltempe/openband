// Publishing (SPEC v0.6 G6): to the platforms OpenBand has an adapter for, through the local OpenBand that
// holds the user's keys. Every publish waits for the user to confirm it in the studio — the AI can ask,
// never publish on its own. What went out, where and when is kept in the song (Project.publications).
import { create } from 'zustand';
import { useStore } from '../store';
import { useBridge, publishRequest, onPublishAuthorized } from '../bridge';
import { renderBuffer } from '../audio/render';
import type { Publication } from '../types';
import { checkReleaseCommand } from './commands';
import { PLATFORMS, platformById } from './check';
import { releaseFiles } from './kit';
import { archiveItem, commonsFilename, commonsPage } from './prepare';
import { releaseOf } from './release';

/** The platforms with an adapter in this version; the others come next. */
export const SUPPORTED = ['archive', 'wikimedia'] as const;
/** Uploads there are always public. */
const ALWAYS_PUBLIC = new Set(['archive', 'wikimedia']);

export interface TargetField {
  key: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  set: boolean;
  value?: string;
}
export interface ServerTarget {
  id: string;
  name: string;
  auth: 'keys' | 'oauth';
  configured: boolean;
  authorized: boolean;
  fields: TargetField[];
  help: string;
  redirect_uri?: string;
}

export interface ConfirmRequest {
  platforms: string[];
  privacy: Publication['privacy'];
  resolve: (ok: boolean) => void;
}

export const usePublish = create<{ targets: ServerTarget[] | null; token: string | null; confirm: ConfirmRequest | null; progress: Record<string, { fraction: number; note?: string; error?: string; url?: string }> }>(() => ({
  targets: null,
  token: null,
  confirm: null,
  progress: {},
}));

export async function refreshTargets(): Promise<ServerTarget[]> {
  const r = await publishRequest<{ token: string; targets: ServerTarget[] }>('targets');
  usePublish.setState({ targets: r.targets, token: r.token });
  return r.targets;
}

// A sign-in finished in its own window: the accounts change, whichever panel is open.
onPublishAuthorized(() => void refreshTargets().catch(() => {}));

export async function saveCredentials(platform: string, values: Record<string, string>) {
  const r = await publishRequest<{ targets: ServerTarget[] }>('credentials', { platform, values });
  usePublish.setState({ targets: r.targets });
}

export async function forgetAccount(platform: string) {
  const r = await publishRequest<{ targets: ServerTarget[] }>('forget', { platform });
  usePublish.setState({ targets: r.targets });
}

/** The sign-in page to open for an OAuth platform; the server tells when it is done. */
export const authorizeUrl = (platform: string) => publishRequest<{ url: string }>('authorize', { platform }).then((r) => r.url);

/** Every platform: whether OpenBand can publish there yet, the account, and what the checks say. */
export async function listPublishTargets() {
  const server = useBridge.getState().publish ? await refreshTargets().catch(() => null) : null;
  const check = checkReleaseCommand();
  return {
    available: !!server,
    ...(server ? {} : { note: 'Publishing needs the OpenBand app or npx openband on this computer: the keys stay there, never in the web page.' }),
    targets: PLATFORMS.map((pl) => {
      const t = server?.find((x) => x.id === pl.id);
      const blocking = check.issues.filter((i) => i.severity === 'error' && (i.platform === pl.id || i.platform === null)).map((i) => i.message);
      return {
        id: pl.id,
        name: pl.name,
        supported: (SUPPORTED as readonly string[]).includes(pl.id),
        account: t ? (t.authorized ? 'ready' : t.configured ? 'needs sign-in' : 'not set up') : 'unavailable',
        ready: !!t?.authorized && !blocking.length,
        blocking,
      };
    }),
  };
}

/** Ask the user in the studio; resolves true only on their click. */
function askUser(platforms: string[], privacy: Publication['privacy'], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      if (usePublish.getState().confirm?.resolve === done) usePublish.setState({ confirm: null });
      resolve(ok);
    };
    usePublish.getState().confirm?.resolve(false);
    usePublish.setState({ confirm: { platforms, privacy, resolve: done } });
  });
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sendAsset(bytes: Uint8Array, name: string, type: string): Promise<string> {
  const { token } = usePublish.getState();
  const port = useBridge.getState().port;
  const res = await fetch(`http://127.0.0.1:${port}/publish/asset`, { method: 'POST', body: bytes as BodyInit, headers: { 'content-type': type, 'x-openband-token': token ?? '', 'x-openband-name': encodeURIComponent(name) } });
  if (!res.ok) throw new Error(`The local OpenBand refused the file (${res.status})`);
  return ((await res.json()) as { asset: string }).asset;
}

const TYPES: Record<string, string> = { flac: 'audio/flac', png: 'image/png', lrc: 'text/plain', txt: 'text/plain' };
const typeOf = (name: string) => TYPES[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';

export interface PublishArgs {
  platforms: string[];
  privacy?: Publication['privacy'];
  /** How long to wait for the user's click (tests). */
  confirm_timeout_ms?: number;
}

export async function publish(a: PublishArgs) {
  const platforms = [...new Set(a.platforms ?? [])];
  if (!platforms.length) throw new Error('Name the platforms to publish to (list_publish_targets shows them)');
  const privacy = a.privacy ?? 'public';
  for (const id of platforms) {
    if (!platformById(id)) throw new Error(`"${id}" is not a platform OpenBand publishes to`);
    if (!(SUPPORTED as readonly string[]).includes(id)) throw new Error(`Publishing to ${platformById(id)!.name} is not available yet (this version: ${SUPPORTED.join(', ')}); export the Release Kit and upload it by hand`);
    if (ALWAYS_PUBLIC.has(id) && privacy !== 'public') throw new Error(`${platformById(id)!.name} uploads are always public: there is no ${privacy} upload there`);
  }
  // The checks first: a blocking issue stops it before anyone is asked.
  const check = checkReleaseCommand(platforms);
  const blocking = check.issues.filter((i) => i.severity === 'error');
  if (blocking.length) throw new Error(`Not ready to publish: ${blocking.map((i) => `${i.platform ? `${platformById(i.platform)?.name}: ` : ''}${i.message}`).join('; ')}`);
  const targets = await refreshTargets();
  for (const id of platforms) if (!targets.find((t) => t.id === id)?.authorized) throw new Error(`${platformById(id)!.name}: set up the account in Release → Accounts first`);

  if (!(await askUser(platforms, privacy, a.confirm_timeout_ms ?? 5 * 60000))) throw new Error('Not published: the user did not confirm it in the studio (publishing always needs their click)');

  const p = useStore.getState().project;
  const buf = await renderBuffer(p, { sampleRate: 48000 });
  const files = await releaseFiles(p, { channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)), sampleRate: buf.sampleRate });
  const flacName = Object.keys(files).find((k) => k.endsWith('.flac'))!;
  const master = hex(await crypto.subtle.digest('SHA-256', files[flacName] as BufferSource)).slice(0, 16);
  const published: Publication[] = [];
  const failed: { platform: string; error: string }[] = [];
  const setProgress = (id: string, v: { fraction: number; note?: string; error?: string; url?: string }) => usePublish.setState((s) => ({ progress: { ...s.progress, [id]: v } }));
  for (const id of platforms) {
    setProgress(id, { fraction: 0 });
    try {
      let pkg: Record<string, unknown>;
      let send: string[];
      if (id === 'archive') {
        pkg = archiveItem(p, master.slice(0, 6)) as unknown as Record<string, unknown>;
        send = [flacName, 'cover.png', ...Object.keys(files).filter((k) => /\.(lrc|txt)$/.test(k))];
      } else {
        const filename = commonsFilename(p);
        pkg = { filename, text: commonsPage(p), comment: `${releaseOf(p).title}: uploaded with OpenBand` };
        send = [flacName];
      }
      const sent = [];
      for (const name of send) sent.push({ asset: await sendAsset(files[name], name, typeOf(name)), name: id === 'wikimedia' ? (pkg.filename as string) : name, type: typeOf(name) });
      const r = await publishRequest<{ id: string; url: string }>('upload', { platform: id, files: sent, package: pkg, privacy }, (fraction, note) => setProgress(id, { fraction, note }));
      const pub: Publication = { platform: id, id: r.id, url: r.url, at: Date.now(), master, privacy };
      published.push(pub);
      // What went out stays recorded: not an undo step.
      useStore.getState().commit((d) => void (d.publications = [...(d.publications ?? []), pub]), { history: false });
      setProgress(id, { fraction: 1, url: r.url });
    } catch (e) {
      failed.push({ platform: id, error: (e as Error).message });
      setProgress(id, { fraction: 0, error: (e as Error).message });
    }
  }
  return { published: published.map((x) => ({ platform: x.platform, url: x.url, id: x.id })), ...(failed.length ? { failed } : {}), master };
}

export function getPublications() {
  const pubs = useStore.getState().project.publications ?? [];
  return { publications: pubs.map((x) => ({ ...x, platform_name: platformById(x.platform)?.name ?? x.platform, at: new Date(x.at).toISOString() })) };
}
