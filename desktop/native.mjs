// Native plugins in the desktop app (G8): the main process scans the plugin folders and runs each plugin
// in an openband-plughost process of its own; audio goes between the plugin's AudioWorklet in the page and
// its host over a MessagePort straight from here (never through the page's main thread). A host that
// crashes takes only its plugin down: the page is told, plays the track bypassed, and can restart it.
import { MessageChannelMain, app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXE = process.platform === 'win32' ? 'openband-plughost.exe' : 'openband-plughost';

export function setupNative({ root, getWin }) {
  let mod = null;
  // A file:// URL: on Windows a bare path (d:\…) is not a module specifier.
  const load = async () => (mod ??= await import(pathToFileURL(path.join(root, 'server', 'plughost.mjs')).href));
  const host = () => {
    const packaged = path.join(process.resourcesPath ?? '', 'plughost', EXE);
    return [process.env.OPENBAND_PLUGHOST, packaged, path.join(root, 'build', 'plughost', EXE)].find((p) => p && fs.existsSync(p)) ?? null;
  };
  const settingsFile = () => path.join(app.getPath('userData'), 'native-plugins.json');
  const userDirs = () => {
    try {
      return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).dirs ?? [];
    } catch {
      return [];
    }
  };
  // Test folders (fixtures) come from the environment, never from the page.
  const envDirs = () => (process.env.OPENBAND_PLUGIN_DIRS ?? '').split(path.delimiter).filter(Boolean);
  const dirs = async () => [...(await load()).clapDirs(), ...userDirs(), ...envDirs()];
  /** Bundles a plugin may be loaded from: only what is in the plugin folders. */
  const allowed = async (p) => (await load()).findBundles(await dirs()).includes(p);

  const sessions = new Map(); // key → { session, port, opts, info }
  const fromPage = (e) => e.sender === getWin()?.webContents;

  ipcMain.handle('native-info', () => ({ available: !!host(), host: host() ? path.basename(host()) : null }));

  ipcMain.handle('native-scan', async (e, { retry = [] } = {}) => {
    if (!fromPage(e)) throw new Error('not allowed');
    const h = host();
    if (!h) return { plugins: [], failed: [], available: false };
    const r = await (await load()).scanPlugins({ host: h, dirs: await dirs(), cacheFile: path.join(app.getPath('userData'), 'plugins-cache.json'), retry });
    return { ...r, available: true };
  });

  async function open(e, opts) {
    const { key, path: bundle, id, sampleRate, maxBlock, state } = opts;
    if (!(await allowed(bundle))) throw new Error(`${bundle} is not in a plugin folder`);
    const h = host();
    if (!h) throw new Error('The plugin host is not installed');
    close(key);
    const { PlugHostSession } = await load();
    const session = new PlugHostSession(h);
    const info = await session.load({ path: bundle, id, sampleRate, maxBlock });
    if (state) await session.setState(Buffer.from(state, 'base64')).catch(() => false);
    const { port1, port2 } = new MessageChannelMain();
    port1.on('message', ({ data }) => {
      if (data?.type === 'block') session.process(data.n, data.data, data.events ?? []);
      else if (data?.type === 'param') session.setParam(data.id, data.value);
    });
    port1.start();
    session.on('block', ({ seq, channels }) => port1.postMessage({ type: 'block', n: seq, data: channels }));
    session.on('latency', (latency) => port1.postMessage({ type: 'latency', latency }));
    // What happens in the plugin's own window: values, gestures (Touch/Latch), state changes (undo).
    const toPage = (type) => (e) => getWin()?.webContents.send('native-event', { key, type, ...(e && typeof e === 'object' ? e : {}) });
    session.on('param', toPage('param'));
    session.on('gesture', toPage('gesture'));
    session.on('dirty', toPage('dirty'));
    session.on('gui', toPage('gui'));
    session.on('exit', ({ crashed, signal, code }) => {
      if (!crashed) return;
      const reason = signal ? `crashed (${signal})` : `stopped (exit ${code})`;
      port1.postMessage({ type: 'crashed', reason });
      getWin()?.webContents.send('native-crashed', { key, name: info.name, reason });
    });
    sessions.set(key, { session, port: port1, opts, info });
    e.sender.postMessage('native-port', { key, info }, [port2]);
    return info;
  }

  function close(key) {
    const s = sessions.get(key);
    if (!s) return;
    sessions.delete(key);
    s.port.close();
    s.session.close();
  }

  ipcMain.handle('native-open', (e, opts) => {
    if (!fromPage(e)) throw new Error('not allowed');
    return open(e, opts);
  });
  // A crashed plugin, started again with the state it had when it was last saved.
  ipcMain.handle('native-restart', (e, { key, state }) => {
    if (!fromPage(e)) throw new Error('not allowed');
    const s = sessions.get(key);
    if (!s) throw new Error('unknown plugin');
    return open(e, { ...s.opts, state: state ?? s.opts.state });
  });
  ipcMain.handle('native-close', (e, { key }) => {
    if (fromPage(e)) close(key);
  });
  ipcMain.handle('native-state', async (e, { key }) => {
    if (!fromPage(e)) throw new Error('not allowed');
    const s = sessions.get(key);
    if (!s?.session.alive) return null;
    return (await s.session.getState()).toString('base64');
  });
  const live = (e, key) => {
    if (!fromPage(e)) throw new Error('not allowed');
    const s = sessions.get(key);
    if (!s?.session.alive) throw new Error('This plugin is not running');
    return s.session;
  };
  ipcMain.handle('native-gui', (e, { key, open, title }) => (open ? live(e, key).openGui(title ?? 'Plugin') : live(e, key).closeGui()));
  ipcMain.handle('native-values', (e, { key }) => live(e, key).values());
  ipcMain.handle('native-set-state', (e, { key, state }) => live(e, key).setState(Buffer.from(state, 'base64')));
  ipcMain.handle('native-add-dir', (e, dir) => {
    if (!fromPage(e)) throw new Error('not allowed');
    const list = [...new Set([...userDirs(), String(dir)])];
    fs.writeFileSync(settingsFile(), JSON.stringify({ dirs: list }));
    return list;
  });

  app.on('will-quit', () => {
    for (const key of [...sessions.keys()]) close(key);
    mod?.stopScans();
  });
}
