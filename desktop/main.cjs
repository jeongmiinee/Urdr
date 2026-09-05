const { app, BrowserWindow, crashReporter, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');

let mainWindow = null;
let pendingProjectArgument = null;
const smokeTestMode = process.argv.includes('--smoke-test');

if (smokeTestMode) {
  app.setPath('userData', path.join(app.getPath('temp'), `urdr-v2.5-smoke-${process.pid}`));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('no-sandbox');
}

crashReporter.start({ uploadToServer: false });

async function writeRuntimeLog(message) {
  try {
    const stamp = new Date().toISOString();
    await fs.mkdir(app.getPath('logs'), { recursive: true });
    await fs.appendFile(path.join(app.getPath('logs'), 'world-archive.log'), `[${stamp}] ${message}\n`, 'utf8');
  } catch (error) {
    console.error('Runtime log write failed:', error);
  }
}

function projectPathFromArguments(argv) {
  return argv.find((argument) => {
    const extension = path.extname(argument).toLowerCase();
    return extension === '.worldarchive' || extension === '.json';
  }) ?? null;
}

async function readProjectArgument(filePath) {
  if (!filePath) return null;
  const extension = path.extname(filePath).toLowerCase();
  if (!['.worldarchive', '.json'].includes(extension)) return null;
  if (extension === '.worldarchive')
    return { name: path.basename(filePath), bytes: new Uint8Array(await fs.readFile(filePath)) };
  return { name: path.basename(filePath), text: await fs.readFile(filePath, 'utf8') };
}

async function forwardProjectArgument(filePath) {
  if (!filePath) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) {
    pendingProjectArgument = filePath;
    return;
  }
  try {
    const project = await readProjectArgument(filePath);
    if (project) mainWindow.webContents.send('world-archive:forwarded-project', project);
  } catch (error) {
    void writeRuntimeLog(`forwarded project read failed: ${error?.stack ?? error}`);
  }
}

function createWindow() {
  const window = new BrowserWindow({
    show: !smokeTestMode,
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b111b',
    title: 'URDR',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const devUrl = process.env.WORLD_ARCHIVE_DEV_URL;
  window.webContents.once('did-finish-load', () => {
    if (pendingProjectArgument) {
      const filePath = pendingProjectArgument;
      pendingProjectArgument = null;
      void forwardProjectArgument(filePath);
    }
    if (smokeTestMode) app.exit(0);
  });
  window.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`Renderer load failed (${errorCode}): ${errorDescription}`);
    void writeRuntimeLog(`renderer load failed (${errorCode}): ${errorDescription}`);
    if (smokeTestMode) app.exit(1);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    void writeRuntimeLog(`renderer process gone: ${details.reason}, exitCode=${details.exitCode}`);
  });
  window.on('unresponsive', () => { void writeRuntimeLog('main window became unresponsive'); });
  if (devUrl) window.loadURL(devUrl);
  else window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow = window;
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  return window;
}

ipcMain.handle('world-archive:quit', async () => { app.quit(); return true; });

ipcMain.handle('world-archive:open-project', async (_event, language = 'ko') => {
  const result = await dialog.showOpenDialog({
    title: language === 'en' ? 'Open World Project' : '세계 프로젝트 불러오기',
    properties: ['openFile'],
    filters: [
      { name: 'URDR Project', extensions: ['worldarchive', 'json'] },
      { name: 'URDR Package', extensions: ['worldarchive'] },
      { name: 'Legacy JSON', extensions: ['json'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  if (path.extname(filePath).toLowerCase() === '.worldarchive')
    return { name: path.basename(filePath), bytes: new Uint8Array(await fs.readFile(filePath)) };
  return { name: path.basename(filePath), text: await fs.readFile(filePath, 'utf8') };
});



ipcMain.handle('world-archive:load-demo', async (_event, language = 'ko') => {
  const filename = language === 'en' ? 'demoProjectData.en.json.gz' : 'demoProjectData.json.gz';
  const filePath = path.join(__dirname, '..', 'dist', filename);
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
    title: payload?.language === 'en' ? 'Export World Project' : '세계 프로젝트 내보내기',
    defaultPath: payload?.suggestedName || 'world-project.json',
    filters: [{ name: 'URDR JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return false;
  await fs.writeFile(result.filePath, String(payload?.text ?? ''), 'utf8');
  return true;
});

ipcMain.handle('world-archive:save-binary', async (_event, payload) => {
  const suggestedName = String(payload?.suggestedName || 'world-project.worldarchive');
  const extension = path.extname(suggestedName).toLowerCase().replace('.', '') || 'worldarchive';
  const result = await dialog.showSaveDialog({
    title: payload?.language === 'en' ? 'Export World Project' : '세계 프로젝트 내보내기',
    defaultPath: suggestedName,
    filters: [{ name: extension === 'worldarchive' ? 'URDR Package' : 'ZIP Archive', extensions: [extension] }],
    });
    if (result.canceled || !result.filePath) return false;
    const temporaryPath = `${result.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(temporaryPath, Buffer.from(payload?.bytes ?? []));
      await fs.rename(temporaryPath, result.filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    return true;
  });

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  pendingProjectArgument = projectPathFromArguments(process.argv);
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    void forwardProjectArgument(projectPathFromArguments(argv));
  });
  app.whenReady().then(() => {
    app.setAppLogsPath();
    void writeRuntimeLog(`URDR started; Electron ${process.versions.electron}; Chromium ${process.versions.chrome}`);
    createWindow();
    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
      else { mainWindow.show(); mainWindow.focus(); }
    });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => {
    void writeRuntimeLog('URDR is shutting down cleanly');
    mainWindow = null;
  });
}

process.on('uncaughtException', (error) => {
  void writeRuntimeLog(`uncaught exception: ${error?.stack ?? error}`);
});
process.on('unhandledRejection', (reason) => {
  void writeRuntimeLog(`unhandled rejection: ${reason?.stack ?? reason}`);
});
