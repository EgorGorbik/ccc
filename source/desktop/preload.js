'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('falcon', {
  defaults: () => ipcRenderer.invoke('defaults'),
  login: (data) => ipcRenderer.invoke('login', data),
  onOfficeInbox: (fn) => {
    const listener = (_event, sessions) => fn(Array.isArray(sessions) ? sessions : []);
    ipcRenderer.on('office-inbox', listener);
  },
  officeSignal: (body) => ipcRenderer.invoke('office-signal', body),
  officePull: (body) => ipcRenderer.invoke('office-pull', body),
});
