import { PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { tokenize, findTextRuns, markRunsInRect, serializeOps } from './text-removal.js';

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};
const encode = (str) => {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff;
  return arr;
};
async function inflate(bytes) {
  try {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return bytes;
  }
}

/**
 * 真正删除页面内容流中指定矩形区域内的文字绘制指令（保留背景）
 * @returns {boolean} 是否成功删除至少一条文字
 */
async function removeTextFromPage(pdfDoc, page, rect, expectGlyphs) {
  let any = false;
  const contents = page.node.Contents();
  const arr = contents && contents.asArray ? contents.asArray() : contents ? [contents] : [];
  const parts = [];
  for (const item of arr) {
    const obj = item instanceof PDFRef ? pdfDoc.context.lookup(item) : item;
    const raw = obj && obj.getContents ? new Uint8Array(obj.getContents()) : null;
    if (!raw) continue;
    const dec = await inflate(raw);
    const str = latin1(dec);
    const ops = tokenize(str);
    const runs = findTextRuns(ops);
    const res = markRunsInRect(runs, rect, expectGlyphs);
    if (res && res.marked.size > 0) {
      parts.push(serializeOps(ops, res.marked));
      any = true;
    } else {
      parts.push(str);
    }
  }
  if (any && parts.length) {
    const merged = parts.join('\n');
    page.node.set(PDFName.of('Contents'), pdfDoc.context.stream(encode(merged)));
  }
  // 表单 XObject（页面资源里嵌套的内容流）
  try {
    const res = page.node.Resources();
    let xobj = res && res.lookup(PDFName.of('XObject'));
    if (xobj instanceof PDFRef) xobj = pdfDoc.context.lookup(xobj);
    if (xobj && typeof xobj.keys === 'function') {
      for (const key of xobj.keys()) {
        const val = xobj.lookup(key);
        const obj = val instanceof PDFRef ? pdfDoc.context.lookup(val) : val;
        const subtype = obj && obj.dict && obj.dict.get ? String(obj.dict.get(PDFName.of('Subtype'))) : '';
        if (subtype !== '/Form') continue;
        const raw = obj.getContents ? new Uint8Array(obj.getContents()) : null;
        if (!raw) continue;
        const dec = await inflate(raw);
        const ops = tokenize(latin1(dec));
        const runs = findTextRuns(ops);
        const r2 = markRunsInRect(runs, rect, expectGlyphs);
        if (r2 && r2.marked.size > 0) {
          xobj.set(key, pdfDoc.context.stream(encode(serializeOps(ops, r2.marked))));
          any = true;
        }
      }
    }
  } catch (err) {
    console.warn('XObject 文字删除处理失败', err);
  }
  return any;
}

/**
 * 仅删除指定页面的原文文字（不绘制任何标注），返回新 PDF 字节
 * 供编辑器界面实时重绘页面使用（所见即所得：原文创建文本框后立即从画面消失）
 */
export async function deleteTextOnly(sourceBytes, pageIndex, deletions) {
  const pdfDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const page = pages[pageIndex];
  if (!page) return null;
  for (const ann of deletions) {
    const { height } = page.getSize();
    const rect = {
      x0: ann.x - 2,
      x1: ann.x + ann.w + 2,
      y0: height - ann.y - ann.h - 2,
      y1: height - ann.y + 2,
    };
    const expect = String(ann.origText || '').length || -1;
    try {
      await removeTextFromPage(pdfDoc, page, rect, expect);
    } catch (err) {
      console.warn('界面重绘删除失败', err);
    }
  }
  return pdfDoc.save();
}

let fontBytesPromise = null;

/** 获取内置字体字节（网页与 Electron 都通过 fetch 相对路径获取） */
export function loadFontBytes() {
  if (!fontBytesPromise) {
    fontBytesPromise = fetch(`${import.meta.env.BASE_URL}fonts/builtin-font.ttf`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(
            `字体资源加载失败（HTTP ${res.status}）。请先执行 npm run fetch:font 再重新构建。`
          );
        }
        return res.arrayBuffer();
      })
      .then((buf) => new Uint8Array(buf));
  }
  return fontBytesPromise;
}

/** 提前后台预载字体，避免首次导出时等待下载 */
export function preloadFont() {
  loadFontBytes().catch(() => {});
}
