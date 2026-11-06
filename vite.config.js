import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径，保证构建产物既能部署到 GitHub Pages，也能被 Electron file/custom 协议加载
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    // 开发模式：字体库与导出接口转发给本地 Python 后端（默认 8765，被占用时后端会自动换端口）
    proxy: {
      '/api': 'http://127.0.0.1:8765',
      '/fonts-library': 'http://127.0.0.1:8765',
    },
  },
});
