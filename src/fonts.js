import fontkit from '@pdf-lib/fontkit';

export const DEFAULT_FONT_ID = '__default__';
// id -> { id, name, file, bytes, family }
export const fonts = new Map();

let defaultFamily = '';
let defaultName = '内置字体';

/** 内置字体显示名（读取字体内部真实名称，如"OPPO Sans 4.0"） */
export function defaultFontName() {
  return defaultName;
}

/** 把内置字体注册为 DOM FontFace，供编辑框预览使用 */
export async function initDefaultFont(bytes) {
  try {
    const buf = new Uint8Array(bytes);
    try {
      const f = fontkit.create(buf);
      if (f.familyName) defaultName = String(f.familyName);
    } catch { /* 名称解析失败则保留"内置字体" */ }
    const ff = new FontFace('LocalDefaultFont', buf);
    await ff.load();
    document.fonts.add(ff);
    defaultFamily = 'LocalDefaultFont';
  } catch (err) {
    console.warn('内置字体注册失败', err);
  }
}

/** 取字体在 DOM 中可用的 font-family 名 */
export function familyFor(id) {
  if (id === DEFAULT_FONT_ID) return defaultFamily;
  return fonts.get(id)?.family || defaultFamily;
}

/** 字体显示名（界面提示用）：内置字体用其内部真实名，用户字体用解析名 */
export function fontDisplayName(id) {
  if (id === DEFAULT_FONT_ID) return defaultName || '内置字体';
  const f = fonts.get(id);
  return (f && f.name) || '字体';
}

/** 从文件路径取不带扩展名的文件名 */
function baseName(p) {
  const s = String(p || '').replace(/\\/g, '/').split('/').pop() || '';
  return s.replace(/\.[^.]+$/, '');
}

/**
 * 解析并注册一个用户字体（TTF/OTF/WOFF/WOFF2）
 * 判定规则：
 *  - fontkit 能解析 → 字体数据有效（后端 fontTools 同样可解析，导出可用）；
 *  - FontFace.load 成功 → 浏览器可预览（previewOk=true）；
 *  - 部分旧版/特殊字体（如老式 Mac 编码的 TrueType）会被 Chromium 的 OTS 拒绝加载，
 *    但后端 fontTools 仍可正常子集化嵌入，此时 previewOk=false、界面回退默认字体预览，
 *    导出 PDF 仍使用真实字体；
 *  - fontkit 与 FontFace 都失败 → 判定不可用，抛出友好错误。
 * @param {ArrayBuffer|Uint8Array} bytes 字体二进制
 * @param {string} file 显示用文件名
 */
export async function addFontFromBytes(bytes, file) {
  const buf = new Uint8Array(bytes);
  if (!buf.length) throw new Error('字体文件不可用：文件内容为空');
  let name = null;
  let parseOk = true;
  try {
    const f = fontkit.create(buf);
    name = f.familyName || f.fullName || null;
  } catch (err) {
    parseOk = false;
    console.warn('字体名称解析失败，使用文件名:', file, err?.message);
  }
  if (!name) name = baseName(file) || '字体';
  const id = 'font_' + Math.random().toString(36).slice(2, 10);
  const family = 'LocalFont' + id.replace(/[^a-zA-Z0-9]/g, '');
  const ff = new FontFace(family, buf);
  let previewOk = true;
  try {
    await ff.load();
    document.fonts.add(ff);
  } catch (err) {
    previewOk = false;
    console.warn('浏览器无法加载该字体（界面将回退默认字体预览，导出仍使用真实字体）', file, err);
  }
  if (!parseOk && !previewOk) {
    throw new Error('字体文件不可用：无法解析（文件可能已损坏或不是有效的字体文件）');
  }
  const entry = { id, name, file: file || null, bytes: buf, family, previewOk };
  fonts.set(id, entry);
  return entry;
}
