'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('center', {
  state: () => ipcRenderer.invoke('center:state'),
  action: (name, arg) => ipcRenderer.invoke('center:action', { name: String(name), arg: arg == null ? null : String(arg) }),
  close: () => ipcRenderer.send('center:close'),
});
