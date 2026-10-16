const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', Object.freeze({
  onEvent: (listener) => ipcRenderer.on('overlay:event', (event, message) => listener(message))
}));
