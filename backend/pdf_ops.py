# -*- coding: utf-8 -*-
"""PDF 编辑后端核心（PyMuPDF 渲染/写入 + fontTools 字体子集）。

坐标约定（与前端标注格式一致）：
  x     距页面左边（pt）
  y     距页面顶部（pt，原点左上角，y 向下增长）
  文本框 h 为排版高度，首行基线 ≈ y + 0.88 * fontSize
"""
from __future__ import annotations

import base64
import hashlib
import io
import re
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import pymupdf
from fontTools import subset as ft_subset
from fontTools.ttLib import TTFont

# 字体搜索目录：项目内置字体库 + 用户安装字体目录（用户目录优先）
REPO_FONT_DIR = Path(__file__).resolve().parent.parent / "public" / "fonts-library"
USER_FONT_DIR = Path.home() / "Library" / "Application Support" / "PDFTextEditor" / "fonts"
DEFAULT_FONT_DIRS: List[Path] = [USER_FONT_DIR, REPO_FONT_DIR]

FONT_ALIASES: Dict[str, List[str]] = {
    "kaiti": ["kaiti", "楷体", "simkai"],
    "楷体": ["kaiti", "楷体", "simkai"],
    "simkai": ["kaiti", "楷体", "simkai"],
    "simsun": ["simsun", "宋体", "songti"],
    "宋体": ["simsun", "宋体", "songti"],
    "songti": ["simsun", "宋体"],
    "simhei": ["simhei", "黑体", "heiti"],
    "黑体": ["simhei", "黑体"],
    "fangsong": ["fangsong", "仿宋", "fang song"],
    "仿宋": ["fangsong", "仿宋"],
    "msyh": ["msyh", "微软雅黑", "microsoft yahei"],
    "微软雅黑": ["msyh", "微软雅黑"],
    "microsoft yahei": ["msyh", "微软雅黑"],
}


# 字体回退链：主字体缺字时按此顺序找覆盖字体（按名称解析，找不到就跳过）
FALLBACK_FONT_NAMES: List[str] = [
    "微软雅黑", "msyh", "simsun", "宋体", "黑体", "simhei",
    "楷体", "kaiti", "fangsong", "仿宋",
]


class FontNotFoundError(Exception):
    pass


def _normalize(name: str) -> str:
    return name.strip().lower().replace(" ", "")


def build_font_index(font_dirs: Sequence[Path]) -> Dict[str, Path]:
    """扫描字体目录，构建 {规范化文件名: 路径} 索引（先入为主，前面的目录优先）。"""
    index: Dict[str, Path] = {}
    for d in font_dirs:
        if not d.is_dir():
            continue
        for p in sorted(d.iterdir()):
            if p.suffix.lower() not in (".ttf", ".otf", ".ttc"):
                continue
            index.setdefault(_normalize(p.stem), p)
    return index


def font_cmap(font_bytes: bytes) -> Dict[int, str]:
    """字体 cmap：{码点: 字形名}（TTC 取第一个 face）。"""
    f = TTFont(io.BytesIO(font_bytes), fontNumber=0, lazy=True)
    try:
        return f.getBestCmap()
    finally:
        f.close()


def subset_font_bytes(font_bytes: bytes, chars: str) -> bytes:
    """fontTools 子集化：只保留 chars 中用到的字形，输出完整可嵌入的字体程序。"""
    if not chars:
        return bytes(font_bytes)
    f = TTFont(io.BytesIO(font_bytes), fontNumber=0)
    options = ft_subset.Options()
    options.hinting = False  # 去掉 hint，减小体积
    options.notdef_outline = True
    options.name_IDs = [1, 2, 4, 6]  # 保留字体名，便于调试
    sub = ft_subset.Subsetter(options)
    sub.populate(text="".join(set(chars)))
    sub.subset(f)
    buf = io.BytesIO()
    f.save(buf)
    f.close()
    return buf.getvalue()


def parse_color(color) -> Tuple[float, float, float]:
    """接受 '#rrggbb' 字符串或 (r,g,b) 0~1 元组，返回 0~1 元组。"""
    if isinstance(color, str):
        m = re.fullmatch(r"#?([0-9a-fA-F]{6})", color)
        if not m:
            raise ValueError(f"无法解析颜色: {color!r}")
        v = int(m.group(1), 16)
        return ((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255
    if isinstance(color, (list, tuple)) and len(color) == 3:
        return float(color[0]), float(color[1]), float(color[2])
    raise ValueError(f"无法解析颜色: {color!r}")


class PdfBackend:
    def __init__(self, font_dirs: Optional[Sequence[Path]] = None,
                 font_index: Optional[Dict[str, Path]] = None):
        self.font_dirs = [Path(d) for d in (font_dirs or DEFAULT_FONT_DIRS)]
        self.font_index = font_index or build_font_index(self.font_dirs)
        self._subset_cache: Dict[Tuple[str, str], bytes] = {}

    # ---------- 字体 ----------
    def find_font(self, name: str) -> Path:
        key = _normalize(str(name))
        # 精确文件名匹配优先（避免别名抢占，如「黑体」被 simhei 抢先）
        if key in self.font_index:
            return self.font_index[key]
        for cand in FONT_ALIASES.get(key, []):
            if cand in self.font_index:
                return self.font_index[cand]
        p = Path(str(name))
        if p.is_file() and p.suffix.lower() in (".ttf", ".otf", ".ttc"):
            return p
        raise FontNotFoundError(
            f"找不到字体「{name}」，已搜索: {', '.join(str(d) for d in self.font_dirs)}")

    def _font_resource_name(self, font_bytes: bytes) -> str:
        digest = hashlib.md5(font_bytes).hexdigest()[:6].upper()
        return f"F{digest}"

    def _subset_for(self, font_bytes: bytes, chars: str) -> bytes:
        key = (hashlib.md5(font_bytes).hexdigest(), "".join(sorted(set(chars))))
        if key not in self._subset_cache:
            self._subset_cache[key] = subset_font_bytes(font_bytes, chars)
        return self._subset_cache[key]

    # ---------- 文档 ----------
    @staticmethod
    def open(data: bytes) -> "pymupdf.Document":
        return pymupdf.open(stream=bytes(data), filetype="pdf")

    @staticmethod
    def export(doc: "pymupdf.Document") -> bytes:
        return doc.tobytes(garbage=4, deflate=True, clean=True)

    def delete_rects(self, page: "pymupdf.Page",
                     rects: Sequence[Tuple[float, float, float, float]]) -> Tuple[bool, bool]:
        """真删除矩形区域内的文字（保留图片与表格线，不填充背景）。

        rects: [(x, y_top, w, h), ...]
        返回 (had_text, still_has_text)：删除前矩形内是否有可提取文字、删除后是否仍有残留。
        """
        valid: List[pymupdf.Rect] = []
        for x, y, w, h in rects:
            if w <= 0 or h <= 0:
                continue
            r = pymupdf.Rect(x, y, x + w, y + h)
            r.intersect(page.rect)
            if r.is_empty:
                continue
            valid.append(r)
        if not valid:
            return False, False
        had = sum(len(page.get_text("words", clip=r)) for r in valid) > 0
        for r in valid:
            page.add_redact_annot(r, fill=None)  # 不填充：照片/彩色背景原样保留
        page.apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_NONE,
            graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
        )
        still = sum(len(page.get_text("words", clip=r)) for r in valid) > 0
        return had, still

    def write_text(self, page: "pymupdf.Page", x: float, y_top: float, text: str,
                   fontname: str, font_bytes: bytes, size: float,
                   color: Tuple[float, float, float] = (0, 0, 0),
                   bold: bool = False, italic: bool = False,
                   italic_left: bool = False,
                   underline: bool = False) -> Dict:
        """在 (x, y_top) 写入一行文字（fontname 需已 insert_font 注册到该页）。"""
        if not text:
            return {"bbox": [x, y_top, x, y_top]}
        baseline = y_top + size * 0.88

        def draw(xx: float, yy: float):
            kwargs = dict(fontsize=size, fontname=fontname, color=color, overlay=True)
            if italic:
                # 伪斜体：以基线起点为固定点做水平剪切。
                # 实测（渲染验证）：Matrix(1,0,+0.23,1,0,0) 向右斜（常规斜体），
                # Matrix(1,0,-0.23,1,0,0) 向左斜。
                shear = -0.23 if italic_left else 0.23
                kwargs["morph"] = (pymupdf.Point(xx, yy), pymupdf.Matrix(1, 0, shear, 1, 0, 0))
            page.insert_text(pymupdf.Point(xx, yy), text, **kwargs)

        if bold:
            draw(x + size * 0.04, baseline)
        draw(x, baseline)

        width = pymupdf.Font(fontbuffer=font_bytes).text_length(text, fontsize=size)
        if underline:
            uy = baseline + size * 0.16
            page.draw_line(
                pymupdf.Point(x, uy), pymupdf.Point(x + width, uy),
                color=color, width=max(0.6, size * 0.06),
            )
        return {"bbox": [x, y_top, x + width, y_top + size * 1.25]}

    # ---------- 完整导出流程 ----------
    def build_export(self, data: bytes, ops: Dict) -> Tuple[bytes, List[Dict]]:
        """一键导出：data 为源 PDF 字节；ops 见下方结构。

        ops = {
          "deletes": [{"page": 0, "rects": [[x, y, w, h], ...],
                       "fallbackColor": "#rrggbb", "boxId": id}, ...],
          "fills":   [{"page": 0, "x": .., "y": .., "w": .., "h": ..,
                       "color": "#rrggbb", "boxId": id, "moved": bool}, ...],
          "texts":   [{"page": 0, "x": .., "y": .., "size": .., "text": ..,
                       "color": "#rrggbb" | [r,g,b], "bold": bool, "italic": bool,
                       "italicLeft": bool, "underline": bool, "fontId": "f1", "boxId": id}, ...],
          "fonts":   {"f1": {"bytes": "<base64>"}},   # 前端实际使用的字体字节
        }
        主字体缺字时按 FALLBACK_FONT_NAMES 逐字符回退；返回 (导出字节, 自检报告)。
        """
        doc = self.open(data)

        # 解析请求携带的字体
        fonts: Dict[str, bytes] = {}
        for fid, fspec in (ops.get("fonts") or {}).items():
            b64 = fspec.get("bytes", "")
            raw = base64.b64decode(b64) if b64 else None
            if raw is None and fspec.get("path"):
                raw = Path(fspec["path"]).read_bytes()
            if raw is None and fspec.get("name"):
                raw = self.find_font(fspec["name"]).read_bytes()
            if raw is None:
                raise FontNotFoundError(f"字体 {fid} 未提供字节或名称")
            fonts[fid] = raw

        texts: List[Dict] = ops.get("texts") or []
        deletes: List[Dict] = ops.get("deletes") or []

        # 多行文本（含竖向框逐字换行）按行展开：每行独立定位，行高 1.25 倍字号
        line_items: List[Dict] = []
        for t in texts:
            size = float(t.get("size", 12))
            y0 = float(t.get("y", 0))
            for li, line in enumerate(str(t.get("text", "")).split("\n")):
                if not line.strip():
                    continue  # 空行仅占行高，不绘制
                line_items.append({
                    **{k: v for k, v in t.items() if k != "text"},
                    "text": line,
                    "y": y0 + li * size * 1.25,
                })
        texts = line_items

        # 回退字体（惰性加载，缓存覆盖率）
        fallback_ids: List[str] = []
        fallback_cover: Dict[str, Dict[int, str]] = {}
        for fname in FALLBACK_FONT_NAMES:
            if fname in fallback_ids:
                continue
            try:
                fb = self.find_font(fname).read_bytes()
            except FontNotFoundError:
                continue
            fid = f"__fb_{_normalize(fname)}"
            fonts.setdefault(fid, fb)
            fallback_ids.append(fid)
            fallback_cover[fid] = font_cmap(fb)

        # 各字体覆盖率
        cover: Dict[str, Dict[int, str]] = {
            fid: font_cmap(fb) for fid, fb in fonts.items()
        }

        def choose_font(fid: str, ch: str) -> Optional[str]:
            if ord(ch) in cover[fid]:
                return fid
            for fb_id in fallback_ids:
                if ord(ch) in fallback_cover[fb_id]:
                    return fb_id
            # 其他请求字体兜底
            for other, cm in cover.items():
                if ord(ch) in cm:
                    return other
            return None

        # 逐字符拆分 run：[(fontId, run_text)]
        dropped: List[Dict] = []
        run_texts: List[Dict] = []  # 与 texts 同构，text 已按字体切 run
        for item_idx, t in enumerate(texts):
            fid = t.get("fontId")
            if fid not in fonts:
                raise FontNotFoundError(f"text 引用了未知 fontId: {fid}")
            runs: List[Tuple[str, str]] = []
            cur_fid, cur_buf = None, []
            for ch in t.get("text", ""):
                if ch == "\n":
                    continue
                target = choose_font(fid, ch)
                if target is None:
                    dropped.append({"text": t.get("text", "")[:20], "char": ch,
                                    "codepoint": f"U+{ord(ch):04X}"})
                    continue
                if target != cur_fid:
                    if cur_buf:
                        runs.append((cur_fid, "".join(cur_buf)))
                    cur_fid, cur_buf = target, []
                cur_buf.append(ch)
            if cur_buf:
                runs.append((cur_fid, "".join(cur_buf)))
            for rfid, rtext in runs:
                run_texts.append({**{k: v for k, v in t.items() if k != "text"},
                                  "fontId": rfid, "text": rtext,
                                  "_item_id": item_idx})

        # 子集化：按 (fontId, 用到的字符) 缓存
        chars_by_font: Dict[str, set] = {}
        for t in run_texts:
            chars_by_font.setdefault(t["fontId"], set()).update(t["text"])
        prepared: Dict[str, Tuple[str, bytes]] = {}
        for fid, chars in chars_by_font.items():
            sub = self._subset_for(fonts[fid], "".join(chars))
            prepared[fid] = (self._font_resource_name(sub), sub)

        # 删除原文：真删除失败（仍有文字残留）时用 fallbackColor 遮盖兜底
        deleted_ok: Dict[object, bool] = {}
        for dl in deletes:
            page = doc[int(dl.get("page", 0))]
            box_id = dl.get("boxId")
            rects = [
                [float(x), float(y), float(w), float(h)]
                for x, y, w, h in dl.get("rects") or []
                if w > 0 and h > 0
            ]
            if not rects:
                continue
            had, still = self.delete_rects(page, rects)
            deleted = not still
            if box_id is not None:
                deleted_ok[box_id] = deleted
            if had and still:
                fb = parse_color(dl.get("fallbackColor") or "#ffffff")
                for x, y, w, h in rects:
                    page.draw_rect(pymupdf.Rect(x, y, x + w, y + h),
                                   color=None, fill=fb)

        # 用户底色：原文删除成功且文本框未移动时跳过，避免覆盖照片/彩色背景
        for f in ops.get("fills") or []:
            x, y = float(f.get("x", 0)), float(f.get("y", 0))
            w, h = float(f.get("w", 0)), float(f.get("h", 0))
            if w <= 0 or h <= 0:
                continue
            box_id = f.get("boxId")
            deleted = box_id is not None and bool(deleted_ok.get(box_id, False))
            if deleted and not f.get("moved"):
                continue
            page = doc[int(f.get("page", 0))]
            page.draw_rect(pymupdf.Rect(x, y, x + w, y + h), color=None,
                           fill=parse_color(f.get("color") or "#ffffff"))

        # 写入（同页同字体注册一次；同一条目逐 run 沿 x 拼接）
        registered: Dict[Tuple[int, str], bool] = {}
        writes_info = []
        underline_items: List[Dict] = []
        x_cursor: Dict[Tuple[int, object], float] = {}  # (page, _item_id) -> 当前 x
        for t in run_texts:
            pno = int(t.get("page", 0))
            page = doc[pno]
            fid = t["fontId"]
            fontname, sub_bytes = prepared[fid]
            if (pno, fid) not in registered:
                page.insert_font(fontname=fontname, fontbuffer=sub_bytes)
                registered[(pno, fid)] = True
            key = (pno, t["_item_id"])
            if key not in x_cursor:
                x_cursor[key] = float(t.get("x", 0))
            x = x_cursor[key]
            info = self.write_text(
                page, x, float(t.get("y", 0)),
                t["text"], fontname, sub_bytes, float(t.get("size", 12)),
                color=parse_color(t.get("color", "#000000")),
                bold=bool(t.get("bold")), italic=bool(t.get("italic")),
                italic_left=bool(t.get("italicLeft")),
            )
            run_w = info["bbox"][2] - info["bbox"][0]
            # 下划线：整条文本一条线，按原始条目累计
            if t.get("underline"):
                uid = t.get("_item_id")
                if uid not in {u["_item_id"] for u in underline_items}:
                    underline_items.append({
                        "_item_id": uid, "page": pno,
                        "x0": x, "x1": x,
                        "y": float(t.get("y", 0)), "size": float(t.get("size", 12)),
                        "color": parse_color(t.get("color", "#000000")),
                    })
                for u in underline_items:
                    if u["_item_id"] == uid:
                        u["x1"] = x + run_w
                        break
            # x 前移，为同一条 text 的下一个 run 腾位置
            x_cursor[key] = x + run_w
            writes_info.append({
                "page": pno, "text": t["text"], "bbox": info["bbox"],
            })

        for u in underline_items:
            page = doc[u["page"]]
            uy = u["y"] + u["size"] * (0.88 + 0.16)
            page.draw_line(
                pymupdf.Point(u["x0"], uy), pymupdf.Point(u["x1"], uy),
                color=u["color"], width=max(0.6, u["size"] * 0.06),
            )

        out = self.export(doc)
        doc.close()

        check_doc = self.open(out)
        report = self.verify_writes(check_doc, writes_info)
        check_doc.close()
        if dropped:
            report.append({"dropped_chars": dropped})
        return out, report

    # ---------- 渲染校验 ----------
    @staticmethod
    def region_ink_ratio(pix: "pymupdf.Pixmap", rect: pymupdf.Rect, zoom: float = 2.0) -> float:
        r = rect * zoom
        r.intersect(pix.irect)
        if r.is_empty:
            return 0.0
        total = dark = 0
        for y in range(int(r.y0), int(r.y1)):
            for x in range(int(r.x0), int(r.x1)):
                i = (y * pix.width + x) * pix.n
                rgb = pix.samples[i:i + 3]
                lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
                total += 1
                if lum < 200:
                    dark += 1
        return dark / max(total, 1)

    def verify_writes(self, doc: "pymupdf.Document",
                      items: Sequence[Dict], zoom: float = 2.0) -> List[Dict]:
        report = []
        page_cache: Dict[int, pymupdf.Pixmap] = {}
        for it in items:
            pno = int(it.get("page", 0))
            text = it.get("text", "")
            x0, y0, x1, y1 = it["bbox"]  # bbox 为 (x0, y0, x1, y1)
            try:
                page = doc[pno]
                if pno not in page_cache:
                    page_cache[pno] = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
                pix = page_cache[pno]
                ink = self.region_ink_ratio(pix, pymupdf.Rect(x0, y0, x1, y1), zoom)
                extracted = page.get_text().replace("\n", "")
                sample = text[:4] if len(text) >= 4 else text
                report.append({
                    "page": pno, "text": text[:20],
                    "ink_ratio": round(ink, 4),
                    "rendered": ink > 0.002,
                    "extractable": bool(sample) and sample in extracted,
                })
            except Exception as e:  # noqa: BLE001
                report.append({"page": pno, "text": text[:20], "error": str(e)})
        return report
