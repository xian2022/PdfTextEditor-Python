# -*- coding: utf-8 -*-
"""HTTP 服务端到端测试：/api/export 完整请求。

覆盖：楷体嵌入、¥ 半角字符回退、多行文本（竖向框）、下划线、
原文真删除、用户底色（移动后绘制 / 未移动跳过）、渲染自检。
自启动后端（随机端口），无需预先运行 app.py：
    cd backend && ./.venv/bin/python test_http.py
"""
import base64
import json
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pymupdf  # noqa: E402
import app as app_module  # noqa: E402
from pdf_ops import PdfBackend  # noqa: E402

# 在随机端口自启动后端（复用 app.Handler 与全局字体索引）
_server = ThreadingHTTPServer(("127.0.0.1", 0), app_module.Handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{_server.server_address[1]}"

backend = PdfBackend()
kai_bytes = backend.find_font("Kaiti").read_bytes()

# 源 PDF：含一行将被删除的原文
src = pymupdf.open()
page = src.new_page(width=595, height=397)
page.insert_text((40, 100), "原文行：将被删除的旧金额 ¥643,592.02", fontsize=12)
src_bytes = src.tobytes()
src.close()

payload = {
    "pdf": base64.b64encode(src_bytes).decode(),
    "ops": {
        "fonts": {"k": {"bytes": base64.b64encode(kai_bytes).decode()}},
        "deletes": [
            {"page": 0, "rects": [[40, 85, 300, 20]],
             "fallbackColor": "#ffffff", "boxId": 1},
            # 无文字的空白区域删除：不应画兜底遮盖
            {"page": 0, "rects": [[300, 200, 60, 20]],
             "fallbackColor": "#ff0000", "boxId": 2},
        ],
        "fills": [
            # boxId=1 已删除且未移动：跳过填充（背景原样保留）
            {"page": 0, "x": 40, "y": 85, "w": 300, "h": 20,
             "color": "#ffff00", "boxId": 1, "moved": False},
            # boxId=1 已删除但已移动：在原位置补底色
            {"page": 0, "x": 40, "y": 150, "w": 160, "h": 20,
             "color": "#eef3fb", "boxId": 1, "moved": True},
            # 无删除记录的独立底色（双击新建的框）
            {"page": 0, "x": 40, "y": 330, "w": 180, "h": 20,
             "color": "#fdf3d8", "boxId": 3, "moved": True},
        ],
        "texts": [
            {"page": 0, "x": 40, "y": 100, "size": 12,
             "text": "楷体渲染测试：陕西众邦达源再生资源利用有限公司",
             "color": "#333333", "fontId": "k", "boxId": 1},
            # 多行（竖向框逐字换行）+ 下划线 + ¥ 回退字符
            {"page": 0, "x": 40, "y": 150, "size": 12,
             "text": "¥\n6\n4\n3\n,\n5\n9\n2", "color": "#cc1414",
             "fontId": "k", "underline": True, "boxId": 1},
            {"page": 0, "x": 40, "y": 330, "size": 12,
             "text": "带底色文本", "color": "#000000", "fontId": "k", "boxId": 3},
            # 同一行内跨字体 run（¥ 回退）：验证 x 前进不重叠
            {"page": 0, "x": 40, "y": 300, "size": 12,
             "text": "总价 ¥643,592.02 元", "color": "#000000",
             "fontId": "k", "boxId": 4},
        ],
    },
}
req = urllib.request.Request(
    f"{BASE}/api/export",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=60) as resp:
    result = json.loads(resp.read().decode("utf-8"))

print("导出大小:", result.get("size"), "bytes")
ok = True
for r in result.get("report", []):
    print("  ", r)
    if r.get("rendered") is False or r.get("extractable") is False:
        ok = False

out = base64.b64decode(result["pdf"])
Path("/tmp/http-export.pdf").write_bytes(out)
d = backend.open(out)
text = d[0].get_text()
print("文本提取:", repr(text))

checks = {
    "新文字写入": "楷体渲染测试" in text,
    "原文已删除": "旧金额" not in text,
    "竖向逐字换行": "¥" in text and "6" in text and "9" in text,
    "独立底色文本": "带底色文本" in text,
    "跨字体同行": "总价" in text and "元" in text,
}
for name, passed in checks.items():
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
    ok = ok and passed

# 词条重叠检测：同一行内不同词条的 bbox 不应重叠（防止跨字体 run 的 x 不前进）
words = d[0].get_text("words")
for i in range(len(words)):
    for j in range(i + 1, len(words)):
        a, b = words[i], words[j]
        if not (a[4].strip() and b[4].strip()):
            continue
        if a[:4] == b[:4]:
            continue  # 完全相同的词条（粗体叠画等）不算重叠
        y_overlap = max(a[1], b[1]) < min(a[3], b[3])
        x_overlap = max(a[0], b[0]) < min(a[2], b[2])
        if y_overlap and x_overlap:
            print(f"  [FAIL] 词条重叠: {a[4]!r} {[round(v, 1) for v in a[:4]]}"
                  f" <-> {b[4]!r} {[round(v, 1) for v in b[:4]]}")
            ok = False

# 视觉检查：底色矩形是否按预期绘制
pix = d[0].get_pixmap(matrix=pymupdf.Matrix(2, 2))
pix.save("/tmp/http-export.png")
c_moved = pix.pixel(50 * 2, 155 * 2)      # 移动后底色 #eef3fb
c_indep = pix.pixel(150 * 2, 335 * 2)     # 独立底色 #fdf3d8（避开文字笔画）
c_skip = pix.pixel(50 * 2, 90 * 2)        # 未移动：应接近白色背景（无 #ffff00）
print("  像素检查 移动底色:", c_moved, " 独立底色:", c_indep, " 未移动区域:", c_skip)
if not (c_moved[0] > 200 and c_moved[1] > 200 and c_moved[2] > 200 and
        c_indep[0] > 200 and c_indep[1] > 200 and c_indep[2] > 200):
    ok = False
if c_skip[0] < 200 or c_skip[2] < 200:  # 若出现黄色(#ffff00)说明误填充
    ok = False

print("渲染图: /tmp/http-export.png")
print("总体:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
