import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径，保证构建产物既能部署到 GitHub Pages，也能被 Electron file/custom 协议加载
  base: './',
  build: {
    outDir: 'dist',
  },
});
