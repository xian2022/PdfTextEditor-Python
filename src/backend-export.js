// 导出统一走本地 Python 后端（PyMuPDF + fontTools，字体嵌入可靠）。
// 后端不可用时直接报错并提示启动方式，不保留 JS 兜底管线。
import { loadFontBytes } from './pdf-save.js';

const BACKEND_URLS = ['http://127.0.0.1:8765', 'http://localhost:8765'];
const BACKEND_TIMEOUT = 120000;
const MOVED_THRESHOLD_PT = 3; // 与 main.js 中 4px / RENDER_SCALE(1.5) 的移动判定一致

function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 把 save() 产出的 annotations 转成后端 ops（fonts 为字体注册表 Map）。
 * deletes：原文删除矩形（后端真删除，失败时用 fallbackColor 遮盖兜底）
 * fills：用户底色的遮盖矩形（原文删除成功且框未移动时后端会跳过）
 * texts：文本写入项（x/y 距页面左上，pt）
 */
export async function buildBackendOps(annotations, fonts) {
  const fontSpecs = {};
  const fontIds = new Set();
  const texts = [];
  const deletes = [];
  const fills = [];
  const deleteRectByBox = new Map(); // boxId -> {x, y, w, h}（原文位置）
  for (const ann of annotations) {
    if (ann.deleteOriginal && ann.w > 0 && ann.h > 0) {
      deletes.push({
        page: ann.pageIndex,
        rects: [[ann.x, ann.y, ann.w, ann.h]],
        fallbackColor: ann.bgColor || '#ffffff',
        boxId: ann.boxId,
      });
      if (ann.boxId != null) {
        deleteRectByBox.set(ann.boxId, { x: ann.x, y: ann.y, w: ann.w, h: ann.h });
      }
    }
    if (ann.text && ann.text.trim()) {
      texts.push({
        page: ann.pageIndex,
        x: ann.x,
        y: ann.y,
        size: ann.fontSize,
        text: ann.text,
        color: ann.color || '#000000',
        bold: !!ann.bold,
        italic: !!ann.italic,
        underline: !!ann.underline,
        fontId: String(ann.fontId),
        boxId: ann.boxId,
      });
      fontIds.add(ann.fontId);
    }
    // 用户底色：deleteOriginal 标注由后端删除失败兜底处理，这里只收集文本框自己的底色
    if (!ann.deleteOriginal && ann.whiteout && ann.bgColor && ann.w > 0 && ann.h > 0) {
      const orig = ann.boxId != null ? deleteRectByBox.get(ann.boxId) : null;
      const moved =
        !orig ||
        Math.abs(ann.x - orig.x) > MOVED_THRESHOLD_PT ||
        Math.abs(ann.y - orig.y) > MOVED_THRESHOLD_PT;
      fills.push({
        page: ann.pageIndex,
        x: ann.x,
        y: ann.y,
        w: ann.w,
        h: ann.h,
        color: ann.bgColor,
        boxId: ann.boxId,
        moved,
      });
    }
  }
  for (const fid of fontIds) {
    const entry = fonts?.get(fid);
    let bytes = entry?.bytes || null;
    if (!bytes && fid === '__default__') {
      try {
        bytes = new Uint8Array(await loadFontBytes());
      } catch (err) {
        console.warn('内置字体加载失败，该字体交由后端按名称解析', err);
      }
    }
    if (bytes) fontSpecs[fid] = { bytes: bytesToBase64(bytes) };
  }
  return { fonts: fontSpecs, texts, deletes, fills };
}

function collectWarnings(report) {
  const warnings = [];
  for (const r of report || []) {
    if (r.error) {
      warnings.push(`自检异常：${r.error}`);
      continue;
    }
    if (r.dropped_chars) {
      for (const d of r.dropped_chars) {
        warnings.push(`字符「${d.char}」(${d.codepoint}) 无可用字体，已跳过`);
      }
    }
    if (r.rendered === false) warnings.push(`「${r.text}」渲染自检未检测到文字`);
    else if (r.extractable === false) warnings.push(`「${r.text}」文字不可提取`);
  }
  return warnings;
}

async function tryBackend(pdfBytes, ops) {
  const payload = JSON.stringify({ pdf: bytesToBase64(pdfBytes), ops });
  let lastErr = null;
  for (const base of BACKEND_URLS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), BACKEND_TIMEOUT);
      const res = await fetch(`${base}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || !data.pdf) throw new Error(data?.error || '后端返回异常');
      return { bytes: base64ToBytes(data.pdf), warnings: collectWarnings(data.report) };
    } catch (err) {
      lastErr = err;
      console.warn(`后端 ${base} 不可用:`, err?.message || err);
    }
  }
  throw new Error(
    '本地服务未运行（已尝试 ' + BACKEND_URLS.join('、') + '）。' +
    '请先启动后端：cd backend && ./.venv/bin/python app.py，然后重试。' +
    (lastErr ? `（最后错误：${lastErr.message || lastErr}）` : '')
  );
}

/**
 * 后端导出（唯一路径）。
 * @returns {Promise<{bytes: Uint8Array, warnings: string[]}>}
 */
export async function exportPdfBackend(pdfBytes, annotations, fonts) {
  const ops = await buildBackendOps(annotations, fonts);
  const result = await tryBackend(pdfBytes, ops);
  return { bytes: result.bytes, warnings: result.warnings };
}
