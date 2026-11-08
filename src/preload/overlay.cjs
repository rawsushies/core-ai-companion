'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('core', {
  init: () => ipcRenderer.invoke('overlay:init'),
  orbBounds: (b) => ipcRenderer.send('orb:bounds', b),
  orbDrag: (dragging) => ipcRenderer.send('orb:drag', dragging),
  orbClick: () => ipcRenderer.send('orb:click'),
  orbHome: (home) => ipcRenderer.send('orb:home', home),
  orbAnchor: (a) => ipcRenderer.send('orb:anchor', a),
  stageNeed: (r) => ipcRenderer.send('stage:need', r),
  sendAudio: (audio, withScreen) => ipcRenderer.send('listen:audio', { audio, withScreen }),
  listenCancelled: (reason) => ipcRenderer.send('listen:cancelled', reason),
  log: (msg) => ipcRenderer.send('overlay:log', String(msg)),
  rendererFailed: (msg) => ipcRenderer.send('overlay:rendererFailed', String(msg)),
  ready: () => ipcRenderer.send('overlay:ready'),
  onSpeakItem: on('speak:item'),
  onState: on('state'),
  onAttention: on('attention'),
  onListenStart: on('listen:start'),
  onListenStop: on('listen:stop'),
  onSpeechStop: on('speech:stop'),
  onHover: on('hover'),
  onConfig: on('config'),
  onDockVisible: on('dock:visible'),
  onStage: on('stage'),
});
