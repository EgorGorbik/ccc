'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('falcon', {
  defaults: () => ipcRenderer.invoke('defaults'),
  login: (data) => ipcRenderer.invoke('login', data),
});
