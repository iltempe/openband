// OpenBand desktop: the same studio as the web app, in its own window, with the MCP server inside.
//
// - The studio is served from the app's files on the private openband://app scheme (a stable origin, so
//   songs saved in the app's storage are always found again; no port to collide with).
// - AI clients run this same executable in Node mode on server/mcp-server.mjs (see server/desktop.mjs);
//   when that server wants the studio it starts the app with --studio=<its URL>, and the page connects
//   to its bridge on 127.0.0.1 like any local studio.
// - Files opened from the Finder / Explorer / file manager (.openband, .mid, .dawproject) go to the page.
//
//   npm run desktop:dev            run it from the checkout (after npm run build)
//   node scripts/build-desktop.mjs build the installers for this platform
import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, session, shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Packaged and staged builds keep dist/ and server/ next to this file; in the checkout they are one up.
const ROOT = fs.existsSync(path.join(here, 'dist')) ? here : path.resolve(here, '..');
const DIST = path.join(ROOT, 'dist');
const SMOKE = process.argv.includes('--smoke');
/** Tests: never show a window (OPENBAND_DESKTOP_HIDDEN=1). */
const HIDDEN = SMOKE || process.env.OPENBAND_DESKTOP_HIDDEN === '1' || !!process.env.OPENBAND_DESKTOP_SHOT;
const FILE_RE = /\.(openband|openband\.json|midi?|dawproject)$/i;
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
/** The executable AI clients should launch (an AppImage runs from a temporary mount: use the image). */
const exe = () => process.env.APPIMAGE || app.getPath('exe');

// CI containers (and some AppImage setups) can't use Chromium's sandbox; never set by default. (On Linux
// --no-sandbox must also be on the command line: Chromium checks before this code runs.)
if (process.env.OPENBAND_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');

protocol.registerSchemesAsPrivileged([
  { scheme: 'openband', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// Where songs live: the app's own profile. Tests and screenshots get a throwaway one (never the user's),
// and a run from the checkout keeps its own, apart from the installed app.
app.setName('OpenBand');
if (process.env.OPENBAND_DESKTOP_PROFILE) app.setPath('userData', process.env.OPENBAND_DESKTOP_PROFILE);
else if (SMOKE || process.env.OPENBAND_DESKTOP_SHOT) app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), 'openband-test-')));
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'OpenBand (dev)'));

if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();

let win = null;
let pageReady = false;
const pending = []; // [channel, payload] sent once the page is listening

function send(channel, payload) {
  if (win && pageReady) win.webContents.send(channel, payload);
  else pending.push([channel, payload]);
}

/** Arguments from a launch (first or second instance): files to open and the bridge port of an MCP server. */
function handleArgs(argv) {
  for (const a of argv) {
    const studio = /^--studio=(.+)$/.exec(a);
    if (studio) {
      try {
        const u = new URL(studio[1]);
        const port = Number(u.searchParams.get('mcp') || u.port || 7777);
        if (port) send('bridge-port', port);
      } catch {
        // not a URL
      }
    } else if (FILE_RE.test(a) && fs.existsSync(a)) openFile(a);
  }
}

function openFile(file) {
  try {
    send('open-file', { name: path.basename(file), data: new Uint8Array(fs.readFileSync(file)) });
    app.addRecentDocument(file);
    if (!HIDDEN) win?.show();
  } catch (e) {
    dialog.showErrorBox('OpenBand', `Could not open ${file}: ${e.message}`);
  }
}

// macOS sends files (double-click, drag onto the Dock icon) as events, possibly before the app is ready.
app.on('open-file', (e, file) => {
  e.preventDefault();
  openFile(file);
});

app.on('second-instance', (_e, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  handleArgs(argv.slice(1));
});

// ---------------------------------------------------------------- window

const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return { width: 1440, height: 900 };
  }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {
    // not important
  }
}

function createWindow(port) {
  const b = loadBounds();
  win = new BrowserWindow({
    ...b,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1117',
    title: 'OpenBand',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => !HIDDEN && win.show());
  win.on('close', saveBounds);
  win.on('closed', () => {
    win = null;
    pageReady = false;
  });
  // Links to the web open in the browser; the window itself never leaves the studio.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('openband://app/')) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  void win.loadURL(`openband://app/index.html${port ? `?mcp=${port}` : ''}`);
}

// ---------------------------------------------------------------- the studio's files

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain' };

function serveStudio() {
  protocol.handle('openband', async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'app') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(DIST, rel);
    if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    return new Response(res.body, { status: 200, headers: { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' } });
  });
}

// ---------------------------------------------------------------- permissions

function permissions() {
  const allowed = new Set(['media', 'midi', 'midiSysex', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler(async (wc, permission, done, details) => {
    if (!wc.getURL().startsWith('openband://app/') || !allowed.has(permission)) return done(false);
    // macOS asks once for the microphone on behalf of the app (Info.plist explains why).
    if (permission === 'media' && process.platform === 'darwin' && details.mediaTypes?.includes('audio')) return done(await systemPreferences.askForMediaAccess('microphone'));
    done(true);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => !!wc?.getURL().startsWith('openband://app/') && allowed.has(permission));
}

// ---------------------------------------------------------------- AI clients

async function connectClients() {
  const { connectClients: connect, desktopEntry } = await import(pathToFileURL(path.join(ROOT, 'server', 'desktop.mjs')).toString());
  return connect(desktopEntry({ exe: exe(), root: ROOT }));
}

async function connectFromMenu() {
  const misplaced = process.platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder();
  if (misplaced) {
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Move to Applications', 'Cancel'], message: 'Move OpenBand to the Applications folder first?', detail: 'Your AI apps will start OpenBand from where it is now: if it stays in Downloads or on the disk image, they will lose it.' });
    if (r.response !== 0) return;
    app.moveToApplicationsFolder();
    return;
  }
  const results = await connectClients();
  const label = { added: '✓ added', already: '✓ already set up', failed: '✗ failed', missing: '– not found' };
  await dialog.showMessageBox(win, {
    type: 'info',
    message: 'OpenBand and your AI apps',
    detail: `${results.map((r) => `${r.name}: ${label[r.status]}${r.detail && r.detail !== 'restart' ? ` (${r.detail})` : ''}`).join('\n')}\n\nRestart Claude Desktop (or your AI app) and ask it for a song: the studio opens here.`,
  });
}

// ---------------------------------------------------------------- updates

async function checkUpdates({ manual = false } = {}) {
  const { checkForUpdate } = await import(pathToFileURL(path.join(ROOT, 'server', 'update.mjs')).toString());
  // A manual check skips the once-a-day cache.
  const r = await checkForUpdate({ current: version, ...(manual ? { now: Date.now() + 2 * 86400000 } : {}) });
  if (r?.update_available) {
    const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['Download', 'Later'], message: `OpenBand ${r.latest} is available`, detail: `You have ${version}. Download the new version and install it over this one: your songs stay.` });
    if (response === 0) void shell.openExternal(`https://github.com/iltempe/openband/releases/tag/v${r.latest}`);
  } else if (manual) await dialog.showMessageBox(win, { type: 'info', message: r ? `OpenBand ${version} is the latest version.` : 'Could not check for updates (offline?).' });
}

// ---------------------------------------------------------------- menus

function buildMenu() {
  const mac = process.platform === 'darwin';
  const act = (action) => () => send('menu', action);
  // Shortcuts the studio handles itself are shown but not captured (registerAccelerator: false).
  const shown = (accelerator) => ({ accelerator, registerAccelerator: false });
  const template = [
    ...(mac ? [{ role: 'appMenu', submenu: [{ role: 'about' }, { label: 'Check for Updates…', click: () => void checkUpdates({ manual: true }) }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Song', accelerator: 'CmdOrCtrl+N', click: act('new') },
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Songs', extensions: ['openband', 'json', 'mid', 'midi', 'dawproject'] }] });
            if (!r.canceled) r.filePaths.forEach(openFile);
          },
        },
        { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        { label: 'Save as .openband…', accelerator: 'CmdOrCtrl+S', click: act('save') },
        { label: 'Export WAV…', accelerator: 'CmdOrCtrl+E', click: act('export-wav') },
        { label: 'Export MIDI…', click: act('export-midi') },
        { label: 'Export DAWproject…', click: act('export-dawproject') },
        { type: 'separator' },
        { label: 'Connect to Claude and other AI apps…', click: () => void connectFromMenu() },
        ...(mac ? [{ type: 'separator' }, { role: 'close' }] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', ...shown('CmdOrCtrl+Z'), click: act('undo') },
        { label: 'Redo', ...shown('Shift+CmdOrCtrl+Z'), click: act('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll', registerAccelerator: false },
      ],
    },
    { label: 'View', submenu: [{ label: 'AI Panel', click: act('ai') }, { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'OpenBand on GitHub', click: () => void shell.openExternal('https://github.com/iltempe/openband') },
        { label: 'Desktop app guide', click: () => void shell.openExternal('https://github.com/iltempe/openband/blob/main/docs/DESKTOP.md') },
        { label: 'Report a Problem', click: () => void shell.openExternal('https://github.com/iltempe/openband/issues/new?template=bug.yml') },
        ...(mac ? [] : [{ type: 'separator' }, { label: 'Check for Updates…', click: () => void checkUpdates({ manual: true }) }, { label: `About OpenBand ${version}`, click: () => void dialog.showMessageBox(win, { message: `OpenBand ${version}`, detail: 'An open-source music studio that you — or your AI — can play. MIT license.' }) }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- start

ipcMain.on('ready', (e) => {
  if (e.sender !== win?.webContents) return;
  pageReady = true;
  for (const [c, p] of pending.splice(0)) win.webContents.send(c, p);
});
ipcMain.on('version', (e) => (e.returnValue = version));
ipcMain.handle('connect-clients', (e) => (e.sender === win?.webContents ? connectClients() : []));

app.setAboutPanelOptions?.({ applicationName: 'OpenBand', applicationVersion: version, copyright: 'MIT license' });

app.whenReady().then(() => {
  serveStudio();
  permissions();
  buildMenu();
  const studio = process.argv.map((a) => /^--studio=(.+)$/.exec(a)?.[1]).find(Boolean);
  let port = null;
  try {
    if (studio) port = Number(new URL(studio).searchParams.get('mcp') || new URL(studio).port || 7777);
  } catch {
    // ignore
  }
  createWindow(port);
  handleArgs(process.argv.slice(1).filter((a) => !a.startsWith('--studio=')));
  if (SMOKE) return smoke();
  if (process.env.OPENBAND_DESKTOP_SHOT) return shot(process.env.OPENBAND_DESKTOP_SHOT);
  setTimeout(() => void checkUpdates().catch(() => {}), 5000);
  app.on('activate', () => !win && createWindow(null));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE) app.quit();
});

/** --smoke: the studio loads, the audio engine starts and "Surprise me" plays; then quit (CI). */
async function smoke() {
  const fail = (m) => {
    console.error(`SMOKE FAIL ${m}`);
    app.exit(1);
  };
  const timer = setTimeout(() => fail('timeout'), 60000);
  try {
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    const ok = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const t0 = Date.now();
      const step = () => {
        const b = document.querySelector('.welcome-choice');
        if (b && Date.now() - t0 < 2500 && ${JSON.stringify(process.argv.some((a) => FILE_RE.test(a)))}) return setTimeout(step, 100); // let an opened file land first
        if (b) { const song = document.querySelector('.project-name')?.value ?? ''; b.click(); const wait = () => document.querySelector('.t-play.on') ? resolve({ playing: true, desktop: !!window.openbandDesktop, origin: location.origin, song }) : Date.now() - t0 > 30000 ? resolve({ playing: false }) : setTimeout(wait, 100); wait(); }
        else if (Date.now() - t0 > 30000) resolve({ playing: false, reason: 'no welcome screen' });
        else setTimeout(step, 100);
      };
      step();
    })`, true);
    clearTimeout(timer);
    if (!ok.playing || !ok.desktop) return fail(JSON.stringify(ok));
    console.log(`SMOKE OK ${version} ${ok.origin} song="${ok.song}"`);
    app.exit(0);
  } catch (e) {
    fail(e.message);
  }
}

/** OPENBAND_DESKTOP_SHOT=file.png (docs): the studio with the AI panel on the "AI apps" tab, then quit. */
async function shot(file) {
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  win.setContentSize(1440, 900);
  await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const step = () => {
      const enter = document.querySelector('.welcome-more .btn.primary');
      if (!enter) return setTimeout(step, 100);
      enter.click();
      setTimeout(() => {
        [...document.querySelectorAll('.tour-card button')].at(-1)?.click();
        document.querySelector('.ai-pill')?.click();
        setTimeout(resolve, 1200);
      }, 400);
    };
    step();
  })`);
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  app.exit(0);
}
