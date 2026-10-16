const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', Object.freeze({
  state: () => ipcRenderer.invoke('picker:state'),
  choose: (id) => ipcRenderer.send('picker:choose', id ?? null),
  openSettings: () => ipcRenderer.send('picker:settings'),
  setup: () => ipcRenderer.send('picker:setup'),
  relaunch: () => ipcRenderer.send('setup:relaunch')
}));
