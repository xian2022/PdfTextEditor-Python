const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveFile: (payload) => ipcRenderer.invoke('save-file', payload),
  listFonts: () => ipcRenderer.invoke('list-fonts'),
  readFont: (file) => ipcRenderer.invoke('read-font', file),
  openFontsDir: () => ipcRenderer.invoke('open-fonts-dir'),
  readPdfFile: (filePath) => ipcRenderer.invoke('read-pdf-file', filePath),
  saveFontFile: (payload) => ipcRenderer.invoke('save-font-file', payload),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
});
