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
});
