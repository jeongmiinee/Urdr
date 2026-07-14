const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');

let mainWindow = null;

function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b111b',
    title: 'World Archive v0.99x',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const devUrl = process.env.WORLD_ARCHIVE_DEV_URL;
  if (devUrl) window.loadURL(devUrl);
  else window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow = window;
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  return window;
}

ipcMain.handle('world-archive:quit', async () => { app.quit(); return true; });

ipcMain.handle('world-archive:open-project', async () => {
  const result = await dialog.showOpenDialog({
    title: '세계 프로젝트 불러오기',
    properties: ['openFile'],
    filters: [{ name: 'World Archive JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  return { name: path.basename(filePath), text: await fs.readFile(filePath, 'utf8') };
});



ipcMain.handle('world-archive:load-demo', async () => {
  const filePath = path.join(__dirname, '..', 'dist', 'demoProjectData.json.gz');
  return gunzipSync(await fs.readFile(filePath)).toString('utf8');
});

ipcMain.handle('world-archive:runtime-metrics', async () => {
  const mainMemory = await process.getProcessMemoryInfo();
  const processes = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    cpuPercent: metric.cpu?.percentCPUUsage ?? 0,
    idleWakeupsPerSecond: metric.cpu?.idleWakeupsPerSecond ?? 0,
    memory: metric.memory ?? null,
  }));
  return {
    capturedAt: new Date().toISOString(),
    mainMemory,
    processes,
  };
});

ipcMain.handle('world-archive:save-project', async (_event, payload) => {
  const result = await dialog.showSaveDialog({
    title: '세계 프로젝트 내보내기',
    defaultPath: payload?.suggestedName || 'world-project.json',
    filters: [{ name: 'World Archive JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return false;
  await fs.writeFile(result.filePath, String(payload?.text ?? ''), 'utf8');
  return true;
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
      else { mainWindow.show(); mainWindow.focus(); }
    });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { mainWindow = null; });
}
