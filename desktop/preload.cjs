const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('worldArchiveDesktop', {
  platform: process.platform,
  openProjectFile: (language) => ipcRenderer.invoke('world-archive:open-project', language),
  saveProjectFile: (payload) => ipcRenderer.invoke('world-archive:save-project', payload),
  saveBinaryFile: (payload) => ipcRenderer.invoke('world-archive:save-binary', payload),
  getRuntimeMetrics: () => ipcRenderer.invoke('world-archive:runtime-metrics'),
  loadBundledDemo: (language) => ipcRenderer.invoke('world-archive:load-demo', language),
  onForwardedProject: (callback) => {
    const listener = (_event, project) => callback(project);
    ipcRenderer.on('world-archive:forwarded-project', listener);
    return () => ipcRenderer.removeListener('world-archive:forwarded-project', listener);
  },
  quitApp: () => ipcRenderer.invoke('world-archive:quit'),
});
