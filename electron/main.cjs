const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const DIST = path.join(__dirname, '..', 'dist');

// 自定义 app:// 协议承载构建产物：
// 保证 Worker（pdf.js）与 fetch（字体）在打包后都能正常同源加载
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function fontsDir() {
  return path.join(app.getPath('userData'), 'fonts');
}

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
