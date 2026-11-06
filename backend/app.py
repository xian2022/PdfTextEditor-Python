# -*- coding: utf-8 -*-
"""PDF 编辑器本地后端服务。

用法（在 backend 目录）：
    ./.venv/bin/python app.py            # 默认端口 8765
    PORT=9000 ./.venv/bin/python app.py

接口：
    GET  /api/health       健康检查 + 字体索引概览
    GET  /api/fonts        字体索引（名称 -> 文件）
    POST /api/export       导出：{pdf: base64, ops: {fonts, texts, deletes}}
                           返回 {pdf: base64, report: [...]}
    GET  /                 托管前端构建产物 ../dist（不存在时提示先构建）
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
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdf_ops import PdfBackend  # noqa: E402

PORT = int(os.environ.get("PORT", "8765"))
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
    ".map": "application/json",
}


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
        path = urlparse(self.path).path
        try:
            if path == "/api/health":
                fonts = {k: str(v) for k, v in backend.font_index.items()}
                self._send_json({"ok": True, "fonts_count": len(fonts), "fonts": fonts})
                return
            if path == "/api/fonts":
                fonts = {k: v.name for k, v in backend.font_index.items()}
                self._send_json({"fonts": fonts})
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
            self._send_json({"error": f"未知接口 {path}"}, 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._send_json({"error": str(e)}, 500)

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
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"PDF 编辑器后端已启动: http://127.0.0.1:{PORT}")
    print(f"字体索引: {len(backend.font_index)} 个字体文件")
    print(f"前端目录: {DIST_DIR} {'（已构建）' if DIST_DIR.is_dir() else '（未构建，仅提供 API）'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
