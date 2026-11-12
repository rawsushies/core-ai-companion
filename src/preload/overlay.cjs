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
  interaction: (kind) => ipcRenderer.send('orb:interaction', String(kind)),
  orbHome: (home) => ipcRenderer.send('orb:home', home),
  orbAnchor: (a) => ipcRenderer.send('orb:anchor', a),
  stageNeed: (r) => ipcRenderer.send('stage:need', r),
  sendAudio: (audio, withScreen, speechEndAt) => ipcRenderer.send('listen:audio', { audio, withScreen, speechEndAt }),
  listenCancelled: (reason) => ipcRenderer.send('listen:cancelled', reason),
  listenPause: (audio, speechEndAt) => ipcRenderer.send('listen:pause', { audio, speechEndAt }),
  listenReact: () => ipcRenderer.send('listen:react'),
  listenResume: () => ipcRenderer.send('listen:resume'),
  wakeCheck: (audio) => ipcRenderer.send('wake:check', audio),
  bargeIn: () => ipcRenderer.send('voice:bargein'),
  holdTalk: (on) => ipcRenderer.send('listen:hold', !!on),
  onWakeResult: on('wake:result'),
  log: (msg) => ipcRenderer.send('overlay:log', String(msg)),
  rendererFailed: (msg) => ipcRenderer.send('overlay:rendererFailed', String(msg)),
  ready: () => ipcRenderer.send('overlay:ready'),
  spoken: (text, ms) => ipcRenderer.send('voice:spoken', { text: String(text), ms: Number(ms) || 0 }),
  speechIdle: () => ipcRenderer.send('voice:idle'),
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
  onCursor: on('cursor'),
  onDissolve: on('dissolve'),
  onAssemble: on('assemble'),
  onRelocate: on('relocate'),
  onSpeaker: on('speaker'),
  onGlance: on('glance'),
  onRender: on('render'),
});
