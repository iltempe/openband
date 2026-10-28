// Updating the desktop app from inside it (issue #4). The latest GitHub release, the package for this
// platform, downloaded and checked against the SHA-256 GitHub states for it, then installed the way each
// platform allows without a signed updater:
//   macOS     the .zip: its OpenBand.app replaces this one (a file the app downloads gets no quarantine),
//             once the app has quit, and opens;
//   Windows   the installer, silent, over this installation, and it starts the app again;
//   AppImage  the new AppImage takes this one's place and starts;
//   .deb      opened in the system's software installer (installing needs the user's password).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REPO = 'iltempe/openband';

/** The release asset this installation updates from (stable "latest" names). */
export function assetName({ platform, arch, appImage = false }) {
  const arm = arch === 'arm64';
  if (platform === 'darwin') return `OpenBand-mac-${arm ? 'arm64' : 'x64'}.zip`;
  if (platform === 'win32') return `OpenBand-win-${arm ? 'arm64' : 'x64'}.exe`;
  if (platform === 'linux') return appImage ? `OpenBand-linux-${arm ? 'arm64' : 'x86_64'}.AppImage` : `OpenBand-linux-${arm ? 'arm64' : 'amd64'}.deb`;
  return null;
}

/** The latest release: its version and assets (name, url, size, sha256). */
export async function latestRelease({ fetchImpl = fetch, repo = REPO } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const j = await res.json();
  return {
    version: String(j.tag_name ?? '').replace(/^v/, ''),
    url: j.html_url,
    notes: String(j.body ?? ''),
    assets: (j.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size, sha256: /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? '')?.[1] ?? null })),
  };
}

/** Download to dir, with progress, and check the SHA-256. Refuses an asset without one. */
export async function download(asset, dir, { fetchImpl = fetch, onProgress } = {}) {
  if (!asset.sha256) throw new Error(`${asset.name} has no checksum on GitHub: download it from the release page instead`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asset.name);
  const res = await fetchImpl(asset.url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(`${file}.part`);
  let got = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
    onProgress?.(total ? got / total : 0);
  }
  await new Promise((ok, ko) => out.end((e) => (e ? ko(e) : ok())));
  const sum = hash.digest('hex');
  if (sum !== asset.sha256) {
    fs.rmSync(`${file}.part`, { force: true });
    throw new Error(`The download is damaged (SHA-256 ${sum.slice(0, 12)}…, expected ${asset.sha256.slice(0, 12)}…): try again`);
  }
  fs.renameSync(`${file}.part`, file);
  return file;
}

/**
 * How to install the downloaded file here. exe: this app's executable; appImage: $APPIMAGE.
 * Returns { kind, … } — the main process carries it out (see desktop/main.mjs).
 */
export function installPlan({ platform, file, exe, appImage }) {
  if (platform === 'darwin') {
    // …/OpenBand.app/Contents/MacOS/OpenBand → …/OpenBand.app
    const bundle = path.resolve(exe, '..', '..', '..');
    if (!bundle.endsWith('.app')) return { kind: 'open', file };
    // Running from the disk image (read-only): open the new one instead.
    if (bundle.startsWith('/Volumes/')) return { kind: 'open', file, why: 'OpenBand runs from its disk image: drag the new one to Applications' };
    return { kind: 'replace-app', zip: file, bundle };
  }
  if (platform === 'win32') return { kind: 'run-installer', file, args: ['/S', '--force-run'] };
  if (platform === 'linux' && appImage) return { kind: 'replace-appimage', file, target: appImage };
  return { kind: 'open', file };
}

/** The shell script that swaps the app bundle once this process (pid) has quit, and opens it (macOS). */
export function macSwapScript({ pid, newApp, bundle }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return [
    `while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.2; done`,
    `rm -rf ${q(`${bundle}.old`)}`,
    `mv ${q(bundle)} ${q(`${bundle}.old`)} && mv ${q(newApp)} ${q(bundle)} && rm -rf ${q(`${bundle}.old`)} || mv ${q(`${bundle}.old`)} ${q(bundle)}`,
    `xattr -dr com.apple.quarantine ${q(bundle)} 2>/dev/null`,
    `open ${q(bundle)}`,
  ].join('\n');
}
