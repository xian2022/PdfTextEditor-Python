// 从 PDF 内容流中定位并删除指定矩形区域内的文字绘制指令
// 原理：PDF 文字是定位绘制（BT/Tf/Tm/Tj），解析内容流跟踪文本矩阵，
// 把落在目标矩形内的 Tj/TJ 替换为空操作（0 0 Td），背景原样保留。

/** 词法切分内容流：保留每个操作数/操作符的原始文本，便于无损重建 */
export function tokenize(stream) {
  const tokens = [];
  const s = stream;
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f') {
      i++;
      continue;
    }
    if (c === '%') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
      continue;
    }
    // 内联图片：跳过 BI..EI 之间的原始数据
    if (c === 'B' && /[A-Za-z]/.test(s[i + 1] || '') && s[i] !== '(') {
      // 仅当 "BI" 后跟空白时视为内联图片开始
      if (s.slice(i, i + 2) === 'BI' && /\s/.test(s[i + 2] || '') && s[i + 2] !== undefined) {
        const start = i;
        i += 2;
        while (i < n - 1 && !(s[i] === 'E' && s[i + 1] === 'I' && (i + 2 >= n || /\s/.test(s[i + 2])))) i++;
        i += 2;
        tokens.push({ type: 'inline', raw: s.slice(start, i) });
        continue;
      }
    }
    if (c === '(') {
      // 字面字符串（处理转义与嵌套括号）
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === '(') depth++;
        else if (s[j] === ')') depth--;
        j++;
      }
      tokens.push({ type: 'lit', raw: s.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '<') {
      if (s[i + 1] === '<') {
        // 字典
        let depth = 1;
        let j = i + 2;
        while (j < n && depth > 0) {
          if (s[j] === '<' && s[j + 1] === '<') {
            depth++;
            j += 2;
            continue;
          }
          if (s[j] === '>' && s[j + 1] === '>') {
            depth--;
            j += 2;
            continue;
          }
          j++;
        }
        tokens.push({ type: 'dict', raw: s.slice(i, j) });
        i = j;
        continue;
      }
      // 十六进制字符串
      let j = i + 1;
      while (j < n && s[j] !== '>') j++;
      j = Math.min(j + 1, n);
      tokens.push({ type: 'hex', raw: s.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '[') {
      // 数组（可能含字符串/数字/十六进制字符串）
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        const ch = s[j];
        if (ch === '(') {
          let d2 = 1;
          j++;
          while (j < n && d2 > 0) {
            if (s[j] === '\\') {
              j += 2;
              continue;
            }
            if (s[j] === '(') d2++;
            else if (s[j] === ')') d2--;
            j++;
          }
          continue;
        }
        if (ch === '<') {
          let k = j + 1;
          while (k < n && s[k] !== '>') k++;
          j = k;
          continue;
        }
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        j++;
      }
      tokens.push({ type: 'arr', raw: s.slice(i, j) });
      i = j;
      continue;
    }
    // 名字 / 数字 / 操作符（/ 不作为分隔符，名字以 / 开头）
    let j = i;
    while (j < n && !/[\s()<>\[\]{}%]/.test(s[j])) j++;
    tokens.push({ type: 'atom', raw: s.slice(i, j) });
    i = j;
  }
  // 分组：数字/名字/字符串/数组/字典/十六进制串 是操作数；其余 atom 是操作符
  const isNum = (raw) => /^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw);
  const ops = [];
  let operands = [];
  const pushOp = (extra) => {
    if (operands.length) {
      ops.push({ op: null, operands });
      operands = [];
    }
    if (extra) ops.push(extra);
  };
  for (const t of tokens) {
    if (t.type === 'inline') {
      pushOp({ op: null, inline: t.raw });
      continue;
    }
    if (t.type === 'atom' && !t.raw.startsWith('/') && !isNum(t.raw)) {
      ops.push({ op: t.raw, operands });
      operands = [];
    } else {
      operands.push(t);
    }
  }
  pushOp();
  return ops;
}

function parseNum(tok) {
  const v = parseFloat(tok && tok.raw);
  return Number.isFinite(v) ? v : 0;
}

function parseName(tok) {
  const r = tok && tok.raw ? tok.raw : '';
  return r.startsWith('/') ? r.slice(1) : r;
}

/** 字面字符串 (…) 的字形数：按字符计数（单字节编码），处理转义与八进制 */
function litGlyphCount(litTok) {
  const raw = litTok.raw;
  let n = 0;
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] === '\\') {
      i++;
      if (i >= raw.length - 1) break;
      if (raw[i] === '\n' || raw[i] === '\r') continue; // 行继续：无字形
      if (raw[i] >= '0' && raw[i] <= '7') {
        // 八进制转义 \ddd：最多 3 位
        let k = 0;
        while (k < 2 && i + 1 < raw.length - 1 && raw[i + 1] >= '0' && raw[i + 1] <= '7') {
          i++;
          k++;
        }
      }
      n++;
      continue;
    }
    n++;
  }
  return n;
}

/** 字符串操作数（字面量或十六进制串）的字形数；twoByte=true 表示 2 字节字形码 */
function stringGlyphCount(tok, twoByte) {
  if (!tok) return 0;
  if (tok.type === 'hex') {
    const body = tok.raw.slice(1, -1).replace(/\s+/g, '');
    return twoByte ? body.length / 4 : body.length / 2;
  }
  if (tok.type === 'lit') return litGlyphCount(tok);
  return 0;
}

function arrGlyphCount(arrTok, twoByte) {
  let count = 0;
  const body = arrTok.raw.slice(1, -1);
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '<') {
      let j = body.indexOf('>', i);
      if (j < 0) break;
      const hex = body.slice(i + 1, j).replace(/\s+/g, '');
      count += twoByte ? hex.length / 4 : hex.length / 2;
      i = j + 1;
    } else if (c === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < body.length && depth > 0) {
        if (body[j] === '\\') {
          j += 2;
          continue;
        }
        if (body[j] === '(') depth++;
        else if (body[j] === ')') depth--;
        j++;
      }
      count += litGlyphCount({ raw: body.slice(i, j) });
      i = j;
    } else {
      i++;
    }
  }
  return count;
}

/**
 * 分析内容流：返回文字绘制指令及其位置（用户空间坐标）
 * @param {Array} ops tokenize 的结果
 * @param {(fontName:string)=>number} [bytesOf] 字体资源名 -> 每字形字节数（1 或 2），默认 1
 */
export function findTextRuns(ops, bytesOf) {
  const runs = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let textOn = false;
  let size = 12;
  let fontName = '';
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let leading = 0;

  const twoByte = () => (bytesOf ? bytesOf(fontName) : 1) === 2;

  const mul = (m1, m2) => [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];

  const addRun = (glyphCount, opRef) => {
    if (!glyphCount || !opRef) return;
    // 仅处理无旋转文本（文本矩阵与 CTM 无剪切/旋转）
    if (Math.abs(tm[1]) > 0.001 || Math.abs(tm[2]) > 0.001) return;
    if (Math.abs(ctm[1]) > 0.001 || Math.abs(ctm[2]) > 0.001) return;
    const x = ctm[0] * tm[4] + ctm[2] * tm[5] + ctm[4];
    const y = ctm[1] * tm[4] + ctm[3] * tm[5] + ctm[5];
    runs.push({ opRef, x, y, size: size * Math.abs(tm[0]) * Math.abs(ctm[0]), glyphCount });
  };

  for (const o of ops) {
    if (!o.op) continue;
    const a = o.operands;
    switch (o.op) {
      case 'q':
        stack.push(ctm.slice());
        break;
      case 'Q':
        if (stack.length) ctm = stack.pop();
        break;
      case 'cm':
        if (a.length >= 6) {
          ctm = mul(ctm, [parseNum(a[0]), parseNum(a[1]), parseNum(a[2]), parseNum(a[3]), parseNum(a[4]), parseNum(a[5])]);
        }
        break;
      case 'BT':
        textOn = true;
        // 按规范：BT 重置文本矩阵与文本行矩阵（块间位置由 CTM 的 cm 平移承载）
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
        break;
      case 'ET':
        textOn = false;
        break;
      case 'Tf':
        size = a.length >= 2 ? parseNum(a[1]) : 12;
        fontName = a.length >= 1 ? parseName(a[0]) : '';
        break;
      case 'Tm':
        if (a.length >= 6) {
          tm = [parseNum(a[0]), parseNum(a[1]), parseNum(a[2]), parseNum(a[3]), parseNum(a[4]), parseNum(a[5])];
          tlm = tm.slice();
        }
        break;
      case 'Td':
      case 'TD': {
        const tx = parseNum(a[0]);
        const ty = parseNum(a[1]);
        tlm = mul(tlm, [1, 0, 0, 1, tx, ty]);
        tm = tlm.slice();
        if (o.op === 'TD' && a.length >= 2) leading = -ty;
        break;
      }
      case 'T*':
        tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]);
        tm = tlm.slice();
        break;
      case "'":
        tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]);
        tm = tlm.slice();
        if (textOn && a.length >= 1) addRun(stringGlyphCount(a[0], twoByte()), o);
        break;
      case '"':
        if (a.length >= 3) leading = -parseNum(a[2]);
        tlm = mul(tlm, [1, 0, 0, 1, parseNum(a[0]), parseNum(a[1])]);
        tm = tlm.slice();
        if (textOn && a.length >= 4) addRun(stringGlyphCount(a[3], twoByte()), o);
        break;
      case 'Tj':
        if (textOn && a.length >= 1) addRun(stringGlyphCount(a[0], twoByte()), o);
        break;
      case 'TJ':
        if (textOn && a.length >= 1) addRun(arrGlyphCount(a[0], twoByte()), o);
        break;
    }
  }
  return runs;
}

/**
 * 收集落在矩形内且字形数吻合的文字绘制指令（不做字形数校验）
 * @param {Array} runs findTextRuns 的结果
 * @param {{x0:number,x1:number,y0:number,y1:number}} rect 用户空间矩形
 * @returns {{ marked:Set, matched:number }} 匹配到的指令集合与字形总数
 */
export function collectRunsInRect(runs, rect) {
  const marked = new Set();
  let matched = 0;
  for (const r of runs) {
    if (r.x >= rect.x0 && r.x <= rect.x1 && r.y >= rect.y0 && r.y <= rect.y1) {
      marked.add(r.opRef);
      matched += r.glyphCount;
    }
  }
  return { marked, matched };
}

/**
 * 标记落在矩形内的文字绘制指令；字形数不吻合时返回 null（不删除）
 * @param {Array} runs findTextRuns 的结果
 * @param {{x0:number,x1:number,y0:number,y1:number}} rect 用户空间矩形
 * @param {number} expectGlyphs 期望的总字形数（-1 表示不校验）
 * @returns {{ marked:Set, matched:number }|null} 匹配到的指令集合与字形总数
 */
export function markRunsInRect(runs, rect, expectGlyphs) {
  const { marked, matched } = collectRunsInRect(runs, rect);
  if (expectGlyphs >= 0 && Math.abs(matched - expectGlyphs) > 3) return null; // 校验失败：不删除（容差 3 字形）
  return { marked, matched };
}

/** 重建内容流：被标记的 Tj/TJ 替换为空操作 "0 0 Td" */
export function serializeOps(ops, marked) {
  const parts = [];
  for (const o of ops) {
    if (o.inline) {
      parts.push(o.inline);
      continue;
    }
    if (o.op === null) continue;
    if (marked.has(o)) {
      parts.push('0 0 Td');
      continue;
    }
    for (const opnd of o.operands) parts.push(opnd.raw);
    parts.push(o.op);
  }
  return parts.join('\n');
}
