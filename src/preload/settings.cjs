'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  load: () => ipcRenderer.invoke('settings:load'),
  set: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
  action: (name) => ipcRenderer.invoke('settings:action', name),
  close: () => ipcRenderer.send('settings:close'),
});
