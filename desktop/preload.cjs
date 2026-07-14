const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('worldArchiveDesktop', {
  platform: process.platform,
  openProjectFile: () => ipcRenderer.invoke('world-archive:open-project'),
  saveProjectFile: (payload) => ipcRenderer.invoke('world-archive:save-project', payload),
  getRuntimeMetrics: () => ipcRenderer.invoke('world-archive:runtime-metrics'),
  loadBundledDemo: () => ipcRenderer.invoke('world-archive:load-demo'),
  quitApp: () => ipcRenderer.invoke('world-archive:quit'),
});
