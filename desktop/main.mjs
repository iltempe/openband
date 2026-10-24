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
import { setupNative } from './native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Packaged and staged builds keep dist/ and server/ next to this file; in the checkout they are one up.
const ROOT = fs.existsSync(path.join(here, 'dist')) ? here : path.resolve(here, '..');
const DIST = path.join(ROOT, 'dist');
const SMOKE = process.argv.includes('--smoke');
/** --smoke with OPENBAND_SMOKE_NATIVE=1 (and the fixtures in OPENBAND_PLUGIN_DIRS): native plugins too. */
const SMOKE_NATIVE = SMOKE && process.env.OPENBAND_SMOKE_NATIVE === '1';
/** Tests: never show a window (OPENBAND_DESKTOP_HIDDEN=1). */
const HIDDEN = SMOKE || process.env.OPENBAND_DESKTOP_HIDDEN === '1' || !!process.env.OPENBAND_DESKTOP_SHOT;
const FILE_RE = /\.(openband|openband\.json|midi?|dawproject)$/i;
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
/** The executable AI clients should launch (an AppImage runs from a temporary mount: use the image). */
const exe = () => process.env.APPIMAGE || app.getPath('exe');

// CI containers (and some AppImage setups) can't use Chromium's sandbox; never set by default. (On Linux
// --no-sandbox must also be on the command line: Chromium checks before this code runs.)
if (process.env.OPENBAND_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');
// Smoke tests measure the audio: a fake output keeps the audio clock running without a sound device.
if (SMOKE_NATIVE) app.commandLine.appendSwitch('disable-audio-output');

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
  const q = [port ? `mcp=${port}` : '', SMOKE_NATIVE ? 'debug' : ''].filter(Boolean).join('&');
  void win.loadURL(`openband://app/index.html${q ? `?${q}` : ''}`);
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
// AI servers on this computer (Ollama, LM Studio) only accept web pages they know; the app's own page
// reaches them through here instead, loopback http only.
ipcMain.handle('local-fetch', async (e, url, init = {}) => {
  if (e.sender !== win?.webContents) throw new Error('not allowed');
  const u = new URL(url);
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('Only servers on this computer');
  const res = await net.fetch(url, { method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
  return { status: res.status, statusText: res.statusText, body: await res.text() };
});
ipcMain.handle('connect-clients', (e) => (e.sender === win?.webContents ? connectClients() : []));
setupNative({ root: ROOT, getWin: () => win });

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
  const timer = setTimeout(async () => fail(`timeout${SMOKE_NATIVE ? ` at ${await win.webContents.executeJavaScript('window.__smokeStep').catch(() => '?')}` : ''}`), SMOKE_NATIVE ? 110000 : 60000);
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
    if (!ok.playing || !ok.desktop) return fail(JSON.stringify(ok));
    console.log(`SMOKE OK ${version} ${ok.origin} song="${ok.song}"`);
    if (SMOKE_NATIVE) {
      const r = await win.webContents.executeJavaScript(`(${smokeNative.toString()})()`, true);
      console.log(`SMOKE-NATIVE ${JSON.stringify(r)}`);
      clearTimeout(timer);
      return app.exit(r.ok ? 0 : 1);
    }
    clearTimeout(timer);
    app.exit(0);
  } catch (e) {
    fail(e.message);
  }
}

/**
 * Runs in the page (G8.2): scan the fixture plugins, put the CLAP gain on a track and hear it, then crash
 * the crash fixture and hear the track go on bypassed, restart it.
 */
async function smokeNative() {
  const { engine, useStore, commands } = window.openband;
  const dn = window.openbandDesktop.native;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (x) => (window.__smokeStep = x);
  step('scan');
  const scan = await dn.scan();
  const gain = scan.plugins.find((p) => p.id === 'org.openband.fixture.gain');
  const synth = scan.plugins.find((p) => p.id === 'org.openband.fixture.synth');
  const crash = scan.plugins.find((p) => p.id === 'org.openband.fixture.crash');
  if (!gain || !crash) return { ok: false, why: 'fixtures not found', scan };
  engine.stop();
  await commands.new_project({ name: 'Native', bpm: 120, key: 'C' });
  const t = (await commands.add_track({ kind: 'instrument', instrument: 'aurora-pad', name: 'Pad' })).track_id;
  await commands.add_region({ track_id: t, start_bar: 1, length_bars: 8, notes: [{ pitch: 'C4', start: 0, duration: 32, velocity: 0.8 }] });
  await commands.update_track({ track_id: t, reverb: 0, delay: 0 });
  const rms = async () => {
    engine.position = 0;
    const cap = engine.captureMaster(1.5);
    await engine.play();
    const c = await cap;
    engine.stop();
    await wait(200);
    const x = c.channels[0].subarray(Math.floor(c.sampleRate * 0.5));
    let s = 0;
    for (const v of x) s += v * v;
    return 10 * Math.log10(s / x.length + 1e-12);
  };
  step('dry');
  const dry = await rms();
  const slot = (p) => ({ id: 'n1', url: '', name: p.name, on: true, format: 'clap', native: { id: p.id, vendor: p.vendor, version: p.version, path_hint: p.path } });
  const setSlot = (p) => useStore.getState().commit((d) => { const tr = d.tracks.find((x) => x.id === t); tr.fx = { amp: { on: false, drive: 0, tone: 0, level: 0.7 }, eq: { on: false, low: 0, mid: 0, high: 0, midFreq: 1000 }, comp: { on: false, threshold: -18, ratio: 4, attack: 0.01, release: 0.18, makeup: 0 }, plugins: [slot(p)] }; });
  const status = window.openband.nativeStatus;
  // Wait for the plugin to be running (its host loaded, the latency known) — slower on CI runners.
  const waitLive = async () => {
    for (let i = 0; i < 150 && !status.getState()[`${t}:n1`]?.latency; i++) await wait(100);
    await wait(300);
  };
  status.setState({}, true);
  setSlot(gain);
  await waitLive();
  step('gain');
  const wet = await rms();
  const latency = engine.pdcLatency;
  status.setState({}, true);
  setSlot(crash);
  await waitLive();
  step('crash fixture');
  const before = await rms();
  // The crash fixture aborts at its next block once its "Crash" parameter is on: reach its port through the worklet.
  window.openband.nativeParam(`${t}:n1`, 1, 1);
  for (let i = 0; i < 100 && !status.getState()[`${t}:n1`]?.crashed; i++) await wait(100);
  const crashed = window.openband.nativeStatus.getState()[`${t}:n1`]?.crashed ?? null;
  step('bypassed');
  const after = await rms();
  step('restart');
  await window.openband.restartNative(`${t}:n1`);
  await wait(1500);
  const restarted = !window.openband.nativeStatus.getState()[`${t}:n1`]?.crashed;
  const back = await rms();
  // G8.3: a native instrument plays the timeline; a parameter follows its automation; the plugin's own
  // controls land in the song (undo).
  step('instrument');
  useStore.getState().commit((d) => {
    d.tracks.find((x) => x.id === t).mute = true;
    d.instruments = [...(d.instruments ?? []), { id: 'nat_synth', name: synth.name, kind: 'instrument', source: 'native', zones: [], attack: 0, release: 0, format: 'clap', native: { id: synth.id, vendor: synth.vendor, version: synth.version, path_hint: synth.path } }];
  });
  const s2 = (await commands.add_track({ kind: 'instrument', name: 'Synth' })).track_id;
  useStore.getState().commit((d) => void (d.tracks.find((x) => x.id === s2).instrument = 'nat_synth'));
  await commands.add_region({ track_id: s2, start_bar: 1, length_bars: 4, notes: [{ pitch: 'A4', start: 0, duration: 16, velocity: 0.9 }] });
  await commands.update_track({ track_id: s2, reverb: 0, delay: 0 });
  await commands.set_automation({ track_id: s2, target: { kind: 'plugin', slot_id: null, param_id: '2' }, points: [{ bar: 1, value: 0.5 }, { bar: 2, value: 0.5 }, { bar: 2.02, value: 0.05 }, { bar: 4, value: 0.05 }] });
  for (let i = 0; i < 150 && !status.getState()[`${s2}:instrument`]?.latency; i++) await wait(100);
  await wait(400);
  engine.position = 0;
  const cap2 = engine.captureMaster(3.4);
  await engine.play();
  const c2 = await cap2;
  engine.stop();
  const rmsAt = (from, to) => {
    const x = c2.channels[0].subarray(Math.floor(from * c2.sampleRate), Math.floor(to * c2.sampleRate));
    let s = 0;
    for (const v of x) s += v * v;
    return 10 * Math.log10(s / x.length + 1e-12);
  };
  // 120 BPM: bar 2 starts at 2 s; the latency of the bridge is compensated by the engine.
  const plays = rmsAt(0.6, 1.8);
  const automated = rmsAt(2.4, 3.3) - plays;
  // Without automation (which would set Level again), the knob the plugin turns is what gets saved.
  await commands.clear_automation({ track_id: s2 });
  await wait(300);
  const before64 = useStore.getState().project.instruments.find((i) => i.id === 'nat_synth').native.state_b64 ?? null;
  // As if the user turned Level in the plugin's own window (the fixture does it on note 127).
  window.openband.liveNative(`${s2}:instrument`).event(0, { key: 127, value: 1 });
  const stateNow = () => useStore.getState().project.instruments.find((i) => i.id === 'nat_synth').native.state_b64 ?? null;
  for (let i = 0; i < 50 && stateNow() === before64; i++) await wait(100);
  const saved = atob(useStore.getState().project.instruments.find((i) => i.id === 'nat_synth').native.state_b64 ?? '');
  // G8.4: exports render native plugins through their host (offline, in batches): the same every time,
  // and like what plays live.
  step('export');
  useStore.getState().commit((d) => void (d.instruments.find((i) => i.id === 'nat_synth').native.state_b64 = btoa('gain=0.500000')));
  await commands.set_automation({ track_id: s2, target: { kind: 'plugin', slot_id: null, param_id: '2' }, points: [{ bar: 1, value: 0.5 }, { bar: 2, value: 0.5 }, { bar: 2.02, value: 0.05 }, { bar: 4, value: 0.05 }] });
  await wait(1500);
  const proj = useStore.getState().project;
  const exp1 = await window.openband.renderBuffer(proj, { sampleRate: 48000, tailSeconds: 0.5 });
  const exp2 = await window.openband.renderBuffer(proj, { sampleRate: 48000, tailSeconds: 0.5, nonce: 2 });
  let same = exp1.length === exp2.length;
  for (let c = 0; c < 2 && same; c++) {
    const a = exp1.getChannelData(c);
    const b = exp2.getChannelData(c);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
  }
  engine.position = 0;
  const cap3 = engine.captureMaster(3.4);
  await engine.play();
  const live3 = await cap3;
  engine.stop();
  const windows = (x, sr) => {
    const f = x.findIndex((v) => Math.abs(v) > 1e-3);
    const n = Math.floor(sr * 0.1);
    const out = [];
    for (let i = f; i + n <= x.length && out.length < 30; i += n) {
      let e = 0;
      for (let k = 0; k < n; k++) e += x[i + k] ** 2;
      out.push(10 * Math.log10(e / n + 1e-12));
    }
    return out;
  };
  const L = windows(live3.channels[0], live3.sampleRate);
  const E = windows(exp1.getChannelData(0), 48000);
  // Skip the windows around the automation step (the two can differ by a few ms there).
  const diffs = L.map((v, i) => Math.abs(v - E[i])).filter((d, i) => Number.isFinite(d) && Math.abs(i - 19) > 1);
  const liveVsExport = Math.max(...diffs);
  const exportRms = E.length ? E[5] : -999;
  step('freeze');
  const fr = await window.openband.freeze.freezeNativeTracks();
  const ft = useStore.getState().project.tracks.find((x) => x.id === s2);
  const frozenOk = !!ft.frozen && ft.frozen.hash === window.openband.freeze.trackHash(useStore.getState().project, ft) && ft.frozen.plugins.includes(synth.name);
  const ok = Math.abs(wet - dry + 6) < 1 && latency === 6 * 128 && Math.abs(before - dry) < 1 && !!crashed && Math.abs(after - dry) < 1 && restarted && Math.abs(back - dry) < 1 && plays > -40 && automated < -15 && /^gain=0\.25/.test(saved) && same && exportRms > -40 && liveVsExport < 1 && frozenOk;
  return { ok, dry: +dry.toFixed(1), gain: +(wet - dry).toFixed(2), latency, instrument: +plays.toFixed(1), automation: +automated.toFixed(1), saved: saved.slice(0, 12), exportsIdentical: same, exportRms: +exportRms.toFixed(1), liveVsExport: +liveVsExport.toFixed(2), frozen: fr.frozen.join('+'), frozenOk, crashFixture: +(before - dry).toFixed(2), crashed, bypassed: +(after - dry).toFixed(2), restarted, back: +(back - dry).toFixed(2) };
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
        if (${JSON.stringify(process.env.OPENBAND_DESKTOP_SHOT_VIEW === 'native-instrument')}) {
          // Docs: the first installed native instrument, added from the plugin browser, with its panel.
          localStorage.setItem('openband.nativeWarned', '1');
          [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Plugins')?.click();
          const pick = () => {
            const row = [...document.querySelectorAll('.plug-native .plug-item')].find((r) => /instrument/i.test(r.textContent));
            if (!row) return setTimeout(pick, 300);
            row.querySelector('button').click();
            setTimeout(resolve, 6000);
          };
          return setTimeout(pick, 500);
        }
        if (${JSON.stringify(process.env.OPENBAND_DESKTOP_SHOT_VIEW === 'plugins')}) {
          [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Plugins')?.click();
          return setTimeout(resolve, 14000);
        }
        document.querySelector('.ai-pill')?.click();
        setTimeout(resolve, 1200);
      }, 400);
    };
    step();
  })`);
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  app.exit(0);
}
