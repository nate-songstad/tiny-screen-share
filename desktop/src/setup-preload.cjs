const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', Object.freeze({
  state: () => ipcRenderer.invoke('setup:state'),
  access: () => ipcRenderer.invoke('setup:access'),
  register: () => ipcRenderer.send('setup:register'),
  move: () => ipcRenderer.invoke('setup:move'),
  relaunch: () => ipcRenderer.send('setup:relaunch'),
  finish: () => ipcRenderer.send('setup:finish')
}));
