'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pager', {
  getState: () => ipcRenderer.invoke('get-state'),
  setName: (name) => ipcRenderer.invoke('set-name', name),
  sendPage: (payload) => ipcRenderer.invoke('send-page', payload),
  setDnd: (minutes) => ipcRenderer.invoke('set-dnd', minutes),
  acknowledge: (page) => ipcRenderer.invoke('acknowledge', page),
  dismiss: () => ipcRenderer.invoke('dismiss'),
  onRoster: (cb) => ipcRenderer.on('roster', (_e, d) => cb(d)),
  onIncoming: (cb) => ipcRenderer.on('incoming', (_e, d) => cb(d)),
  onAck: (cb) => ipcRenderer.on('ack', (_e, d) => cb(d)),
});
