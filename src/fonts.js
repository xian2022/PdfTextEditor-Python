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
 * 字体内部名称解析失败（部分大字体在老版 fontkit 下有兼容问题）时，
 * 不影响字体加载，名称回退为文件名。
 * @param {ArrayBuffer|Uint8Array} bytes 字体二进制
 * @param {string} file 显示用文件名
 */
export async function addFontFromBytes(bytes, file) {
  const buf = new Uint8Array(bytes);
  let name = null;
  try {
    const f = fontkit.create(buf);
    name = f.familyName || f.fullName || null;
  } catch (err) {
    console.warn('字体名称解析失败，使用文件名:', file, err?.message);
  }
  if (!name) name = baseName(file) || '字体';
  const id = 'font_' + Math.random().toString(36).slice(2, 10);
  const family = 'LocalFont' + id.replace(/[^a-zA-Z0-9]/g, '');
  const ff = new FontFace(family, buf);
  await ff.load();
  document.fonts.add(ff);
  const entry = { id, name, file: file || null, bytes: buf, family };
  fonts.set(id, entry);
  return entry;
}
