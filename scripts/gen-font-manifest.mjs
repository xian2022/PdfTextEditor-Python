// 扫描 public/fonts-library 目录生成 manifest.json（网页版字体库清单）
// 构建前自动执行：手动往目录里加字体文件后，重新构建即可被识别
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts-library');

if (!existsSync(dir)) {
  console.log('[fonts] fonts-library 目录不存在，跳过清单生成');
  process.exit(0);
}
const list = readdirSync(dir)
  .filter((f) => /\.(ttf|otf|woff|woff2)$/i.test(f))
  .sort();
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(list));
console.log('[fonts] 字体库清单已更新（' + list.length + ' 个）:', list.join(', '));
