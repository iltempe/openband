// The only bridge between the studio page and the app (the page has no Node access). See src/desktop.ts.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('openbandDesktop', {
  version: ipcRenderer.sendSync('version'),
  platform: process.platform,
  onOpenFile: on('open-file'),
  onMenu: on('menu'),
  onBridgePort: on('bridge-port'),
  connectClients: () => ipcRenderer.invoke('connect-clients'),
  localFetch: (url, init) => ipcRenderer.invoke('local-fetch', url, init),
  ready: () => ipcRenderer.send('ready'),
  // Native plugins (G8): the audio of each plugin travels on a MessagePort handed to the page below.
  native: {
    info: () => ipcRenderer.invoke('native-info'),
    scan: (o) => ipcRenderer.invoke('native-scan', o),
    open: (o) => ipcRenderer.invoke('native-open', o),
    restart: (o) => ipcRenderer.invoke('native-restart', o),
    close: (o) => ipcRenderer.invoke('native-close', o),
    state: (o) => ipcRenderer.invoke('native-state', o),
    setState: (o) => ipcRenderer.invoke('native-set-state', o),
    gui: (o) => ipcRenderer.invoke('native-gui', o),
    values: (o) => ipcRenderer.invoke('native-values', o),
    batch: (o) => ipcRenderer.invoke('native-batch', o),
    onEvent: on('native-event'),
    addDir: (d) => ipcRenderer.invoke('native-add-dir', d),
    onCrashed: on('native-crashed'),
  },
});
// MessagePorts can't cross contextBridge: they reach the page as a window message.
ipcRenderer.on('native-port', (e, msg) => window.postMessage({ openbandNativePort: msg.key, info: msg.info }, '*', e.ports));
