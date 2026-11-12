'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  state: () => ipcRenderer.invoke('monitor:state'),
  onUpdate: (fn) => ipcRenderer.on('monitor:update', (_e, v) => fn(v)),
  highlight: (i) => ipcRenderer.send('monitor:highlight', Number(i)),
  stop: () => ipcRenderer.send('monitor:stop'),
  close: () => ipcRenderer.send('monitor:close'),
});
