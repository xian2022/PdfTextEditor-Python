const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveFile: (payload) => ipcRenderer.invoke('save-file', payload),
  listFonts: () => ipcRenderer.invoke('list-fonts'),
  readFont: (file) => ipcRenderer.invoke('read-font', file),
  openFontsDir: () => ipcRenderer.invoke('open-fonts-dir'),
  readPdfFile: (filePath) => ipcRenderer.invoke('read-pdf-file', filePath),
  saveFontFile: (payload) => ipcRenderer.invoke('save-font-file', payload),
  // 导出后端地址：首次调用时由主进程自动拉起 Python 后端并返回实际端口
  backendUrl: () => ipcRenderer.invoke('get-backend-url'),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
});
