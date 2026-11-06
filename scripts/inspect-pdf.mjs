// 诊断 PDF 文本层：页数、文字提取结果、字体 ToUnicode 映射情况
// 用法：node scripts/inspect-pdf.mjs <pdf路径> [页码]
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName, PDFFont, PDFDict } from 'pdf-lib';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/inspect-pdf.mjs <pdf路径> [页码]');
  process.exit(1);
}
const data = new Uint8Array(readFileSync(file));

// ---- pdf.js 文字提取 ----
console.log('文件大小:', data.length, 'bytes');
// 注意：传拷贝，pdf.js 会把 buffer 转移给 worker 导致原数据被清空
const doc = await getDocument({ data: data.slice(), disableFontFace: true }).promise;
const pageNum = Math.min(Number(process.argv[3] || 1), doc.numPages);
const page = await doc.getPage(pageNum);
console.log('页数:', doc.numPages);
const tc = await page.getTextContent();
const items = tc.items;
const nonEmpty = items.filter((i) => (i.str || '').trim());
console.log(`第 ${pageNum} 页文字项总数: ${items.length}，其中非空: ${nonEmpty.length}`);
console.log('--- 前 15 项 ---');
for (const it of items.slice(0, 15)) {
  console.log(JSON.stringify({
    str: it.str,
    t: it.transform?.map((n) => +n.toFixed(1)),
    w: it.width == null ? null : +it.width.toFixed(1),
    fn: it.fontName,
    eol: !!it.hasEOL,
  }));
}

// ---- pdf-lib 字体与 ToUnicode 检查 ----
try {
  const pdoc = await PDFDocument.load(data, { ignoreEncryption: true });
  console.log('--- 字体资源（前 3 页）---');
  for (let i = 0; i < Math.min(pdoc.getPages().length, 3); i++) {
    const res = pdoc.getPages()[i].node.Resources();
    let fontDict = null;
    try {
      fontDict = res?.lookup(PDFName.of('Font'), PDFDict) ?? null;
    } catch {
      fontDict = null;
    }
    if (!fontDict || typeof fontDict.forEach !== 'function') {
      console.log(`第 ${i + 1} 页: 字体资源无法解析`);
      continue;
    }
    const entries = [];
    try {
      fontDict.forEach((ref, key) => {
      let info = { key: key.toString(), base: '?', subtype: '?', toUnicode: false, embedded: '?' };
      try {
        const f = fontDict.lookup(key, PDFFont);
        info.base = String(f.get(PDFName.of('BaseFont')) ?? '?');
        info.subtype = String(f.get(PDFName.of('Subtype')) ?? '?');
        info.toUnicode = !!f.get(PDFName.of('ToUnicode'));
        const desc = f.get(PDFName.of('FontDescriptor'));
        if (desc) {
          const descObj = fontDict.context.lookup(desc);
          info.embedded = !!descObj?.get(PDFName.of('FontFile')) || !!descObj?.get(PDFName.of('FontFile2')) || !!descObj?.get(PDFName.of('FontFile3'));
        }
      } catch (e) {
        info.base = '解析失败: ' + e.message;
      }
      entries.push(info);
      });
    } catch (e) {
      console.log(`第 ${i + 1} 页: 字体资源解析失败:`, e.message);
      continue;
    }
    console.log(`第 ${i + 1} 页:`, JSON.stringify(entries, null, 1));
  }
} catch (err) {
  console.error('pdf-lib 分析失败:', err.message);
}
