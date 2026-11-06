// 获取用于嵌入 PDF 的内置中文字体（默认下载开源霞鹜文楷，OFL 协议可商用）
// 导出由本地 Python 后端（PyMuPDF）按所用字形子集嵌入，TTF/OTF 均可；
// 本地放置 public/fonts/builtin-font.ttf 或通过参数指定字体文件可替换内置字体
//
// 优先级：
//   1. 已存在的 public/fonts/builtin-font.ttf（本地已放置）
//   2. 命令行参数或环境变量 PDF_EDITOR_FONT 指定的本地 .ttf 文件
//   3. 从 GitHub 下载开源的霞鹜文楷（LXGW WenKai，OFL 协议可商用）
//
// 用法：
//   node scripts/fetch-font.mjs [本地字体文件路径]
import { copyFileSync, existsSync, mkdirSync, statSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK_URL = 'https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/LXGWWenKai-Regular.ttf';

const dest = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'public', 'fonts', 'builtin-font.ttf'
);

function isTtf(p) {
  return /\.ttf$/i.test(p);
}

// 1) 目标文件已就位
if (existsSync(dest) && statSync(dest).size > 1024 * 1024) {
  console.log('[font] 内置字体已存在，跳过:', dest);
  process.exit(0);
}

// 2) 命令行/环境变量指定的本地字体
const provided = process.argv[2] || process.env.PDF_EDITOR_FONT;
if (provided) {
  if (!existsSync(provided)) {
    console.error('[font] 指定的字体文件不存在:', provided);
    process.exit(1);
  }
  if (!isTtf(provided)) {
    console.error('[font] 内置字体必须是静态 .ttf（TrueType）。OTF/CFF 字体在 Chrome 中无法正常显示。');
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(provided, dest);
  console.log('[font] 已使用本地字体:', provided, '->', dest);
  process.exit(0);
}

// 3) 下载开源兜底字体（霞鹜文楷，楷体风格）
mkdirSync(dirname(dest), { recursive: true });
console.log('[font] 未提供本地字体，正在下载开源兜底字体（霞鹜文楷，约 19MB）…');
const res = await fetch(FALLBACK_URL, { redirect: 'follow' });
if (!res.ok || !res.body) {
  console.error('[font] 下载失败: HTTP', res.status);
  console.error('[font] 请手动下载一个静态 .ttf 中文字体放到 public/fonts/builtin-font.ttf，');
  console.error('[font] 或执行: node scripts/fetch-font.mjs /路径/到/你的字体.ttf');
  process.exit(1);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
console.log('[font] 兜底字体已保存:', dest);
