const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const root = path.join(__dirname, '..');

function resolveRuntimePaths() {
  try {
    return {
      viteBin: path.join(
        path.dirname(require.resolve('vite/package.json', { paths: [root] })),
        'bin',
        'vite.js',
      ),
      electronModule: require.resolve('electron', { paths: [root] }),
    };
  } catch (error) {
    console.error('개발 실행에 필요한 패키지를 찾지 못했습니다. 먼저 npm install을 실행하세요.');
    throw error;
  }
}

function waitForPort(port, attempts = 120) {
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (attempts-- <= 0) {
          reject(new Error('Vite 개발 서버를 시작하지 못했습니다.'));
        } else {
          setTimeout(tryConnect, 150);
        }
      });
    };
    tryConnect();
  });
}

function stopProcess(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } else {
    child.kill('SIGTERM');
  }
}

const { viteBin, electronModule } = resolveRuntimePaths();

// Node로 Vite CLI를 직접 실행한다. Windows에서 npm.cmd를 spawn할 때
// 발생할 수 있는 EINVAL 문제를 피하기 위한 방식이다.
const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env },
  windowsHide: false,
});

vite.on('error', (error) => {
  console.error('Vite 개발 서버 실행에 실패했습니다.', error);
  process.exit(1);
});

(async () => {
  try {
    await waitForPort(5173);
    let electronBin;
    try {
      electronBin = require(electronModule);
    } catch (error) {
      throw new Error(
        'Electron 실행 파일을 찾지 못했습니다. npm install이 완전히 끝났는지 확인하세요. 원인: ' +
        (error instanceof Error ? error.message : String(error)),
      );
    }

    const electron = spawn(electronBin, ['.'], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        WORLD_ARCHIVE_DEV_URL: 'http://127.0.0.1:5173',
      },
      windowsHide: false,
    });

    electron.on('error', (error) => {
      console.error('Electron 실행에 실패했습니다.', error);
      stopProcess(vite);
      process.exit(1);
    });

    electron.on('exit', (code) => {
      stopProcess(vite);
      process.exit(code ?? 0);
    });
  } catch (error) {
    console.error(error);
    stopProcess(vite);
    process.exit(1);
  }
})();

process.on('SIGINT', () => stopProcess(vite));
process.on('SIGTERM', () => stopProcess(vite));
process.on('exit', () => stopProcess(vite));
