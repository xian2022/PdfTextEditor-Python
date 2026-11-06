import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { preloadFont, loadFontBytes, deleteTextOnly } from './pdf-save.js';
import { exportPdfBackend } from './backend-export.js';
import { fonts, DEFAULT_FONT_ID, addFontFromBytes, initDefaultFont, familyFor, fontDisplayName, defaultFontName } from './fonts.js';
import './style.css';

// worker 使用固定文件名（public/pdf.worker.min.mjs，由 scripts/copy-worker.mjs 生成），
// 避免构建哈希变化导致旧页面引用失效
pdfjsLib.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;
preloadFont();
loadFontBytes()
  .then(initDefaultFont)
  .then(refreshFontSelect) // 内置字体名解析完成后刷新下拉框显示
  .catch(() => {});

// 渲染倍率：PDF point -> 屏幕像素的换算系数（1pt = RENDER_SCALE px）
const RENDER_SCALE = 1.5;

const $ = (id) => document.getElementById(id);
const el = {
  btnOpen: $('btnOpen'), fileInput: $('fileInput'),
  btnRecent: $('btnRecent'), recentList: $('recentList'), btnClose: $('btnClose'),
  panelProject: $('panel-project'), panelEdit: $('panel-edit'),
  btnEdit: $('btnEdit'),
  btnUndo: $('btnUndo'), btnRedo: $('btnRedo'),
  btnBold: $('btnBold'), btnItalic: $('btnItalic'), btnUnderline: $('btnUnderline'),
  fontSize: $('fontSize'),
  color: $('color'), fontSelect: $('fontSelect'), fontSearch: $('fontSearch'), fontList: $('fontList'),
  bgColor: $('bgColor'), bgNone: $('bgNone'),
  btnLoadFont: $('btnLoadFont'), fontInput: $('fontInput'),
  btnReloadFonts: $('btnReloadFonts'),
  btnFontDir: $('btnFontDir'),
  btnSave: $('btnSave'), btnDiscard: $('btnDiscard'),
  pages: $('pages'), hint: $('hint'), status: $('status'), pageBadge: $('pageBadge'),
  zoomBar: $('zoomBar'), btnZoomOut: $('btnZoomOut'), btnZoomIn: $('btnZoomIn'), zoomPct: $('zoomPct'),
};
el.fontSelect.value = DEFAULT_FONT_ID; // 字体选择器初始为内置字体

let pdfBytes = null;
let currentPdfDoc = null; // 当前 pdf.js 文档句柄，切换项目时销毁避免 worker 累积
let pages = []; // { num, overlay, canvas, pdfPage, boxes, textLines, textLineEls, textReady, widthPt, heightPt, rotation }
let editMode = false;
let selectedBox = null;
let selectedBoxEl = null;
let boxSeq = 1;
let drag = null;
let resize = null;
let currentFileName = 'document';
let undoStack = [];
let redoStack = [];

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function setStatus(msg, isError = false) {
  el.status.textContent = msg;
  el.status.classList.toggle('ok', !isError);
  el.status.classList.add('show');
  clearTimeout(setStatus.timer);
  setStatus.timer = setTimeout(() => el.status.classList.remove('show'), 8000);
}

// ---------------- 撤销 / 重做 ----------------
function snapshot() {
  return pages.map((p) => p.boxes.map((b) => ({ ...b })));
}

function pushUndo(snap) {
  undoStack.push(snap || snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  refreshUndoButtons();
  schedulePersist();
}

function restore(snap) {
  pages.forEach((p, i) => {
    p.boxes = (snap[i] || []).map((b) => ({ ...b }));
  });
  drag = null;
  resize = null;
  rerenderBoxes();
  selectBox(null, null);
  refreshUndoButtons();
  for (const p of pages) schedulePageRefresh(p); // 撤销/重做后同步重绘页面
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  schedulePersist();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  schedulePersist();
}

function rerenderBoxes() {
  for (const p of pages) {
    for (const node of [...p.overlay.querySelectorAll('.box')]) node.remove();
    for (const b of p.boxes) p.overlay.appendChild(createBoxElement(b, p));
  }
}

function refreshUndoButtons() {
  el.btnUndo.disabled = undoStack.length === 0;
  el.btnRedo.disabled = redoStack.length === 0;
}

// ---------------- 打开与渲染 ----------------
async function openPdf(file, password) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  currentFileName = file.name || 'document';
  // 销毁上一个 pdf.js 文档，释放 worker（反复切换项目不会累积资源）
  if (currentPdfDoc) {
    try {
      await currentPdfDoc.destroy();
    } catch { /* ignore */ }
    currentPdfDoc = null;
  }
  let doc;
  try {
    // 注意：pdf.js 会把 data 的 ArrayBuffer 转移给 Worker（原 buffer 被置空），
    // 所以这里传一份拷贝，保留 bytes 供后续导出使用
    doc = await pdfjsLib.getDocument({ data: bytes.slice(), password }).promise;
  } catch (err) {
    console.error(err);
    if (err?.name === 'PasswordException') {
      const pwd = prompt('该 PDF 受密码保护，请输入密码后重试：');
      if (pwd) return openPdf(file, pwd);
      setStatus('已取消打开：需要密码。', true);
      return;
    }
    const msg = String(err?.message || err);
    // 旧页面缓存的 worker 路径失效（构建哈希变化）：自动强制刷新加载新代码
    if (/fake worker|Failed to fetch dynamically imported module/i.test(msg)) {
      try {
        if (!sessionStorage.getItem('pdf-editor-auto-reloaded')) {
          sessionStorage.setItem('pdf-editor-auto-reloaded', '1');
          setStatus('检测到旧版本缓存，正在自动刷新…', false);
          setTimeout(() => location.reload(), 300);
          return;
        }
      } catch { /* ignore */ }
    }
    setStatus('无法打开该 PDF：' + msg, true);
    return;
  }
  pdfBytes = bytes; // 解析成功后才覆盖，避免失败时污染会话/导出数据
  currentPdfDoc = doc;
  el.pages.innerHTML = '';
  pages = [];
  undoStack = [];
  redoStack = [];
  refreshUndoButtons();
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      pages.push(await renderPage(doc, i));
    }
  } catch (err) {
    console.error(err);
    setStatus('渲染失败：' + (err?.message || err), true);
    return;
  }
  el.btnSave.disabled = false;
  el.btnEdit.disabled = false;
  el.hint.style.display = 'none';
  setStatus(`已打开：${currentFileName}（${doc.numPages} 页）`, false);
  recordRecent(file, pdfBytes); // 记入历史项目
  switchTab('edit'); // 打开后自动切到编辑标签
  resetZoom(); // 显示缩放复位 100%，显示左下角缩放条
  updatePageBadge(true); // 显示一次页标
  if (editMode) {
    for (const p of pages) ensureTextLayer(p);
  }
}

async function renderPage(doc, num) {
  const page = await doc.getPage(num);
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  const wrap = document.createElement('div');
  wrap.className = 'page';

  const label = document.createElement('div');
  label.className = 'page-label';
  label.textContent = `第 ${num} 页`;
  wrap.appendChild(label);

  const body = document.createElement('div');
  body.className = 'page-body';

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  body.appendChild(canvas);

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.style.width = viewport.width + 'px';
  overlay.style.height = viewport.height + 'px';
  overlay.addEventListener('mousedown', onOverlayMouseDown);
  overlay.addEventListener('dblclick', onOverlayDblClick);
  body.appendChild(overlay);

  wrap.appendChild(body);
  el.pages.appendChild(wrap);

  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

  return {
    num,
    overlay,
    canvas,
    pdfPage: page,
    boxes: [],
    textLines: [],
    textLineEls: [],
    textReady: false,
    widthPt: viewport.width / RENDER_SCALE,
    heightPt: viewport.height / RENDER_SCALE,
    rotation: page.rotate || 0,
  };
}

// ---------------- 原文文字层 ----------------
function cleanFamily(name) {
  // 去子集前缀（允许前导斜杠），如 "/SWAJAT+楷体" -> "楷体"、"ABCDEF+SimSun" -> "SimSun"
  const m = /^\/?[A-Z]{6}\+(.+)$/.exec(name || '');
  return (m ? m[1] : String(name || '').replace(/^\//, ''));
}

/** 解码 PDF BaseFont 十六进制名，如 "/SWAJAT+#E6#A5#B7#E4#BD#93" -> "楷体" */
function decodePdfName(s) {
  const m = /^\/?(?:[A-Z]{6}\+)?(.*)$/.exec(s || '');
  const body = m ? m[1] : s || '';
  if (!body.includes('#')) return body;
  const bytes = [];
  const rest = body.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => {
    bytes.push(parseInt(h, 16));
    return '';
  });
  for (const ch of rest) bytes.push(ch.charCodeAt(0) & 0xff);
  try {
    return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
  } catch {
    return body;
  }
}

/** 从 PDF 字体资源提取真实字体名（如"楷体/宋体"），供文字层自动匹配字体库 */
async function buildFontNameMap(p) {
  try {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const page = doc.getPages()[p.num - 1];
    const res = page.node.Resources();
    let fontDict = res?.lookup(PDFName.of('Font'));
    if (fontDict instanceof PDFRef) fontDict = doc.context.lookup(fontDict);
    p.fontEntries = [];
    p.fontNameMap = {};
    if (!fontDict || typeof fontDict.keys !== 'function') return;
    for (const key of fontDict.keys()) {
      try {
        const f = fontDict.lookup(key); // 直接取字体字典（不带类型参数）
        const base = f && f.get ? f.get(PDFName.of('BaseFont')) : null;
        if (!base) continue;
        const k = String(key).replace(/^\//, '');
        const fam = cleanFamily(decodePdfName(String(base)));
        p.fontEntries.push({ key: k, family: fam });
        p.fontNameMap[k] = fam;
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('字体名提取失败', err);
  }
}

/** 字体别名：PDF 里的字体名（中/英）映射到字体库文件名，双向互认 */
const FONT_ALIASES = {
  simsun: '宋体', nsimsun: '宋体', songti: '宋体', 'noto serif cjk sc': '宋体', '宋体': 'simsun',
  simhei: '黑体', heiti: '黑体', '黑体': 'simhei',
  kaiti: '楷体', kai: '楷体', '楷体': 'kaiti',
  fangsong: '仿宋', 'fang song': '仿宋', '仿宋': 'fangsong',
  'microsoft yahei': '微软雅黑', msyh: '微软雅黑', yahei: '微软雅黑', '微软雅黑': 'msyh',
  dengxian: '微软雅黑',
  arial: 'arial', 'times new roman': 'times new roman', couriernew: 'courier new', courier: 'courier new',
  calibri: 'calibri', cambria: 'cambria',
};

/** 若用户已加载与原文同名的字体（按内部字体名、文件名或别名），自动匹配 */
function matchFont(origFamily) {
  const fam = cleanFamily(origFamily).toLowerCase().trim();
  if (!fam) return null;
  const targets = new Set([fam]);
  if (FONT_ALIASES[fam]) targets.add(FONT_ALIASES[fam]);
  // 去掉空格比较一次（如 "CourierNew" -> "couriernew"）
  targets.add(fam.replace(/\s+/g, ''));
  for (const f of fonts.values()) {
    const n = (f.name || '').toLowerCase();
    const base = ((f.file || '').replace(/\.[^.]+$/, '')).toLowerCase();
    if (n && (fam.includes(n) || n.includes(fam))) return f.id;
    for (const t of targets) {
      if (t && (base === t || base === t.replace(/\s+/g, '') || base.includes(t))) return f.id;
    }
  }
  return null;
}

/**
 * 从渲染画布采样，返回 { color, bg }：
 * - color：背景之外「最暗且像素数达标的颜色」（真实墨色，而非抗锯齿灰）
 * - bg：区域最常见颜色（原文背景色，遮盖块用它；近白色归一为纯白避免灰块）
 */
function detectLineColors(ctx, p, line) {
  const canvas = ctx.canvas;
  const x = clamp(Math.floor(line.x0 * RENDER_SCALE), 0, canvas.width - 2);
  const y = clamp(Math.floor((p.heightPt - line.y1) * RENDER_SCALE), 0, canvas.height - 2);
  const w = Math.max(2, Math.min(Math.ceil((line.x1 - line.x0) * RENDER_SCALE), canvas.width - x));
  const h = Math.max(2, Math.min(Math.ceil((line.y1 - line.y0) * RENDER_SCALE), canvas.height - y));
  const data = ctx.getImageData(x, y, w, h).data;
  const counts = new Map();
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    total++;
    const key = (data[i] >> 4 << 8) | (data[i + 1] >> 4 << 4) | (data[i + 2] >> 4);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (total === 0) return { color: '#000000', bg: '#ffffff' };
  const toHex = (key) => {
    const r = key >> 8, g = (key >> 4) & 15, b = key & 15;
    return '#' + [r, g, b].map((v) => Math.min(255, (v << 4) + 7).toString(16).padStart(2, '0')).join('');
  };
  const lum = (key) => (key >> 8) * 0.299 + ((key >> 4) & 15) * 0.587 + (key & 15) * 0.114;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const bgKey = sorted[0][0];
  const threshold = Math.max(8, Math.floor(total * 0.01));
  let best = null;
  for (const [key, n] of sorted) {
    if (key === bgKey) continue;
    if (n < threshold) continue;
    if (best == null || lum(key) < lum(best)) best = key;
  }
  const textKey = best == null ? 0 : best;
  const textR = (textKey >> 8) << 4, textG = ((textKey >> 4) & 15) << 4, textB = (textKey & 15) << 4;
  // 背景色 = 排除文字像素后的平均色（纯色/渐变/图片背景都取局部近似）
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const dr = data[i] - textR, dg = data[i + 1] - textG, db = data[i + 2] - textB;
    if (dr * dr + dg * dg + db * db < 3600) continue; // 距文字色太近的像素跳过
    sr += data[i];
    sg += data[i + 1];
    sb += data[i + 2];
    cnt++;
  }
  let bg = '#ffffff';
  if (cnt > 0) {
    const ar = Math.round(sr / cnt), ag = Math.round(sg / cnt), ab = Math.round(sb / cnt);
    // 近白背景归一为纯白，避免在视觉白色区域出现灰块
    const avgLum = 0.299 * ar + 0.587 * ag + 0.114 * ab;
    if (avgLum <= 250) {
      bg = '#' + [ar, ag, ab].map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('');
    }
  }
  return { color: best == null ? '#000000' : toHex(best), bg };
}

async function ensureTextLayer(p) {
  if (p.textReady || p.textPending) return;
  p.textPending = true;
  try {
    if (!p.fontEntries) await buildFontNameMap(p);
    const content = await p.pdfPage.getTextContent();
    const styles = content.styles || {};
    const lines = [];
    let cur = null;
    for (const it of content.items) {
      const str = it.str || '';
      if (!str.trim()) {
        // 有些 PDF（如发票）的换行标志在空字符串项上：此时要把已积累的行收尾，不能丢弃
        if (it.hasEOL) {
          if (cur) lines.push(cur);
          cur = null;
        }
        continue;
      }
      const t = it.transform || [1, 0, 0, 1, 0, 0];
      if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) {
        if (it.hasEOL) {
          if (cur) lines.push(cur);
          cur = null;
        }
        continue;
      }
      const size = Math.hypot(t[2], t[3]) || Math.abs(t[0]) || 12;
      const x0 = t[4];
      const yBase = t[5];
      const top = yBase + size * 1.05;
      const bottom = yBase - size * 0.3;
      const x1 = x0 + (it.width || size * 0.55 * str.length);
      if (!cur) {
        cur = { text: '', x0, y0: bottom, x1, y1: top, sizes: [], size0: size, family: '', yBase, fontNameRaw: it.fontName || '' };
      } else if (
        // 基线明显不同（不同行）→ 新段；水平跳变（正负都算）或字号差异过大 → 新段
        Math.abs(yBase - cur.yBase) > cur.size0 * 0.5 ||
        Math.abs(x0 - cur.x1) > cur.size0 * 1.2 ||
        Math.abs(size - cur.size0) / Math.max(cur.size0, 1) > 0.35
      ) {
        lines.push(cur);
        cur = { text: '', x0, y0: bottom, x1, y1: top, sizes: [], size0: size, family: '', yBase, fontNameRaw: it.fontName || '' };
      }
      // 合并条目时按水平空隙补空格，保持原排版间距（如"单　位"、"数　量"）
      {
        const gap = x0 - cur.x1;
        if (cur.text && gap > cur.size0 * 0.6) cur.text += '\u3000';
        else if (cur.text && gap > cur.size0 * 0.2) cur.text += ' ';
      }
      cur.text += str;
      cur.x0 = Math.min(cur.x0, x0);
      cur.y0 = Math.min(cur.y0, bottom);
      cur.x1 = Math.max(cur.x1, x1);
      cur.y1 = Math.max(cur.y1, top);
      cur.sizes.push(size);
      if (!cur.family) {
        // 优先用 PDF 字体资源里的真实字体名（如"楷体"）；pdf.js 内部编号 g_dN_fM 按字体字典顺序映射
        let mapped = p.fontNameMap && p.fontNameMap[it.fontName];
        if (!mapped) {
          const m = /^g_d\d+_f(\d+)$/.exec(String(it.fontName || ''));
          if (m && p.fontEntries) {
            const entry = p.fontEntries[parseInt(m[1], 10) - 1];
            mapped = entry ? entry.family : null;
          }
        }
        const st = styles[it.fontName];
        cur.family = String(mapped || (st && st.fontFamily) || '');
      }
      if (it.hasEOL) {
        lines.push(cur);
        cur = null;
      }
    }
    if (cur) lines.push(cur);

    // 竖向连续文字（如竖排的"销售方信息"）合并为一个多行竖排框
    const merged = [];
    for (const line of lines) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        Math.abs(line.x0 - prev.x0) < prev.size0 * 0.3 &&
        // 纵向间距必须非常小（竖向字符紧邻；发票号码/日期这类隔行字段不合并）
        Math.abs(prev.y0 - line.y1) < prev.size0 * 0.35 &&
        Math.abs(line.size0 - prev.size0) / Math.max(prev.size0, 1) < 0.3
      ) {
        prev.text += '\n' + line.text;
        prev.y0 = Math.min(prev.y0, line.y0);
        prev.y1 = Math.max(prev.y1, line.y1);
        prev.x1 = Math.max(prev.x1, line.x1);
        prev.sizes.push(...line.sizes);
        prev.vertical = true;
        continue;
      }
      merged.push(line);
    }

    p.textLines = merged.filter(
      (l) => l.text.trim().length > 0 && l.x1 - l.x0 > 2 && l.y1 - l.y0 > 2
    );
    // 逐行采样检测原文颜色与背景色
    try {
      const ctx = p.canvas.getContext('2d', { willReadFrequently: true });
      for (const line of p.textLines) {
        const det = detectLineColors(ctx, p, line);
        line.color = det.color;
        line.bg = det.bg;
      }
    } catch (err) {
      console.warn('颜色检测失败', err);
    }
    renderTextLayer(p);
    if (p.textLines.length === 0) {
      setStatus(`第 ${p.num} 页没有检测到可编辑的文字层（可能是扫描件/图片型 PDF）。`, true);
    }
  } catch (err) {
    console.warn('文字层构建失败', err);
  }
  p.textReady = true;
}

function renderTextLayer(p) {
  for (const line of p.textLines) {
    const d = document.createElement('div');
    d.className = 'text-line';
    d.style.left = line.x0 * RENDER_SCALE + 'px';
    d.style.top = (p.heightPt - line.y1) * RENDER_SCALE + 'px';
    d.style.width = Math.max((line.x1 - line.x0) * RENDER_SCALE, 8) + 'px';
    d.style.height = Math.max((line.y1 - line.y0) * RENDER_SCALE, 8) + 'px';
    d.title = '单击选中，双击直接编辑';
    d.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      editTextLine(p, line, false);
    });
    d.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      editTextLine(p, line, true);
    });
    p.overlay.appendChild(d);
    p.textLineEls.push(d);
  }
}

/** 单击/双击原文：创建编辑框并选中；andEdit=true 时直接进入编辑 */
function editTextLine(p, line, andEdit) {
  const avgSize = line.sizes.reduce((a, b) => a + b, 0) / line.sizes.length;
  const origFamily = cleanFamily(line.family);
  const box = {
    id: boxSeq++,
    x: line.x0 * RENDER_SCALE,
    y: (p.heightPt - line.y1) * RENDER_SCALE,
    w: (line.x1 - line.x0) * RENDER_SCALE,
    h: (line.y1 - line.y0) * RENDER_SCALE,
    text: line.text,
    fontSize: clamp(Math.round(avgSize), 6, 72),
    whiteout: true, // 原文编辑默认遮盖原文字（删除失败时回退遮盖）
    bgColor: null, // 默认无色：导出时真正删除原文，不填充任何颜色
    coverBg: line.bg || '#ffffff', // 仅删除失败回退遮盖时使用（导出兜底，非界面底色）
    color: line.color || '#000000',
    fontId: matchFont(line.family) || el.fontSelect.value,
    bold: false,
    italic: false,
    italicLeft: false,
    underline: false,
    fromText: true,
    origFamily,
    origText: line.text, // 原文（导出时用于定位并删除原文字形）
    vertical: !!line.vertical,
    // 记住原文位置：移动文本框后，导出时在原位置补一块底色遮盖原文
    coverRect: { x: line.x0 * RENDER_SCALE, y: (p.heightPt - line.y1) * RENDER_SCALE, w: (line.x1 - line.x0) * RENDER_SCALE, h: (line.y1 - line.y0) * RENDER_SCALE },
  };
  pushUndo();
  p.boxes.push(box);
  const boxEl = createBoxElement(box, p);
  p.overlay.appendChild(boxEl);
  fitBox(box, boxEl);
  selectBox(box, boxEl);
  if (andEdit) startEditing(box, boxEl);
  schedulePageRefresh(p); // 原文立即从画面删除
}

// ---------------- 文本框（双击空白处新建） ----------------
function onOverlayMouseDown(e) {
  if (!editMode || e.target !== e.currentTarget) return;
  // 单击空白处：提交当前编辑（预览），不新建
  commitAll();
}

function onOverlayDblClick(e) {
  if (!editMode || e.target !== e.currentTarget) return;
  // 双击空白处：新建文本框并直接进入编辑
  const rect = e.currentTarget.getBoundingClientRect();
  const box = addBox(e.currentTarget, e.clientX - rect.left, e.clientY - rect.top);
  if (box && selectedBoxEl) startEditing(box, selectedBoxEl);
}

function addBox(overlay, x, y) {
  const page = pages.find((p) => p.overlay === overlay);
  if (!page) return null;
  const box = {
    id: boxSeq++,
    x: clamp(x, 0, overlay.clientWidth - 80),
    y: clamp(y, 0, overlay.clientHeight - 24),
    w: 180,
    h: 40,
    text: '',
    fontSize: clamp(Number(el.fontSize.value) || 12, 6, 72),
    whiteout: !el.bgNone.checked,
    bgColor: el.bgNone.checked ? null : el.bgColor.value || '#ffffff',
    color: el.color.value,
    fontId: el.fontSelect.value,
    bold: el.btnBold.classList.contains('active'),
    italic: el.btnItalic.classList.contains('active'),
    italicLeft: !!toolbarItalicLeft,
    underline: el.btnUnderline.classList.contains('active'),
  };
  pushUndo();
  page.boxes.push(box);
  const boxEl = createBoxElement(box, page);
  overlay.appendChild(boxEl);
  selectBox(box, boxEl);
  return box;
}

/** 删除文本框（✕ 按钮与键盘 Delete/Backspace 共用） */
function removeBox(box, boxEl) {
  pushUndo();
  const page = pages.find((p) => p.boxes.includes(box));
  if (page) {
    const i = page.boxes.indexOf(box);
    if (i >= 0) page.boxes.splice(i, 1);
    schedulePageRefresh(page); // 原文恢复显示
  }
  if (boxEl) {
    if (boxEl._coverMark) boxEl._coverMark.remove();
    hideFontTip();
    boxEl.remove();
  }
  if (selectedBox === box) selectBox(null, null);
}

// ---------------- 复制 / 粘贴文本框 ----------------
let copiedBox = null; // { data: {...box}, pageIndex }

function copyBox() {
  if (!selectedBox) return;
  copiedBox = {
    data: { ...selectedBox },
    pageIndex: pages.findIndex((p) => p.boxes.includes(selectedBox)),
  };
  setStatus('已复制文本框（Ctrl/Cmd+V 粘贴）', false);
}

function pasteBox() {
  if (!copiedBox) return;
  const pg = pages[copiedBox.pageIndex] || pages[0];
  if (!pg) return;
  const nb = { ...copiedBox.data, id: boxSeq++ };
  nb.x = clamp(nb.x + 16, 0, pg.overlay.clientWidth - nb.w);
  nb.y = clamp(nb.y + 16, 0, pg.overlay.clientHeight - nb.h);
  if (nb.coverRect) nb.coverRect = { ...nb.coverRect, x: nb.x, y: nb.y };
  pushUndo();
  pg.boxes.push(nb);
  const nbEl = createBoxElement(nb, pg);
  pg.overlay.appendChild(nbEl);
  fitBox(nb, nbEl);
  selectBox(nb, nbEl);
  schedulePageRefresh(pg); // 粘贴的原文框同样删除原区域文字
}

// ---------------- 编辑框状态机：预览 / 选中 / 编辑 ----------------
function startEditing(box, boxEl) {
  const t = boxEl.querySelector('.box-text');
  if (!t || t.contentEditable === 'true') return;
  pushUndo(); // 记录编辑前状态，一次编辑会话一个撤销步
  boxEl.classList.add('editing');
  t.contentEditable = 'true';
  t.focus();
  const range = document.createRange();
  range.selectNodeContents(t);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function commitEditing(box, boxEl) {
  if (!boxEl) return;
  const t = boxEl.querySelector('.box-text');
  if (t && t.contentEditable === 'true') t.contentEditable = 'false';
  boxEl.classList.remove('editing');
}

/** 提交当前编辑并取消选中（回到预览状态，不退出编辑模式） */
function commitAll() {
  if (selectedBoxEl && selectedBox) commitEditing(selectedBox, selectedBoxEl);
  selectBox(null, null);
}

// ---------------- 文本框悬停字体提示 ----------------
let fontTipEl = null;
function fontTip() {
  if (!fontTipEl) {
    fontTipEl = document.createElement('div');
    fontTipEl.id = 'font-tip';
    document.body.appendChild(fontTipEl);
  }
  return fontTipEl;
}

/** 悬停文本框时显示框内当前字体（原文编辑框还会标注原文所用的字体） */
function showFontTip(box, boxEl) {
  const cur = fontDisplayName(box.fontId);
  let text = `字体：${cur}`;
  if (box.origFamily && cleanFamily(box.origFamily).toLowerCase() !== cur.toLowerCase()) {
    text += `（原文：${box.origFamily}）`;
  }
  const tip = fontTip();
  tip.textContent = text;
  const rect = boxEl.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = rect.top - th - 6;
  if (top < 4) top = rect.bottom + 6; // 顶部放不下时显示在框下方
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
  tip.classList.add('show');
}

function hideFontTip() {
  if (fontTipEl) fontTipEl.classList.remove('show');
}

function createBoxElement(box, page) {
  const root = document.createElement('div');
  root.className = 'box';
  root.title = box.origFamily ? `原字体：${box.origFamily}（未加载同名字体时使用所选字体）` : '';

  const del = document.createElement('button');
  del.className = 'box-del';
  del.textContent = '✕';
  del.title = '删除此文本框';
  del.addEventListener('mousedown', (e) => e.stopPropagation());
  del.addEventListener('click', () => removeBox(box, root));

  const text = document.createElement('div');
  text.className = 'box-text';
  text.contentEditable = 'false'; // 预览态，选中后双击进入编辑
  text.spellcheck = false;
  text.textContent = box.text || '';
  text.addEventListener('input', () => {
    box.text = text.innerText;
    fitBox(box, root);
    schedulePersist();
  });
  text.addEventListener('blur', () => commitEditing(box, root));
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      commitEditing(box, root);
      selectBox(null, null);
    }
  });

  const handle = document.createElement('div');
  handle.className = 'box-resize';
  handle.title = '拖动调整大小';

  root.appendChild(text);
  root.appendChild(del);
  root.appendChild(handle);

  // 原文删除区域标记：完全透明（原文已从重绘后的画面中删除），仅作点击捕获与选中虚线提示
  if (box.coverRect) {
    const mark = document.createElement('div');
    mark.className = 'cover-mark';
    mark.style.left = box.coverRect.x + 'px';
    mark.style.top = box.coverRect.y + 'px';
    mark.style.width = box.coverRect.w + 'px';
    mark.style.height = box.coverRect.h + 'px';
    // 点击原位置：选中对应的文本框（而不是穿透到原文层再建新框）
    mark.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectBox(box, root);
    });
    mark.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startEditing(box, root);
    });
    // 悬停原文遮挡区同样显示该文本框的字体
    mark.addEventListener('mouseenter', () => showFontTip(box, root));
    mark.addEventListener('mouseleave', hideFontTip);
    page.overlay.appendChild(mark);
    root._coverMark = mark;
  }

  // 单击选中并可直接拖动整个框移动（编辑状态中不拖动）
  root.addEventListener('mousedown', (e) => {
    if (root.classList.contains('editing')) return;
    e.preventDefault();
    hideFontTip(); // 拖动时提示位置会过期，先隐藏
    selectBox(box, root);
    const rect = page.overlay.getBoundingClientRect();
    drag = {
      box, page, root,
      offX: e.clientX - rect.left - box.x,
      offY: e.clientY - rect.top - box.y,
      startX: box.x, startY: box.y,
      before: snapshot(),
    };
  });
  // 双击进入编辑
  root.addEventListener('dblclick', (e) => {
    if (root.classList.contains('editing')) return;
    e.preventDefault();
    startEditing(box, root);
  });
  // 悬停显示框内字体
  root.addEventListener('mouseenter', () => showFontTip(box, root));
  root.addEventListener('mouseleave', hideFontTip);
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideFontTip();
    resize = {
      box, page, root,
      startW: box.w, startH: box.h,
      before: snapshot(),
    };
  });

  applyBoxStyle(root, box);
  return root;
}

function applyBoxStyle(root, box) {
  root.style.left = box.x + 'px';
  root.style.top = box.y + 'px';
  root.style.width = box.w + 'px';
  root.style.height = box.h + 'px';
  // 底色：仅用户手动选择时显示，不自动加任何背景
  root.style.backgroundColor = box.bgColor || 'transparent';
  const t = root.querySelector('.box-text');
  t.style.fontSize = box.fontSize * RENDER_SCALE + 'px';
  t.style.color = box.color || '#000000';
  // 竖向文字：竖排输入方向
  if (box.vertical) {
    t.style.writingMode = 'vertical-rl';
    t.style.letterSpacing = '0.05em';
  } else {
    t.style.writingMode = '';
    t.style.letterSpacing = '';
  }
  const fam = familyFor(box.fontId);
  if (fam) t.style.fontFamily = `'${fam}'`;
  // Word 风格格式预览：右斜用原生 italic；左斜用 skewX(14deg)（实测顶向左 \）。
  // 注意：Chrome 会忽略 font-style: oblique 的负角度，左斜必须走 transform。
  t.style.fontWeight = box.bold ? 'bold' : 'normal';
  if (box.italic && box.italicLeft) {
    t.style.fontStyle = 'normal';
    t.style.transform = 'skewX(14deg)';
  } else {
    t.style.fontStyle = box.italic ? 'italic' : 'normal';
    t.style.transform = '';
  }
  t.style.textDecoration = box.underline ? 'underline' : 'none';
}

/** 内容超出框时自动撑大（横向框撑宽，竖向框撑高），防止折行/截断 */
function fitBox(box, boxEl) {
  const t = boxEl.querySelector('.box-text');
  if (!t) return;
  if (box.vertical) {
    if (t.scrollHeight > t.clientHeight + 1) {
      box.h += t.scrollHeight - t.clientHeight + 2;
      applyBoxStyle(boxEl, box);
    }
  } else if (t.scrollWidth > t.clientWidth + 1) {
    box.w += t.scrollWidth - t.clientWidth + 2;
    applyBoxStyle(boxEl, box);
  }
}

function selectBox(box, boxEl) {
  if (selectedBoxEl && selectedBox && selectedBox !== box) commitEditing(selectedBox, selectedBoxEl);
  if (selectedBoxEl) {
    selectedBoxEl.classList.remove('selected');
    if (selectedBoxEl._coverMark) selectedBoxEl._coverMark.classList.remove('show');
  }
  selectedBox = box;
  selectedBoxEl = boxEl || null;
  if (selectedBoxEl) {
    selectedBoxEl.classList.add('selected');
    if (selectedBoxEl._coverMark) selectedBoxEl._coverMark.classList.add('show');
  }
  if (selectedBox) {
    el.fontSize.value = selectedBox.fontSize;
    el.color.value = selectedBox.color;
    setFontSelectValue(selectedBox.fontId || DEFAULT_FONT_ID);
    el.bgColor.value = selectedBox.bgColor || '#ffffff';
    el.bgNone.checked = !selectedBox.bgColor;
    el.btnBold.classList.toggle('active', !!selectedBox.bold);
    updateItalicBtn(selectedBox);
    el.btnUnderline.classList.toggle('active', !!selectedBox.underline);
  }
}

window.addEventListener('mousemove', (e) => {
  if (drag) {
    const rect = drag.page.overlay.getBoundingClientRect();
    drag.box.x = clamp(e.clientX - rect.left - drag.offX, 0, rect.width - drag.box.w);
    drag.box.y = clamp(e.clientY - rect.top - drag.offY, 0, rect.height - drag.box.h);
    applyBoxStyle(drag.root, drag.box);
  }
  if (resize) {
    const rect = resize.page.overlay.getBoundingClientRect();
    resize.box.w = clamp(e.clientX - rect.left - resize.box.x, 40, rect.width - resize.box.x);
    resize.box.h = clamp(e.clientY - rect.top - resize.box.y, 24, rect.height - resize.box.y);
    applyBoxStyle(resize.root, resize.box);
  }
});
window.addEventListener('mouseup', () => {
  if (drag && (drag.box.x !== drag.startX || drag.box.y !== drag.startY)) {
    pushUndo(drag.before);
  }
  if (resize && (resize.box.w !== resize.startW || resize.box.h !== resize.startH)) {
    pushUndo(resize.before);
  }
  drag = null;
  resize = null;
});

// 键盘：Delete/Backspace 删除选中框；Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做
document.addEventListener('keydown', (e) => {
  if (!editMode) return;
  const ae = document.activeElement;
  const typing = ae && (ae.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(ae.tagName));
  if ((e.ctrlKey || e.metaKey) && !typing) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (k === 'c' && selectedBox) {
      e.preventDefault();
      copyBox();
      return;
    }
    if (k === 'v') {
      e.preventDefault();
      pasteBox();
      return;
    }
  }
  if (typing) return;
  if (!selectedBox || !selectedBoxEl) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    removeBox(selectedBox, selectedBoxEl);
  }
});

// ---------------- 字体管理 ----------------
// 可搜索字体选择器：隐藏 input 保存当前字体 id（兼容原有 value/change 用法），
// 搜索框输入过滤，下拉列表点击选择并派发 change 事件。
let fontItems = []; // { value, label, search }
let fontVisible = []; // 当前过滤后可见项
let fontHighlight = -1; // 键盘高亮索引

/** 设置当前字体并同步搜索框显示名（找不到时回退内置字体） */
function setFontSelectValue(id) {
  const target = id || DEFAULT_FONT_ID;
  el.fontSelect.value = target;
  const it = fontItems.find((x) => x.value === target);
  el.fontSearch.value = it ? it.label : defaultFontName();
}

function closeFontList() {
  el.fontList.classList.add('hidden');
  fontHighlight = -1;
}

function renderFontList(query) {
  const q = (query || '').trim().toLowerCase();
  fontVisible = q
    ? fontItems.filter(
        (it) => it.label.toLowerCase().includes(q) || it.search.toLowerCase().includes(q)
      )
    : [...fontItems];
  el.fontList.innerHTML = '';
  fontHighlight = -1;
  if (!fontVisible.length) {
    const d = document.createElement('div');
    d.className = 'font-empty';
    d.textContent = '没有匹配的字体';
    el.fontList.appendChild(d);
    return;
  }
  fontVisible.forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'font-item' + (it.value === el.fontSelect.value ? ' current' : '');
    d.dataset.index = String(i);
    d.textContent = it.label;
    d.addEventListener('mousedown', (e) => {
      e.preventDefault(); // 保持输入框焦点，避免先 blur 再选择
      pickFontItem(it);
    });
    el.fontList.appendChild(d);
  });
}

function moveFontHighlight(step) {
  if (!fontVisible.length) return;
  fontHighlight = Math.min(fontVisible.length - 1, Math.max(0, fontHighlight + step));
  const nodes = el.fontList.querySelectorAll('.font-item');
  nodes.forEach((n, i) => n.classList.toggle('hl', i === fontHighlight));
  nodes[fontHighlight]?.scrollIntoView({ block: 'nearest' });
}

function pickFontItem(it) {
  if (it.value !== el.fontSelect.value) {
    setFontSelectValue(it.value);
    el.fontSelect.dispatchEvent(new Event('change')); // 走统一 change 处理，应用到选中框
  }
  closeFontList();
}

el.fontSearch.addEventListener('focus', () => {
  renderFontList(el.fontSearch.value);
  el.fontList.classList.remove('hidden');
});
el.fontSearch.addEventListener('input', () => {
  renderFontList(el.fontSearch.value);
  el.fontList.classList.remove('hidden');
});
el.fontSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeFontList();
    el.fontSearch.value = fontItems.find((x) => x.value === el.fontSelect.value)?.label || '';
    el.fontSearch.blur();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveFontHighlight(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveFontHighlight(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const it = fontVisible[fontHighlight >= 0 ? fontHighlight : 0];
    if (it) pickFontItem(it);
  }
});
// 点击选择器外部时收起列表
document.addEventListener('mousedown', (e) => {
  if (!el.fontSearch.closest('.font-picker')?.contains(e.target)) closeFontList();
});

function refreshFontSelect() {
  const prev = el.fontSelect.value;
  const items = [{ value: DEFAULT_FONT_ID, label: defaultFontName(), search: '内置字体' }];
  // 同名字体自动加序号区分（如"宋体"、"宋体(2)"）
  const userItems = [...fonts.values()].map((f) => {
    const fileBase = String(f.file || '').replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
    return { id: f.id, label: fileBase || f.name, search: f.name || '' };
  });
  const counts = {};
  for (const it of userItems) counts[it.label] = (counts[it.label] || 0) + 1;
  const used = {};
  for (const it of userItems) {
    let label = it.label;
    if (counts[it.label] > 1) {
      used[it.label] = (used[it.label] || 0) + 1;
      label = `${it.label}(${used[it.label]})`;
    }
    items.push({ value: it.id, label, search: `${it.search} ${label}`.toLowerCase() });
  }
  fontItems = items;
  const keep = prev && fontItems.some((x) => x.value === prev);
  setFontSelectValue(keep ? prev : DEFAULT_FONT_ID);
  if (el.fontList && !el.fontList.classList.contains('hidden')) renderFontList(el.fontSearch.value);
}

/** 网页版：从本地后端加载字体库（清单 /api/fonts + 文件 /fonts-library/<名>，用户目录优先）。可重复调用（按文件名去重） */
async function loadWebFontLibrary() {
  if (window.electronAPI?.listFonts) return;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/fonts`);
    if (!res.ok) return;
    const data = await res.json();
    const names = [...new Set(Object.values(data.fonts || {}))]; // 按文件名去重
    let added = 0;
    for (const name of names) {
      if ([...fonts.values()].some((x) => x.file === name)) continue; // 已加载的跳过
      try {
        const fr = await fetch(`${import.meta.env.BASE_URL}fonts-library/${encodeURIComponent(name)}`);
        if (!fr.ok) continue;
        await addFontFromBytes(await fr.arrayBuffer(), name);
        added++;
      } catch (err) {
        console.warn('字体库加载失败', name, err);
      }
    }
    refreshFontSelect();
    if (added > 0) setStatus(`字体库新增 ${added} 个字体，当前共 ${fonts.size} 个。`, false);
    else if (fonts.size > 0) setStatus(`字体库已检索，共 ${fonts.size} 个字体。`, false);
  } catch (err) {
    console.warn(err);
  }
}

async function loadUserFonts() {
  if (!window.electronAPI?.listFonts) return;
  try {
    const list = await window.electronAPI.listFonts();
    for (const f of list) {
      if ([...fonts.values()].some((x) => x.file === f.file)) continue;
      try {
        const bytes = await window.electronAPI.readFont(f.file);
        await addFontFromBytes(bytes, f.file);
      } catch (err) {
        console.warn('字体加载失败', f.file, err);
      }
    }
    refreshFontSelect();
    if (fonts.size > 0) setStatus(`已从字体目录加载 ${fonts.size} 个字体。`, false);
  } catch (err) {
    console.warn(err);
  }
}

/** Uint8Array → base64（分块避免参数过长） */
function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

el.btnLoadFont.addEventListener('click', () => {
  el.fontInput.click(); // 弹出文件选择器（accept 已限定字体后缀）
});

el.fontInput.addEventListener('change', async () => {
  const files = [...el.fontInput.files];
  el.fontInput.value = '';
  for (const f of files) {
    try {
      const bytes = await f.arrayBuffer();
      const entry = await addFontFromBytes(bytes, f.name); // 不可用字体在此抛"不可用"
      const previewNote = entry.previewOk
        ? ''
        : '（浏览器无法预览该字体，界面将以默认字体显示；导出 PDF 仍使用真实字体）';
      // 桌面版：同时把字体文件写入用户字体目录，重启后自动加载
      if (window.electronAPI?.saveFontFile) {
        try {
          await window.electronAPI.saveFontFile({ file: f.name, data: bytes });
          setStatus(`字体已导入并保存到字体目录：${f.name}${previewNote}`, false);
        } catch (err) {
          setStatus(`字体已加载（保存到字体目录失败：${err.message}）`, true);
        }
      } else {
        // 网页版：POST 给本地后端写入用户字体目录（后端做 fontTools 校验，不可用会拒绝）
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}api/fonts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: f.name, data: bytesToBase64(bytes) }),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.error || `HTTP ${res.status}`);
          }
          setStatus(`字体已导入并保存到字体目录：${f.name}${previewNote}`, false);
        } catch (err) {
          fonts.delete(entry.id); // 后端判定不可用：从会话移除，避免导出时失败
          setStatus(`字体不可用（${f.name}）：${err.message}`, true);
        }
      }
    } catch (err) {
      setStatus(`字体不可用（${f.name}）：${err.message}`, true);
    }
  }
  refreshFontSelect();
});

el.btnFontDir.addEventListener('click', async () => {
  await window.electronAPI?.openFontsDir();
  loadUserFonts();
});

// 重新检索字体（桌面版扫字体目录，网页版重新拉字体库清单）
el.btnReloadFonts.addEventListener('click', async () => {
  if (window.electronAPI?.listFonts) {
    await loadUserFonts();
  } else {
    await loadWebFontLibrary();
  }
});

// ---------------- 保存导出 ----------------
async function save() {
  const annotations = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (p.rotation % 360 !== 0) {
      if (!confirm(`第 ${p.num} 页存在旋转（${p.rotation}°），旋转页面上文本框的位置可能不准确，仍继续导出？`)) {
        return;
      }
    }
    for (const b of p.boxes) {
      if (!b.text.trim() && !b.bgColor) continue; // 空文本且无底色：跳过
      // 原文删除标记：导出时真正删除原文文字绘制指令（背景保留），失败才回退遮盖
      if (b.coverRect) {
        annotations.push({
          pageIndex: i,
          x: b.coverRect.x / RENDER_SCALE,
          y: b.coverRect.y / RENDER_SCALE,
          w: b.coverRect.w / RENDER_SCALE,
          h: b.coverRect.h / RENDER_SCALE,
          text: '',
          fontSize: b.fontSize,
          whiteout: true,
          bgColor: b.coverBg || b.bgColor || '#ffffff',
          deleteOriginal: true,
          origText: b.origText || b.text || '',
          boxId: b.id,
        });
      }
      // 文本框是否已从原位置移走（移走则保留当前位置的用户底色）
      const moved = b.coverRect
        ? Math.abs(b.x - b.coverRect.x) > 4 || Math.abs(b.y - b.coverRect.y) > 4
        : true;
      // 竖向框：确保逐字换行输出（不同浏览器 innerText 行为可能不同）
      let textOut = b.text || '';
      if (b.vertical && !textOut.includes('\n')) textOut = textOut.split('').join('\n');
      annotations.push({
        pageIndex: i,
        x: b.x / RENDER_SCALE,
        y: b.y / RENDER_SCALE,
        w: b.w / RENDER_SCALE,
        h: b.h / RENDER_SCALE,
        text: textOut,
        fontSize: b.fontSize,
        whiteout: !!b.bgColor, // 有底色才遮盖
        bgColor: b.bgColor || undefined,
        color: b.color,
        fontId: b.fontId,
        bold: !!b.bold,
        italic: !!b.italic,
        italicLeft: !!b.italicLeft,
        underline: !!b.underline,
        boxId: b.id,
        skipWhiteoutIfDeleted: !moved, // 原文删除成功且未移动时跳过填充
      });
    }
  }
  if (annotations.length === 0) {
    setStatus('还没有添加任何文本。', true);
    return;
  }

  el.btnSave.disabled = true;
  el.btnSave.textContent = '生成中…';
  try {
    const result = await exportPdfBackend(pdfBytes, annotations, fonts);
    const out = result.bytes;
    const fileName = `${currentFileName.replace(/\.pdf$/i, '')}-已编辑.pdf`;
    const warnNote = result.warnings?.length
      ? ` — 注意: ${result.warnings.join('；')}`
      : '';

    if (window.electronAPI?.saveFile) {
      const ok = await window.electronAPI.saveFile({ data: out, suggestedName: fileName });
      if (!ok) setStatus('已取消导出。', true);
      else {
        clearSession();
        setStatus('已导出：' + fileName + warnNote, false); // 成功提示：绿色
      }
    } else {
      const blob = new Blob([out], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      clearSession();
      setStatus('已导出：' + fileName + warnNote, false); // 成功提示：绿色
    }
  } catch (err) {
    console.error(err);
    setStatus('导出失败：' + (err?.message || err), true);
  } finally {
    el.btnSave.disabled = false;
    el.btnSave.textContent = '导出 PDF';
  }
}

// ---------------- 事件绑定 ----------------
el.btnOpen.addEventListener('click', () => el.fileInput.click());
el.btnRecent.addEventListener('click', (e) => {
  e.stopPropagation();
  showRecent();
});
el.btnClose.addEventListener('click', () => closeProject());
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown')) el.recentList.classList.add('hidden');
});
el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files[0]) {
    openPdf(el.fileInput.files[0]);
    el.fileInput.value = '';
  }
});
el.btnEdit.addEventListener('click', () => {
  editMode = !editMode;
  el.btnEdit.textContent = editMode ? '浏览模式' : '编辑模式';
  el.btnEdit.classList.toggle('mode-browse', editMode);
  el.btnEdit.classList.toggle('mode-edit', !editMode);
  setEditToolsEnabled(editMode); // 浏览模式禁用编辑工具，编辑模式启用
  document.body.classList.toggle('viewing', !editMode);
  if (editMode) {
    setStatus('正在分析页面文字…', false);
    for (const p of pages) ensureTextLayer(p);
  }
});
/** 放弃编辑：二次确认后清空全部修改，恢复原始文档 */
function discardEdits() {
  if (!confirm('确认放弃本次编辑？所有未导出的修改将丢失，文档将恢复为打开时的状态。')) return;
  pages.forEach((p) => {
    p.boxes = [];
  });
  rerenderBoxes();
  undoStack = [];
  redoStack = [];
  refreshUndoButtons();
  clearSession();
  selectBox(null, null);
  for (const p of pages) schedulePageRefresh(p); // 恢复原始画面
  setStatus('已放弃本次编辑，恢复为原始文档。', false);
}

el.btnSave.addEventListener('click', save);
el.btnDiscard.addEventListener('click', discardEdits);
el.btnUndo.addEventListener('click', undo);
el.btnRedo.addEventListener('click', redo);

// Word 风格格式：粗体 / 斜体 / 下划线（应用到选中框；未选中时作为新框默认）
function fmtToggle(prop, btn) {
  if (selectedBox) pushUndo();
  btn.classList.toggle('active');
  if (selectedBox) {
    selectedBox[prop] = btn.classList.contains('active');
    applyBoxStyle(selectedBoxEl, selectedBox);
    fitBox(selectedBox, selectedBoxEl);
  }
}
el.btnBold.addEventListener('click', () => fmtToggle('bold', el.btnBold));
el.btnUnderline.addEventListener('click', () => fmtToggle('underline', el.btnUnderline));

// 斜体：三态循环 关 → 右斜 → 左斜 → 关；未选中时按钮状态作为新框默认
let toolbarItalicLeft = false;
function updateItalicBtn(box) {
  const active = box ? !!box.italic : el.btnItalic.classList.contains('active');
  const left = box ? !!box.italicLeft : !!toolbarItalicLeft;
  el.btnItalic.classList.toggle('active', active);
  // 按钮就一个符号：未激活显示 I，激活时右斜显示 /，左斜显示 \
  const mark = el.btnItalic.querySelector('.italic-mark');
  if (mark) {
    mark.textContent = !active ? 'I' : left ? '\\' : '/';
  }
  el.btnItalic.title = !active
    ? '斜体'
    : left
      ? '斜体：向左斜（再点关闭）'
      : '斜体：向右斜（再点切换左斜）';
}
el.btnItalic.addEventListener('click', () => {
  const box = selectedBox;
  const cur = box
    ? { italic: !!box.italic, left: !!box.italicLeft }
    : { italic: el.btnItalic.classList.contains('active'), left: !!toolbarItalicLeft };
  const next = !cur.italic
    ? { italic: true, left: false }
    : !cur.left
      ? { italic: true, left: true }
      : { italic: false, left: false };
  if (box) {
    pushUndo();
    box.italic = next.italic;
    box.italicLeft = next.left;
    applyBoxStyle(selectedBoxEl, box);
    fitBox(box, selectedBoxEl);
  } else {
    el.btnItalic.classList.toggle('active', next.italic);
  }
  toolbarItalicLeft = next.left; // 新框默认沿用当前方向（关闭后回到右斜）
  updateItalicBtn(box || null);
});

// 工具栏设置实时应用到选中的文本框（变更前记录一次快照用于撤销）
let toolbarPending = null;
const toolbarBegin = () => {
  if (selectedBox && !toolbarPending) toolbarPending = snapshot();
};
const toolbarCommit = () => {
  if (toolbarPending) {
    pushUndo(toolbarPending);
    toolbarPending = null;
  }
};

el.fontSize.addEventListener('input', () => {
  if (selectedBox) {
    toolbarBegin();
    selectedBox.fontSize = clamp(Number(el.fontSize.value) || 12, 6, 72);
    applyBoxStyle(selectedBoxEl, selectedBox);
    fitBox(selectedBox, selectedBoxEl);
  }
});
el.fontSize.addEventListener('change', toolbarCommit);

el.color.addEventListener('input', () => {
  if (selectedBox) {
    toolbarBegin();
    selectedBox.color = el.color.value;
    applyBoxStyle(selectedBoxEl, selectedBox);
  }
});
el.color.addEventListener('change', toolbarCommit);

el.bgColor.addEventListener('input', () => {
  if (selectedBox) {
    toolbarBegin();
    selectedBox.bgColor = el.bgColor.value || '#ffffff';
    applyBoxStyle(selectedBoxEl, selectedBox);
  }
});
el.bgColor.addEventListener('change', toolbarCommit);

el.bgNone.addEventListener('change', () => {
  if (selectedBox) {
    pushUndo();
    selectedBox.bgColor = el.bgNone.checked ? null : el.bgColor.value || '#ffffff';
    applyBoxStyle(selectedBoxEl, selectedBox);
  }
});

el.fontSelect.addEventListener('change', () => {
  if (selectedBox) {
    pushUndo();
    selectedBox.fontId = el.fontSelect.value;
    applyBoxStyle(selectedBoxEl, selectedBox);
  }
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) openPdf(f);
  else setStatus('请拖入 PDF 文件。', true);
});

// ---------------- 临时保存（编辑会话持久化） ----------------
// 编辑过程自动暂存到 localStorage，刷新/重启后恢复；点「导出 PDF」成功后清除
const SESSION_KEY = 'pdf-editor-session';
let persistTimer = null;

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistSession, 400);
}

function persistSession() {
  if (!pdfBytes || !pages.length) return;
  try {
    if (pdfBytes.length > 3 * 1024 * 1024) return; // 过大不持久化
    let bin = '';
    for (let i = 0; i < pdfBytes.length; i++) bin += String.fromCharCode(pdfBytes[i]);
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        fileName: currentFileName,
        pdf: btoa(bin),
        boxes: pages.map((p) => p.boxes.map((b) => ({ ...b }))),
        editMode,
      })
    );
  } catch (err) {
    console.warn('会话保存失败', err);
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}

async function restoreSession() {
  let raw = null;
  try {
    raw = localStorage.getItem(SESSION_KEY);
  } catch { /* ignore */ }
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    if (!s.pdf || !Array.isArray(s.boxes)) return;
    const bytes = Uint8Array.from(atob(s.pdf), (c) => c.charCodeAt(0));
    // 校验 PDF 签名，损坏的会话直接丢弃
    const sig = String.fromCharCode(...bytes.slice(0, 5));
    if (sig !== '%PDF-') {
      clearSession();
      return;
    }
    const f = new File([bytes], s.fileName || 'document.pdf', { type: 'application/pdf' });
    await openPdf(f);
    pages.forEach((p, i) => {
      p.boxes = (s.boxes[i] || []).map((b) => ({ ...b }));
    });
    rerenderBoxes();
    if (s.editMode && !editMode) el.btnEdit.click();
    setStatus(
      `已恢复上次未完成的编辑（${s.fileName || 'document.pdf'}）。点「导出 PDF」完成下载。`,
      false
    );
  } catch (err) {
    console.warn('恢复编辑会话失败', err);
  }
}

// ---------------- 标签页 / 项目管理 ----------------
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  el.panelProject.classList.toggle('active', tab === 'project');
  el.panelEdit.classList.toggle('active', tab === 'edit');
}

/** 浏览模式下禁用编辑工具，编辑模式启用（撤销/重做按各自栈状态恢复） */
function setEditToolsEnabled(on) {
  const controls = el.panelEdit.querySelectorAll('#editTools button, #editTools input, #editTools select');
  for (const c of controls) {
    // 字体管理在浏览/编辑两种模式下都可用
    if (c.id === 'fontInput' || c.id === 'btnLoadFont' || c.id === 'btnReloadFonts' || c.id === 'btnFontDir') continue;
    c.disabled = !on;
  }
  if (on) refreshUndoButtons();
}
document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab))
);

const RECENT_KEY = 'pdf-editor-recent';

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
  } catch { /* ignore */ }
}

/** 打开成功后记录历史项目（桌面版记路径，网页版缓存小文件字节） */
function recordRecent(file, bytes) {
  try {
    const list = loadRecent();
    const name = file.name || 'document.pdf';
    let path = null;
    if (window.electronAPI?.getPathForFile) {
      try {
        path = window.electronAPI.getPathForFile(file);
      } catch { /* ignore */ }
    }
    const entry = { name, path: path || null, time: Date.now() };
    if (!path && bytes && bytes.length <= 2 * 1024 * 1024) {
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      entry.bytes = btoa(bin);
    }
    const filtered = list.filter((e) => !(e.name === name && (e.path || null) === (path || null)));
    filtered.unshift(entry);
    saveRecent(filtered);
    renderRecent();
  } catch { /* ignore */ }
}

function renderRecent() {
  const list = loadRecent();
  el.recentList.innerHTML = '';
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'recent-empty';
    d.textContent = '暂无历史项目';
    el.recentList.appendChild(d);
    return;
  }
  for (const e of list) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.textContent = e.name;
    item.title = e.path || (e.bytes ? '（网页缓存）' : '（未缓存，需重新选择）');
    item.addEventListener('click', () => openRecent(e));
    el.recentList.appendChild(item);
  }
  const clear = document.createElement('div');
  clear.className = 'recent-clear';
  clear.textContent = '清除历史';
  clear.addEventListener('click', () => {
    localStorage.removeItem(RECENT_KEY);
    renderRecent();
  });
  el.recentList.appendChild(clear);
}

function showRecent() {
  renderRecent();
  el.recentList.classList.toggle('hidden');
}

async function openRecent(entry) {
  el.recentList.classList.add('hidden');
  try {
    if (entry.path && window.electronAPI?.readPdfFile) {
      const bytes = await window.electronAPI.readPdfFile(entry.path);
      await openPdf(new File([bytes], entry.name, { type: 'application/pdf' }));
    } else if (entry.bytes) {
      const bytes = Uint8Array.from(atob(entry.bytes), (c) => c.charCodeAt(0));
      await openPdf(new File([bytes], entry.name, { type: 'application/pdf' }));
    } else {
      setStatus('该文件未缓存，请用「打开」重新选择。', true);
    }
  } catch (err) {
    setStatus('打开历史项目失败：' + (err?.message || err), true);
  }
}

/** 关闭当前项目（清空文档、撤销栈与临时保存） */
function closeProject(statusMsg) {
  if (currentPdfDoc) {
    try {
      currentPdfDoc.destroy();
    } catch { /* ignore */ }
    currentPdfDoc = null;
  }
  pdfBytes = null;
  pages = [];
  editMode = false;
  selectedBox = null;
  selectedBoxEl = null;
  drag = null;
  resize = null;
  undoStack = [];
  redoStack = [];
  el.pages.innerHTML = '';
  el.btnSave.disabled = true;
  el.btnEdit.disabled = true;
  el.btnEdit.textContent = '编辑模式';
  el.btnEdit.classList.remove('mode-browse');
  el.btnEdit.classList.add('mode-edit');
  setEditToolsEnabled(false);
  el.hint.style.display = '';
  document.body.classList.add('viewing');
  clearSession();
  refreshUndoButtons();
  hidePageBadge();
  el.zoomBar.hidden = true;
  setStatus(statusMsg || '已关闭当前项目。', false);
}

// ---------------- 显示缩放（左下角缩放条，50%~300%；CSS zoom 只影响显示，不影响导出坐标） ----------------
const ZOOM_MIN = 0.5, ZOOM_MAX = 3, ZOOM_STEP = 0.1;
let displayZoom = 1;

function applyZoom() {
  displayZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(displayZoom * 100) / 100));
  el.pages.style.zoom = String(displayZoom);
  el.zoomPct.textContent = `${Math.round(displayZoom * 100)}%`;
  el.btnZoomOut.disabled = displayZoom <= ZOOM_MIN;
  el.btnZoomIn.disabled = displayZoom >= ZOOM_MAX;
}

function setZoom(z, showBadge = true) {
  displayZoom = z;
  applyZoom();
  if (showBadge) updatePageBadge(true); // 缩放时同步显示页标+比例
}

function resetZoom() {
  el.zoomBar.hidden = false;
  displayZoom = 1;
  applyZoom();
}

el.btnZoomOut.addEventListener('click', () => setZoom(displayZoom - ZOOM_STEP));
el.btnZoomIn.addEventListener('click', () => setZoom(displayZoom + ZOOM_STEP));
el.zoomPct.addEventListener('click', () => setZoom(1));

// ---------------- 右下角页标（滚动/缩放时显示 当前页/总页数 · 比例） ----------------
let badgeTimer = null;

function currentPageIndex() {
  const mid = window.innerHeight / 2;
  const els = document.querySelectorAll('.page');
  let cur = 0;
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (r.top <= mid && r.bottom > mid) return i;
    if (r.top <= mid) cur = i;
  }
  return cur;
}

function updatePageBadge(forceShow) {
  if (!pages.length) return;
  el.pageBadge.textContent = `${currentPageIndex() + 1} / ${pages.length} · ${Math.round(displayZoom * 100)}%`;
  el.pageBadge.classList.add('show');
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => el.pageBadge.classList.remove('show'), forceShow ? 2500 : 1200);
}

function hidePageBadge() {
  clearTimeout(badgeTimer);
  el.pageBadge.classList.remove('show');
}

window.addEventListener('scroll', () => {
  if (pages.length) updatePageBadge();
}, { passive: true });

// ---------------- 页面实时重绘（原文删除的所见即所得） ----------------
// 创建/删除文本框后，用文字删除引擎重绘该页：原文立刻从画面消失，与导出一致
const refreshTimers = new Map();

function schedulePageRefresh(p) {
  if (!p || !pdfBytes) return;
  clearTimeout(refreshTimers.get(p));
  refreshTimers.set(
    p,
    setTimeout(() => refreshPageDisplay(p), 250)
  );
}

async function refreshPageDisplay(p) {
  try {
    const deletions = [];
    for (const b of p.boxes) {
      if (b.coverRect) {
        deletions.push({
          pageIndex: 0,
          x: b.coverRect.x / RENDER_SCALE,
          y: b.coverRect.y / RENDER_SCALE,
          w: b.coverRect.w / RENDER_SCALE,
          h: b.coverRect.h / RENDER_SCALE,
          origText: b.origText || b.text || '',
          boxId: b.id,
        });
      }
    }
    const bytes = await deleteTextOnly(pdfBytes, p.num - 1, deletions);
    if (!bytes) return;
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const page = await doc.getPage(p.num);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    if (viewport.width !== p.canvas.width || viewport.height !== p.canvas.height) {
      p.canvas.width = viewport.width;
      p.canvas.height = viewport.height;
    }
    await page.render({ canvasContext: p.canvas.getContext('2d'), viewport }).promise;
    await doc.destroy();
  } catch (err) {
    console.warn('页面重绘失败', err);
  }
}

// ---------------- 初始化 ----------------
refreshFontSelect();
refreshUndoButtons();
setEditToolsEnabled(false); // 默认浏览模式：编辑工具禁用
if (window.electronAPI?.listFonts) {
  el.btnFontDir.hidden = false;
  loadUserFonts();
}
loadWebFontLibrary(); // 网页版加载 fonts-library 目录（桌面版自动跳过）
restoreSession(); // 恢复上次未完成的编辑

// 开发/自动化调试入口（无副作用）
window.__pdfEditor = {
  openPdf,
  addFontFromBytes,
  refreshFontSelect,
  textLines: () =>
    pages.map((p) =>
      p.textLines.map((l) => ({
        text: l.text,
        color: l.color,
        bg: l.bg,
        bbox: [l.x0, l.y0, l.x1, l.y1],
        family: l.family,
        fontNameRaw: l.fontNameRaw,
      }))
    ),
  fontDebug: () => pages.map((p) => ({ entries: p.fontEntries, map: p.fontNameMap })),
};
