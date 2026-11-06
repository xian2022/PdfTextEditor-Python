# -*- coding: utf-8 -*-
"""PDF 编辑器本地后端服务。

用法（在 backend 目录）：
    ./.venv/bin/python app.py            # 默认端口 8765，被占用时自动向后探测
    PORT=9000 ./.venv/bin/python app.py

接口：
    GET  /api/health          健康检查 + 字体索引概览
    GET  /api/fonts           字体索引（名称 -> 文件）
    POST /api/fonts           导入字体：{name, data: base64} 写入用户字体目录
    GET  /fonts-library/<名>  按文件名读取字体（用户目录优先，其次内置字体库）
    POST /api/export          导出：{pdf: base64, ops: {fonts, texts, deletes}}
                              返回 {pdf: base64, report: [...]}
    GET  /                    托管前端构建产物 ../dist（不存在时提示先构建）
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdf_ops import (  # noqa: E402
    DEFAULT_FONT_DIRS,
    REPO_FONT_DIR,
    USER_FONT_DIR,
    PdfBackend,
    build_font_index,
    validate_font_bytes,
)

PORT = int(os.environ.get("PORT", "8765"))
MAX_PORT_TRIES = 50  # 端口被占用时向后递增探测的次数
DIST_DIR = Path(__file__).resolve().parent.parent / "dist"
MAX_BODY = 512 * 1024 * 1024  # 512MB（字体 base64 可能较大）

backend = PdfBackend()

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".ttc": "font/collection",
    ".map": "application/json",
}

FONT_SUFFIXES = (".ttf", ".otf", ".ttc", ".woff", ".woff2")
# 字体文件读取目录：用户导入目录优先，其次随项目分发的字体库
FONT_SERVE_DIRS = [USER_FONT_DIR, REPO_FONT_DIR]


def cors(handler: BaseHTTPRequestHandler):
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")


class Handler(BaseHTTPRequestHandler):
    server_version = "PdfEditorBackend/1.0"

    def log_message(self, fmt, *args):  # 精简日志
        sys.stderr.write("[%s] %s\n" % (self.address_string(), fmt % args))

    # ---------- 通用 ----------
    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        cors(self)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ValueError("空请求体")
        if length > MAX_BODY:
            raise ValueError(f"请求体过大（{length} 字节，上限 {MAX_BODY}）")
        return self.rfile.read(length)

    def do_OPTIONS(self):
        self.send_response(204)
        cors(self)
        self.end_headers()

    # ---------- 路由 ----------
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/api/health":
                fonts = {k: str(v) for k, v in backend.font_index.items()}
                self._send_json({"ok": True, "fonts_count": len(fonts), "fonts": fonts})
                return
            if path == "/api/fonts":
                fonts = {k: v.name for k, v in backend.font_index.items()}
                self._send_json({"fonts": fonts})
                return
            if path.startswith("/fonts-library/"):
                self._serve_font(path[len("/fonts-library/"):])
                return
            self._serve_static(path)
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": str(e)}, 500)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self._read_body()
            payload = json.loads(body.decode("utf-8"))
            if path == "/api/export":
                pdf_b64 = payload.get("pdf") or ""
                if not pdf_b64:
                    self._send_json({"error": "缺少 pdf 字段（base64）"}, 400)
                    return
                src = base64.b64decode(pdf_b64)
                ops = payload.get("ops") or {}
                out, report = backend.build_export(src, ops)
                self._send_json({
                    "pdf": base64.b64encode(out).decode(),
                    "size": len(out),
                    "report": report,
                })
                return
            if path == "/api/fonts":
                self._save_font(payload)
                return
            self._send_json({"error": f"未知接口 {path}"}, 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._send_json({"error": str(e)}, 500)

    # ---------- 字体 ----------
    def _save_font(self, payload):
        """导入字体：写入用户字体目录（持久化），并刷新后端字体索引。"""
        name = str(payload.get("name") or "").strip()
        data_b64 = payload.get("data") or ""
        if not name or not data_b64:
            self._send_json({"error": "缺少 name 或 data 字段"}, 400)
            return
        stem = Path(name).name  # 只取文件名，防目录穿越
        if Path(stem).suffix.lower() not in FONT_SUFFIXES:
            self._send_json(
                {"error": f"不支持的字体格式：{stem}（支持 .ttf/.otf/.ttc/.woff/.woff2）"}, 400
            )
            return
        try:
            data = base64.b64decode(data_b64)
        except Exception:  # noqa: BLE001
            self._send_json({"error": "字体数据 base64 解码失败"}, 400)
            return
        if not data:
            self._send_json({"error": "字体数据为空"}, 400)
            return
        # 安全校验：fontTools 能解析且带 cmap 才视为可用，避免把损坏/伪造文件写入字体目录
        invalid = validate_font_bytes(data)
        if invalid:
            self._send_json({"error": f"字体文件不可用：{invalid}"}, 400)
            return
        USER_FONT_DIR.mkdir(parents=True, exist_ok=True)
        dest = USER_FONT_DIR / stem
        dest.write_bytes(data)
        backend.font_index = build_font_index(DEFAULT_FONT_DIRS)  # 重新扫描索引
        self._send_json({"ok": True, "saved": stem, "fonts_count": len(backend.font_index)})

    def _serve_font(self, name: str):
        """按文件名从字体目录读取字体文件（用户目录优先，其次内置字体库）。"""
        stem = Path(name).name
        if Path(stem).suffix.lower() not in FONT_SUFFIXES:
            self._send_json({"error": f"非法字体路径 {name}"}, 400)
            return
        for d in FONT_SERVE_DIRS:
            cand = d / stem
            if cand.is_file():
                data = cand.read_bytes()
                ctype = MIME.get(cand.suffix.lower(), "application/octet-stream")
                self.send_response(200)
                cors(self)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        self._send_json({"error": f"字体文件不存在：{stem}"}, 404)

    # ---------- 静态文件 ----------
    def _serve_static(self, path: str):
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/")
        candidate = (DIST_DIR / rel).resolve()
        # 防目录穿越
        if not str(candidate).startswith(str(DIST_DIR.resolve())):
            self._send_json({"error": "非法路径"}, 403)
            return
        if not candidate.is_file():
            if rel == "index.html":
                self._send_json(
                    {"error": "前端未构建：请先在项目根目录执行 npm run build（生成 dist/）"},
                    404,
                )
                return
            self._send_json({"error": f"未找到 {path}"}, 404)
            return
        data = candidate.read_bytes()
        ctype = MIME.get(candidate.suffix.lower()) or mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        self.send_response(200)
        cors(self)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    # 端口被占用时自动向后探测（8765 → 8766 → …），最多试 MAX_PORT_TRIES 次
    port = PORT
    srv = None
    for _ in range(MAX_PORT_TRIES):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            print(f"端口 {port} 被占用，尝试 {port + 1} …", flush=True)
            port += 1
    if srv is None:
        print(f"错误：从 {PORT} 起连续 {MAX_PORT_TRIES} 个端口都被占用，启动失败", flush=True)
        sys.exit(1)
    print(f"PDF 编辑器后端已启动: http://127.0.0.1:{port}", flush=True)
    if port != PORT:
        print(f"（默认端口 {PORT} 被占用，已自动改用 {port}；前端页面与接口同端口，无需额外配置）", flush=True)
    print(f"字体索引: {len(backend.font_index)} 个字体文件", flush=True)
    print(f"前端目录: {DIST_DIR} {'（已构建）' if DIST_DIR.is_dir() else '（未构建，仅提供 API）'}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
