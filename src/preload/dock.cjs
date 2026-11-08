'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('dock', {
  init: () => ipcRenderer.invoke('dock:init'),
  ask: (text) => ipcRenderer.send('dock:ask', text),
  stop: () => ipcRenderer.send('dock:stop'),
  listen: () => ipcRenderer.send('dock:listen'),
  openPanel: () => ipcRenderer.send('dock:openPanel'),
  hide: () => ipcRenderer.send('dock:hide'),
  resize: (h) => ipcRenderer.send('dock:resize', h),
  setSetting: (key, value) => ipcRenderer.send('dock:setting', { key, value }),
  checkUpdates: () => ipcRenderer.send('dock:checkUpdates'),
  newChat: () => ipcRenderer.send('dock:reset'),
  onMessage: on('dock:message'),
  onDelta: on('dock:delta'),
  onDone: on('dock:done'),
  onReset: on('dock:reset'),
  onFocus: on('dock:focus'),
  onSettings: on('dock:settings'),
  onBusy: on('dock:busy'),
});
