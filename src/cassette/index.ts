// Cassettes in the studio: commands shared by the panel and MCP. Giving one away needs the person: it can't be taken back.
import { create } from 'zustand';
import { download } from '../audio/render';
import { uid } from '../music';
import { useStore } from '../store';
import { saveVersion, useVersions } from '../versioning';
import { burn, getCassette, latestOf, listCassettes, type BurnSpec, type StoredCassette } from './burn';
import type { CassetteOptions } from './format';
import { fileCassette, folderFiles, folderZip } from './deliver';
import { cassetteLink } from './format';
import { listenForReturns } from './returns';

export const useDeliverConfirm = create<{ ask: { title: string; mode: string; resolve: (ok: boolean) => void } | null }>(() => ({ ask: null }));
function confirm(title: string, mode: string, timeoutMs = 5 * 60000) {
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      useDeliverConfirm.setState({ ask: null });
      resolve(ok);
    };
    useDeliverConfirm.setState({ ask: { title, mode, resolve: done } });
    setTimeout(() => useDeliverConfirm.getState().ask?.resolve === done && done(false), timeoutMs);
  });
}

/** A song to put on a side: its HEAD, saved first if it has changed. */
export async function currentVersion() {
  const s = useVersions.getState();
  return s.headId ?? (await saveVersion('For a cassette', 'user')).id;
}

const summary = (c: StoredCassette) => ({ id: c.id, series: c.seriesId, edition: c.edition, title: c.title, sides: c.manifest.sides.map((s) => ({ name: s.name, tracks: s.tracks.map((t) => t.title) })), bytes: Object.values(c.pkg.blobs).reduce((n, b) => n + b.length, c.pkg.manifest.length) });

export async function createCassette(a: { title: string; artist?: string; dedication?: string; notes?: string; sides?: BurnSpec['sides']; options?: Partial<CassetteOptions>; quality?: 96 | 160 | 256; signaling?: string[] }) {
  const title = a.title?.trim();
  if (!title) throw new Error('A cassette needs a title');
  const sides = a.sides ?? [{ name: 'A' as const, tracks: [{ versionId: await currentVersion() }] }];
  const c = await burn({ title, artist: a.artist?.trim() || useStore.getState().project.release?.artist || 'OpenBand', dedication: a.dedication, notes: a.notes, sides, options: a.options, quality: a.quality, signaling: a.signaling });
  void listenForReturns();
  return summary(c);
}

export const listAll = async () => (await listCassettes()).map(summary);

/** The next print: the same key and signature, with these sides or the same ones. */
export async function newEdition(a: { series: string; sides?: BurnSpec['sides'] }) {
  const last = await latestOf(a.series);
  if (!last) throw new Error(`No cassette "${a.series}". Call list_cassettes.`);
  const sides = a.sides ?? last.manifest.sides.map((s) => ({ name: s.name, tracks: s.tracks.map((t) => ({ versionId: t.versionId, title: t.title, note: t.note })) }));
  return summary(await burn({ title: last.title, artist: last.manifest.artist, dedication: last.manifest.dedication, notes: last.manifest.notes, sides, options: last.manifest.options, series: { seriesId: last.seriesId, key: last.key, edition: last.edition }, returns: last.manifest.returns }));
}

/** GitHub Pages with the musician's own token: one folder per series in their repository. */
export async function publishGitHub(c: StoredCassette, o: { token: string; repo: string; password?: string }, fetcher: typeof fetch = fetch) {
  const files = await folderFiles(c, o.password);
  const headers = { authorization: `Bearer ${o.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' };
  for (const [name, data] of Object.entries(files)) {
    const url = `https://api.github.com/repos/${o.repo}/contents/${c.seriesId}/${name}`;
    const old = await fetcher(url, { headers });
    const sha = old.ok ? ((await old.json()) as { sha: string }).sha : undefined;
    let s = '';
    for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
    const r = await fetcher(url, { method: 'PUT', headers, body: JSON.stringify({ message: 'Cassette', content: btoa(s), ...(sha ? { sha } : {}) }) });
    if (!r.ok) throw new Error(`GitHub refused ${name}: ${r.status}`);
  }
  const [owner, name] = o.repo.split('/');
  return `https://${owner}.github.io/${name}/${c.seriesId}/`;
}

export async function deliverCassette(a: { series: string; mode: 'file' | 'static'; password?: string; target?: { github?: { token: string; repo: string } } }) {
  const c = await latestOf(a.series);
  if (!c) throw new Error(`No cassette "${a.series}". Call list_cassettes.`);
  if (!(await confirm(c.title, a.mode))) throw new Error('Not delivered: the user did not confirm it in the studio. A cassette given away cannot be taken back.');
  if (a.mode === 'file') {
    const f = await fileCassette(c, a.password);
    download(new Blob([f.html], { type: 'text/html' }), f.filename);
    return { filename: f.filename, bytes: f.bytes, too_big: f.tooBig, key_in_link: !a.password, link_fragment: a.password ? null : `#k=${c.key}&s=${c.seriesId}` };
  }
  if (a.target?.github) {
    const base = await publishGitHub(c, { ...a.target.github, password: a.password });
    return { link: cassetteLink(base, c.seriesId, a.password ? null : c.key) };
  }
  const zip = await folderZip(c, a.password);
  download(new Blob([zip as BlobPart], { type: 'application/zip' }), `${c.title}.cassetta.zip`);
  return { bytes: zip.length, link_fragment: a.password ? null : `#k=${c.key}&s=${c.seriesId}`, note: 'Upload the folder anywhere that serves static files, and add the fragment to its address.' };
}

export { getCassette, uid };
