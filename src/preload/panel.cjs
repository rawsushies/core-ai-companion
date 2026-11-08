'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('panel', {
  init: () => ipcRenderer.invoke('panel:init'),
  ask: (text, withScreen) => ipcRenderer.send('panel:ask', { text, withScreen }),
  stop: () => ipcRenderer.send('panel:stop'),
  reset: () => ipcRenderer.send('panel:reset'),
  openConfig: () => ipcRenderer.send('panel:openConfig'),
  reload: () => ipcRenderer.send('panel:reload'),
  hide: () => ipcRenderer.send('panel:hide'),
  copyToken: () => ipcRenderer.send('panel:copyToken'),
  onTranscript: on('transcript:add'),
  onTranscriptReset: on('transcript:reset'),
  onStatus: on('status'),
  onFocusInput: on('focus-input'),
});
