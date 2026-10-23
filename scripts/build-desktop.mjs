#!/usr/bin/env node
// Build the OpenBand desktop app (Electron) for this platform: build/desktop/
//   macOS   OpenBand-<v>-mac-arm64.dmg, OpenBand-<v>-mac-x64.dmg (+ .zip)
//   Windows OpenBand-<v>-win-x64.exe, OpenBand-<v>-win-arm64.exe (NSIS installer)
//   Linux   OpenBand-<v>-linux-x86_64.AppImage, OpenBand-<v>-linux-amd64.deb (+ arm64)
//
//   npm run build && node scripts/build-desktop.mjs [--dir] [--arch=arm64|x64]
//   (--dir: just the unpacked app, fast, for testing; needs `npm ci --prefix desktop` once)
//
// The app holds the built studio (dist/), the MCP server (server/*.mjs) with its production
// node_modules, and desktop/main.mjs + preload.cjs. Not signed: see docs/DESKTOP.md.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dirOnly = args.includes('--dir');
const arch = args.find((a) => a.startsWith('--arch='))?.slice(7);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('dist/ is missing: run "npm run build" first.');
  process.exit(1);
}
const desktopModules = path.join(root, 'desktop', 'node_modules');
if (!fs.existsSync(path.join(desktopModules, 'electron-builder'))) {
  console.error('Electron is not installed: run "npm ci --prefix desktop" first.');
  process.exit(1);
}

// ---- stage the app
const stage = path.join(root, 'build', 'desktop-app');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'server'), { recursive: true });
const copy = (from, to = from) => fs.cpSync(path.join(root, from), path.join(stage, to), { recursive: true });
copy('dist');
copy('omep');
for (const f of fs.readdirSync(path.join(root, 'server'))) if (f.endsWith('.mjs')) copy(`server/${f}`);
copy('desktop/main.mjs', 'main.mjs');
copy('desktop/preload.cjs', 'preload.cjs');
copy('LICENSE');
// How to open an unsigned app on macOS: shown in the disk image, not part of the app itself.
const OPEN_HELP = "If it won't open - Se non si apre.txt";
copy(`desktop/resources/${OPEN_HELP}`, OPEN_HELP);
fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'openband',
      productName: 'OpenBand',
      version: pkg.version,
      description: 'An open-source music studio that you — or your AI — can play.',
      license: pkg.license ?? 'MIT',
      homepage: 'https://github.com/iltempe/openband',
      author: { name: 'OpenBand contributors', email: 'openband@users.noreply.github.com' },
      main: 'main.mjs',
      dependencies: pkg.dependencies,
    },
    null,
    2,
  ),
);
execSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock --silent', { cwd: stage, stdio: 'inherit' });

// ---- package
const require = createRequire(path.join(desktopModules, 'noop.js'));
const builder = require('electron-builder');
const electronVersion = require('electron/package.json').version;
const assoc = [
  { ext: 'openband', name: 'OpenBand song', role: 'Editor', mimeType: 'application/x-openband' },
  { ext: ['mid', 'midi'], name: 'MIDI file', role: 'Viewer', mimeType: 'audio/midi' },
  { ext: 'dawproject', name: 'DAWproject', role: 'Editor', mimeType: 'application/x-dawproject' },
];
// A fresh object per build: electron-builder normalizes (and mutates) the one it is given.
const makeConfig = () => ({
  appId: 'io.github.iltempe.openband',
  productName: 'OpenBand',
  copyright: 'MIT license — OpenBand contributors',
  electronVersion,
  // Plain files, not an asar archive: AI clients run server/mcp-server.mjs with the app in Node mode.
  asar: false,
  directories: { app: stage, output: path.join(root, 'build', 'desktop'), buildResources: path.join(root, 'desktop', 'resources') },
  files: ['**/*', `!${OPEN_HELP}`],
  icon: path.join(root, 'mcpb', 'icon.png'),
  fileAssociations: assoc,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  publish: null,
  mac: {
    category: 'public.app-category.music',
    target: dirOnly ? ['dir'] : ['dmg', 'zip'],
    // Unsigned: ad-hoc signature only (Apple Silicon needs one). Signing needs an Apple Developer ID.
    identity: process.env.CSC_LINK ? undefined : null,
    hardenedRuntime: !!process.env.CSC_LINK,
    entitlements: path.join(root, 'desktop', 'resources', 'entitlements.mac.plist'),
    entitlementsInherit: path.join(root, 'desktop', 'resources', 'entitlements.mac.plist'),
    // Notarization, when the Apple secrets are there (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID).
    notarize: !!(process.env.CSC_LINK && process.env.APPLE_TEAM_ID),
    extendInfo: {
      NSMicrophoneUsageDescription: 'OpenBand records your voice or instrument, and turns a hummed melody into notes.',
    },
  },
  // Without a Developer ID, sign ad hoc after packing: Apple Silicon refuses to run an app whose
  // signature doesn't match its contents (Electron's own is broken by our Info.plist and files).
  afterPack: async (ctx) => {
    if (ctx.electronPlatformName !== 'darwin' || process.env.CSC_LINK) return;
    const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
    execSync(`codesign --force --deep --sign - "${app}"`, { stdio: 'inherit' });
  },
  // Unsigned, macOS blocks the first opening: the way through sits next to the app in the disk image.
  dmg: {
    title: 'OpenBand ${version}',
    window: { width: 560, height: 420 },
    contents: [
      { x: 140, y: 150, type: 'file' },
      { x: 420, y: 150, type: 'link', path: '/Applications' },
      ...(process.env.CSC_LINK ? [] : [{ x: 280, y: 300, type: 'file', path: path.join(stage, OPEN_HELP) }]),
    ],
  },
  win: { target: dirOnly ? ['dir'] : ['nsis'] },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, artifactName: '${productName}-${version}-win-${arch}.${ext}' },
  linux: {
    target: dirOnly ? ['dir'] : ['AppImage', 'deb'],
    category: 'Audio',
    maintainer: 'OpenBand contributors <openband@users.noreply.github.com>',
    synopsis: 'Music studio that you — or your AI — can play',
    mimeTypes: assoc.map((a) => a.mimeType),
  },
  deb: { artifactName: '${productName}-${version}-linux-${arch}.${ext}' },
});
const platform = { darwin: builder.Platform.MAC, win32: builder.Platform.WINDOWS, linux: builder.Platform.LINUX }[process.platform];
const archs = arch ? [arch] : ['x64', 'arm64'];
// One architecture at a time: a single NSIS call with two would make one combined installer.
for (const a of archs) {
  const out = await builder.build({ targets: platform.createTarget(null, builder.Arch[a]), config: makeConfig(), projectDir: stage });
  for (const f of out) console.log(path.relative(root, f));
}
