'use strict';

// Bridge for a helper clone window. Same shape as the main overlay bridge
// (so the overlay page runs unchanged), but only a few calls do anything:
// a helper can't listen; dragging it moves its window (main clamps it).
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};
const noop = () => {};

contextBridge.exposeInMainWorld('core', {
  init: () => ipcRenderer.invoke('clone:init'),
  orbClick: () => ipcRenderer.send('clone:click'),
  interaction: (kind) => ipcRenderer.send('clone:interaction', String(kind)),
  spoken: noop,
  speechIdle: () => ipcRenderer.send('clone:idle'),
  ready: noop,
  log: (msg) => ipcRenderer.send('overlay:log', `[clone] ${String(msg)}`),
  rendererFailed: noop,
  orbBounds: noop,
  orbDrag: noop,
  cloneDrag: (d) => ipcRenderer.send('clone:drag', { phase: String(d.phase), dx: Number(d.dx) || 0, dy: Number(d.dy) || 0 }),
  orbHome: noop,
  orbAnchor: noop,
  stageNeed: noop,
  sendAudio: noop,
  listenCancelled: noop,
  wakeCheck: noop,
  bargeIn: noop,
  holdTalk: noop,
  onWakeResult: () => noop,
  onSpeakItem: on('speak:item'),
  onState: on('state'),
  onAttention: on('attention'),
  onListenStart: () => noop,
  onListenStop: () => noop,
  onSpeechStop: on('speech:stop'),
  onHover: on('hover'),
  onConfig: on('config'),
  onDockVisible: () => noop,
  onStage: () => noop,
  onCursor: () => noop,
  onDissolve: on('dissolve'),
  onAssemble: on('assemble'),
  onRelocate: () => noop,
  onSpeaker: () => noop,
  onRender: on('render'),
});
