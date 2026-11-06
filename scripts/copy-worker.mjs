// 把 pdf.js 的 worker 复制为固定文件名（public/ 目录不参与哈希），
// 避免构建后旧页面对旧哈希 worker 文件的引用失效导致"Failed to fetch dynamically imported module"
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
const destDir = join(root, 'public');
const dest = join(destDir, 'pdf.worker.min.mjs');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log('[worker] 已复制:', dest);
