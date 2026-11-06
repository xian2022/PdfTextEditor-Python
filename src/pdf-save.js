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
 * 从资源字典的 Font 收集字体资源名 -> 每字形字节数（Type0 复合字体为 2，其余 1）
 * 用于十六进制字符串的字形数消歧：长度能被 4 整除时既可能是 1 字节也可能是 2 字节码
 */
function collectFontWidths(pdfDoc, res) {
  const map = new Map();
  if (!res) return map;
  let fonts = res.lookup(PDFName.of('Font'));
  if (fonts instanceof PDFRef) fonts = pdfDoc.context.lookup(fonts);
  if (!fonts || typeof fonts.keys !== 'function') return map;
  for (const key of fonts.keys()) {
    const val = fonts.lookup(key);
    const obj = val instanceof PDFRef ? pdfDoc.context.lookup(val) : val;
    const dict = obj && obj.dict ? obj.dict : null;
    const subtype = dict ? String(dict.get(PDFName.of('Subtype')) || '') : '';
    const name = String(key).replace(/^\/+/, '');
    map.set(name, subtype === '/Type0' ? 2 : 1);
  }
  return map;
}

/**
 * 真正删除页面内容流中指定矩形区域内的文字绘制指令（保留背景）
 * @returns {boolean} 是否成功删除至少一条文字
 */
async function removeTextFromPage(pdfDoc, page, rect, expectGlyphs) {
  let any = false;
  const contents = page.node.Contents();
  const arr = contents && contents.asArray ? contents.asArray() : contents ? [contents] : [];
  const pageRes = page.node.Resources();
  const pageResObj = pageRes instanceof PDFRef ? pdfDoc.context.lookup(pageRes) : pageRes;
  const pageWidths = collectFontWidths(pdfDoc, pageResObj);
  const parts = [];
  for (const item of arr) {
    const obj = item instanceof PDFRef ? pdfDoc.context.lookup(item) : item;
    const raw = obj && obj.getContents ? new Uint8Array(obj.getContents()) : null;
    if (!raw) continue;
    const dec = await inflate(raw);
    const str = latin1(dec);
    const ops = tokenize(str);
    const runs = findTextRuns(ops, (name) => pageWidths.get(name) || 1);
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
    // 必须注册为间接对象：PDF 规范要求流只能是间接对象，直接内联会被
    // 写入对象流导致文件损坏（MuPDF 报 corrupt object stream）
    const streamRef = pdfDoc.context.register(pdfDoc.context.stream(encode(merged)));
    page.node.set(PDFName.of('Contents'), streamRef);
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
        // 表单自身的资源（字体按表单资源字典判定字节数）
        const fres = obj.dict && obj.dict.get ? obj.dict.get(PDFName.of('Resources')) : null;
        const fresObj = fres instanceof PDFRef ? pdfDoc.context.lookup(fres) : fres;
        const formWidths = collectFontWidths(pdfDoc, fresObj);
        const runs = findTextRuns(ops, (name) => formWidths.get(name) || pageWidths.get(name) || 1);
        const r2 = markRunsInRect(runs, rect, expectGlyphs);
        if (r2 && r2.marked.size > 0) {
          const sref = pdfDoc.context.register(
            pdfDoc.context.stream(encode(serializeOps(ops, r2.marked)))
          );
          xobj.set(key, sref);
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
