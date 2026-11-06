// 分析导出 PDF 的字形序列与嵌入字体子集结构（排查 PDFium 渲染问题）
// 用法：node scripts/inspect-glyphs.mjs <pdf路径>
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFRef, PDFName } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const file = process.argv[2] || 'glyph-test.pdf';
const doc = await PDFDocument.load(readFileSync(file));
const page = doc.getPages()[0];
const arr = page.node.Contents().asArray ? page.node.Contents().asArray() : [page.node.Contents()];
let all = '';
for (const item of arr) {
  const obj = item instanceof PDFRef ? doc.context.lookup(item) : item;
  const raw = obj && obj.getContents ? Buffer.from(obj.getContents()) : null;
  if (raw) {
    try { all += inflateSync(raw).toString('latin1'); } catch { all += raw.toString('latin1'); }
  }
}
console.log('内容流字形序列:', (all.match(/<([0-9a-fA-F]+)> Tj/g) || []).join(' '));
console.log('内容流 ToUnicode 相关片段:', (all.match(/[^\s]*ToUnicode[^\s]*/g) || []).join(' '));

// 找 CIDFontType0C 字体字典
let fontDict = null;
doc.context.enumerateIndirectObjects().forEach(([, obj]) => {
  if (fontDict) return;
  const dict = obj && typeof obj.get === 'function' ? obj : (obj && obj.dict && typeof obj.dict.get === 'function' ? obj.dict : null);
  if (!dict) return;
  try {
    const st = dict.get(PDFName.of('Subtype'));
    if (st && String(st) === '/CIDFontType0C') fontDict = dict;
  } catch { /* ignore */ }
});

if (!fontDict) {
  console.log('未找到 CIDFontType0C 字体');
  process.exit(0);
}

const deref = (v) => (v instanceof PDFRef ? doc.context.lookup(v) : v);
const descRef = fontDict.get(PDFName.of('FontDescriptor'));
const descObj = deref(descRef);
const ff3Ref = descObj.get(PDFName.of('FontFile3'));
const ff3Obj = deref(ff3Ref);
const raw = Buffer.from(ff3Obj.getContents());
let cff;
try { cff = inflateSync(raw); } catch { cff = raw; }
const font = fontkit.create(cff);
console.log('子集字体 glyph 总数:', font.numGlyphs, '| familyName:', font.familyName);

const chars = ['金', '　', '额', '测', '试', 'A', 'B', 'C', '1', '2'];
for (const ch of chars) {
  const g = font.layout(ch).glyphs[0];
  console.log(JSON.stringify({ ch, glyphId: g ? g.id : null }));
}
const first = [];
for (let i = 0; i < 10; i++) first.push(`${i}:${font.getGlyph(i)?.name ?? '?'}`);
console.log('子集前10个glyph名:', first.join(' '));
