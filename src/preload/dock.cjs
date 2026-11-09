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
  openSettings: () => ipcRenderer.send('dock:openSettings'),
  onAgentApprove: (fn) => ipcRenderer.on('dock:agent-approve', (_e, v) => fn(v)),
  agentAnswer: (id, answer) => ipcRenderer.send('dock:agent-answer', { id: String(id), answer: String(answer || '') }),
  setInteractive: (v) => ipcRenderer.send('dock:interactive', !!v),
  newChat: () => ipcRenderer.send('dock:reset'),
  brainStatus: () => ipcRenderer.invoke('dock:brainStatus'),
  loginClaude: () => ipcRenderer.send('dock:loginClaude'),
  setupLocal: () => ipcRenderer.send('dock:setupLocal'),
  setKey: (id, key) => ipcRenderer.send('dock:setKey', { id, key }),
  openLink: (id) => ipcRenderer.send('dock:openLink', id),
  onBrain: on('dock:brain'),
  memory: () => ipcRenderer.invoke('dock:memory'),
  memoryForget: (id) => ipcRenderer.send('dock:memoryForget', id),
  memoryEdit: (id, text) => ipcRenderer.send('dock:memoryEdit', { id, text }),
  memoryClear: () => ipcRenderer.send('dock:memoryClear'),
  reminders: () => ipcRenderer.invoke('dock:reminders'),
  reminderCancel: (id) => ipcRenderer.send('dock:reminderCancel', id),
  runAction: (id) => ipcRenderer.send('dock:runAction', id),
  onMemory: on('dock:memory'),
  onReminders: on('dock:reminders'),
  onAction: on('dock:action'),
  diagnostics: () => ipcRenderer.send('dock:diagnostics'),
  setGraphics: (m) => ipcRenderer.send('dock:graphics', m),
  graphicsMode: () => ipcRenderer.invoke('dock:graphicsMode'),
  onMessage: on('dock:message'),
  onDelta: on('dock:delta'),
  onSpeak: on('dock:speak'),
  onDone: on('dock:done'),
  onReset: on('dock:reset'),
  onFocus: on('dock:focus'),
  onSettings: on('dock:settings'),
  onCores: on('dock:cores'),
  onRecipient: on('dock:recipient'),
  onProposal: on('dock:proposal'),
  onProposalUpdate: on('dock:proposal-update'),
  proposal: (id, action) => ipcRenderer.send('dock:proposal', { id, action }),
  onBusy: on('dock:busy'),
});
