import { PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { tokenize, findTextRuns, collectRunsInRect, serializeOps } from './text-removal.js';

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
 * 支持文字画在 Form XObject 里的情况：按 Do 放置矩阵把页面矩形反变换到
 * 表单局部坐标系再匹配，页面流与所有表单的命中字形数汇总校验。
 * @returns {boolean} 是否成功删除至少一条文字
 */
async function removeTextFromPage(pdfDoc, page, rect, expectGlyphs) {
  const parseNum = (tok) => {
    const v = parseFloat(tok && tok.raw);
    return Number.isFinite(v) ? v : 0;
  };
  const parseName = (tok) => {
    const r = tok && tok.raw ? tok.raw : '';
    return r.startsWith('/') ? r.slice(1) : r;
  };
  const mulM = (m1, m2) => [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
  const invertMatrix = (m) => {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) return null;
    return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  };
  /** 页面空间矩形 → 局部空间矩形（四角仿射变换后取包围盒） */
  const rectToLocal = (r, inv) => {
    const pts = [
      [r.x0, r.y0], [r.x0, r.y1], [r.x1, r.y0], [r.x1, r.y1],
    ].map(([x, y]) => [inv[0] * x + inv[2] * y + inv[4], inv[1] * x + inv[3] * y + inv[5]]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  const resolveDict = (val) => (val instanceof PDFRef ? pdfDoc.context.lookup(val) : val);
  const formMatrix = (dict) => {
    try {
      const m = dict && dict.get ? dict.get(PDFName.of('Matrix')) : null;
      if (!m || !m.asArray) return [1, 0, 0, 1, 0, 0];
      const arr = m.asArray();
      if (arr.length < 6) return [1, 0, 0, 1, 0, 0];
      return arr.slice(0, 6).map((v) => {
        const n = v && typeof v.numberValue === 'function' ? v.numberValue() : parseFloat(String(v));
        return Number.isFinite(n) ? n : 0;
      });
    } catch {
      return [1, 0, 0, 1, 0, 0];
    }
  };

  const contents = page.node.Contents();
  const arr = contents && contents.asArray ? contents.asArray() : contents ? [contents] : [];
  const pageResObj = resolveDict(page.node.Resources());
  const pageWidths = collectFontWidths(pdfDoc, pageResObj);
  const pageWidthOf = (name) => pageWidths.get(name) || 1;

  // 页面流自身文字：逐条收集（序列化推迟到字形数汇总校验之后）
  const pageItems = [];
  let matchedTotal = 0;
  for (const item of arr) {
    const obj = resolveDict(item);
    const raw = obj && obj.getContents ? new Uint8Array(obj.getContents()) : null;
    if (!raw) {
      pageItems.push({ str: '' });
      continue;
    }
    const dec = await inflate(raw);
    const str = latin1(dec);
    const ops = tokenize(str);
    const runs = findTextRuns(ops, pageWidthOf);
    const r = collectRunsInRect(runs, rect);
    pageItems.push({ str, ops, marked: r.marked });
    matchedTotal += r.matched;
  }

  // 表单 XObject：递归收集 Do 引用的表单文字（每个放置矩阵单独反变换矩形）
  const doneForms = new Map();
  const walkForms = async (ops, ctm, resObj, fallbackWidthOf) => {
    let xobj = resObj ? resObj.lookup(PDFName.of('XObject')) : null;
    xobj = resolveDict(xobj);
    if (!xobj || typeof xobj.keys !== 'function') return;
    let cur = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (const o of ops) {
      if (!o.op) continue;
      if (o.op === 'q') stack.push(cur.slice());
      else if (o.op === 'Q') { if (stack.length) cur = stack.pop(); }
      else if (o.op === 'cm' && o.operands.length >= 6) cur = mulM(cur, o.operands.slice(0, 6).map(parseNum));
      else if (o.op === 'Do' && o.operands.length >= 1) {
        const name = parseName(o.operands[0]);
        if (!name) continue;
        const fobj = resolveDict(xobj.lookup(PDFName.of(name)));
        const subtype = fobj && fobj.dict && fobj.dict.get ? String(fobj.dict.get(PDFName.of('Subtype')) || '') : '';
        if (subtype !== '/Form') continue;
        const ctm2 = mulM(ctm, mulM(cur, formMatrix(fobj.dict)));
        let st = doneForms.get(fobj);
        if (!st) {
          const raw = fobj.getContents ? new Uint8Array(fobj.getContents()) : null;
          if (!raw) continue;
          const dec = await inflate(raw);
          const fops = tokenize(latin1(dec));
          const fresObj = resolveDict(fobj.dict && fobj.dict.get ? fobj.dict.get(PDFName.of('Resources')) : null) || resObj;
          const fwidths = collectFontWidths(pdfDoc, fresObj);
          st = {
            fobj,
            ops: fops,
            widthOf: (n) => fwidths.get(n) || (fallbackWidthOf ? fallbackWidthOf(n) : 1),
            marked: new Set(),
            xobj,
            name,
            resObj: fresObj,
            walked: false,
          };
          doneForms.set(fobj, st);
        }
        const inv = invertMatrix(ctm2);
        if (inv) {
          const fruns = findTextRuns(st.ops, st.widthOf);
          const fr = collectRunsInRect(fruns, rectToLocal(rect, inv));
          for (const m of fr.marked) st.marked.add(m);
          matchedTotal += fr.matched;
        }
        if (!st.walked) {
          st.walked = true;
          await walkForms(st.ops, ctm2, st.resObj, st.widthOf);
        }
      }
    }
  };
  for (const item of pageItems) {
    if (!item.ops) continue;
    await walkForms(item.ops, [1, 0, 0, 1, 0, 0], pageResObj, pageWidthOf);
  }

  // 字形数汇总校验：期望值给出时，页面流 + 表单命中总和必须吻合（容差 3）
  if (expectGlyphs >= 0 && Math.abs(matchedTotal - expectGlyphs) > 3) return false;

  let any = false;
  // 页面流重写
  const pageMarked = pageItems.some((it) => it.marked && it.marked.size > 0);
  if (pageMarked) {
    const merged = pageItems
      .map((it) => (it.marked && it.marked.size > 0 ? serializeOps(it.ops, it.marked) : it.str))
      .join('\n');
    // 必须注册为间接对象：PDF 规范要求流只能是间接对象，直接内联会被
    // 写入对象流导致文件损坏（MuPDF 报 corrupt object stream）
    const streamRef = pdfDoc.context.register(pdfDoc.context.stream(encode(merged)));
    page.node.set(PDFName.of('Contents'), streamRef);
    any = true;
  }
  // 表单流重写（同一表单多次放置时汇总标记后统一序列化）
  for (const st of doneForms.values()) {
    if (st.marked.size === 0) continue;
    // 保留原表单字典（Subtype/BBox/Matrix/Resources 等），仅重建内容流：
    // 去掉压缩相关条目，写入未压缩字节，避免裸流丢失 /Subtype 导致文件损坏
    const newDict = pdfDoc.context.obj({});
    try {
      if (st.fobj && st.fobj.dict && st.fobj.dict.entries) {
        for (const [k, v] of st.fobj.dict.entries()) {
          const ks = String(k);
          if (ks === '/Length' || ks === '/Filter' || ks === '/DecodeParms' || ks === '/DL') continue;
          newDict.set(k, v);
        }
      }
    } catch (err) {
      console.warn('表单字典复制失败', err);
    }
    const sref = pdfDoc.context.register(
      pdfDoc.context.stream(encode(serializeOps(st.ops, st.marked)), newDict)
    );
    st.xobj.set(PDFName.of(st.name), sref);
    any = true;
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
