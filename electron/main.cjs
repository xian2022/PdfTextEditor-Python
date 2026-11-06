const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const http = require('http');

const DIST = path.join(__dirname, '..', 'dist');

// 自定义 app:// 协议承载构建产物：
// 保证 Worker（pdf.js）与 fetch（字体）在打包后都能正常同源加载
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function fontsDir() {
  return path.join(app.getPath('userData'), 'fonts');
}

// ---------------- Python 导出后端 ----------------
// 打包版：resources/backend-bin/pdf-editor-backend(.exe)（CI 用 PyInstaller 构建）
// 开发版：backend/.venv/bin/python backend/app.py（或系统 python3 兜底）
let backendProc = null;
let backendStart = null; // Promise<string> -> 后端地址
let backendUrlStr = '';

function devBackendCommand() {
  const root = path.join(__dirname, '..');
  const appPy = path.join(root, 'backend', 'app.py');
  const venvPy =
    process.platform === 'win32'
      ? path.join(root, 'backend', '.venv', 'Scripts', 'python.exe')
      : path.join(root, 'backend', '.venv', 'bin', 'python');
  if (fs.existsSync(venvPy) && fs.existsSync(appPy)) {
    return { cmd: venvPy, args: [appPy], cwd: path.join(root, 'backend') };
  }
  return { cmd: process.platform === 'win32' ? 'python' : 'python3', args: [appPy], cwd: path.join(root, 'backend') };
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function checkBackendHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1000 },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => resolve(buf.includes('"ok"')));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('健康检查超时'));
    });
  });
}

async function startBackend() {
  if (backendStart) return backendStart;
  backendStart = (async () => {
    const bin = path.join(
      process.resourcesPath,
      'backend-bin',
      process.platform === 'win32' ? 'pdf-editor-backend.exe' : 'pdf-editor-backend'
    );
    let cmd, args, cwd;
    if (app.isPackaged && fs.existsSync(bin)) {
      cmd = bin;
      args = [];
      cwd = process.resourcesPath;
    } else {
      const dev = devBackendCommand();
      cmd = dev.cmd;
      args = dev.args;
      cwd = dev.cwd;
    }
    const port = await pickFreePort();
    console.log(`[backend] 启动 ${cmd} ${args.join(' ')}（PORT=${port}）`);
    const proc = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        PORT: String(port),
        // 用户字体目录与 Electron 侧一致（userData/fonts），导入/导出用同一份字体
        PDFTEXTEDITOR_USER_FONT_DIR: fontsDir(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    backendProc = proc;
    proc.on('exit', () => {
      backendProc = null;
    });
    // 若 PORT 恰好被抢占，后端会自动 +1，从 stdout 日志解析实际端口
    let portFromLog = null;
    proc.stdout.on('data', (chunk) => {
      const m = /127\.0\.0\.1:(\d+)/.exec(String(chunk));
      if (m) portFromLog = parseInt(m[1], 10);
    });
    proc.stderr.on('data', (chunk) => console.error('[backend]', String(chunk).trimEnd()));

    const deadline = Date.now() + 30000;
    let lastErr = null;
    while (Date.now() < deadline) {
      if (proc.exitCode != null) {
        throw new Error(`后端进程异常退出（exitCode=${proc.exitCode}）`);
      }
      const p = portFromLog || port;
      try {
        if (await checkBackendHealth(p)) {
          backendUrlStr = `http://127.0.0.1:${p}`;
          console.log(`[backend] 已就绪: ${backendUrlStr}`);
          return backendUrlStr;
        }
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('后端启动超时（30s）：' + (lastErr?.message || '无响应'));
  })();
  // 启动失败后允许下一次导出重试（PyInstaller 冷启动偶发超时）
  backendStart.catch(() => {
    backendStart = null;
  });
  return backendStart;
}

ipcMain.handle('get-backend-url', () => startBackend());

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'PDF 文本编辑器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  win.loadURL('app://bundle/index.html');
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    try {
      const url = new URL(request.url);
      let p = decodeURIComponent(url.pathname);
      if (p === '/' || p === '') p = '/index.html';
      const filePath = path.normalize(path.join(DIST, p));
      if (!filePath.startsWith(DIST)) {
        return new Response('forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  ipcMain.handle('save-file', async (event, { data, suggestedName }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: suggestedName,
      filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, Buffer.from(data));
    return true;
  });

  // 字体目录：userData/fonts，放入 .ttf/.otf/.woff/.woff2 文件即可扩展字体
  ipcMain.handle('list-fonts', () => {
    const dir = fontsDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(ttf|otf|woff|woff2)$/i.test(f))
      .map((f) => ({ file: f, size: fs.statSync(path.join(dir, f)).size }));
  });

  ipcMain.handle('read-font', (event, file) => {
    const dir = fontsDir();
    const p = path.join(dir, path.basename(String(file))); // 防目录穿越
    if (!fs.existsSync(p)) throw new Error('字体文件不存在');
    return fs.readFileSync(p);
  });

  ipcMain.handle('open-fonts-dir', () => {
    const dir = fontsDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  // 历史项目：按路径重新读取 PDF
  ipcMain.handle('read-pdf-file', (event, filePath) => {
    const p = String(filePath || '');
    if (!/\.pdf$/i.test(p) || !fs.existsSync(p)) throw new Error('文件不存在或不是 PDF');
    return fs.readFileSync(p);
  });

  // 导入字体：把字体文件写入用户字体目录（持久化）
  ipcMain.handle('save-font-file', (event, { file, data }) => {
    const dir = fontsDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(String(file || 'font.ttf'));
    if (!/\.(ttf|otf|woff|woff2)$/i.test(name)) throw new Error('不支持的字体格式');
    const dest = path.join(dir, name);
    fs.writeFileSync(dest, Buffer.from(data));
    return dest;
  });

  createWindow();

  // 预热后端：应用启动即拉起 Python 导出服务（冷启动约 10s，提前准备，
  // 首次导出不用等；失败不阻塞界面，导出时会自动重试）
  startBackend().catch((err) => console.error('[backend] 预启动失败：', err?.message || err));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (backendProc) {
    try {
      backendProc.kill();
    } catch {
      /* ignore */
    }
    backendProc = null;
  }
});
