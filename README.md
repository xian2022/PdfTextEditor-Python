# PDF 文本编辑器（Python 后端版）

一个轻量的 PDF 文本编辑器：**同一份代码**既能在浏览器网页里运行，也能打包成 Windows / macOS / Linux 桌面程序。导出环节全部走**本地 Python 后端（PyMuPDF）**，生成标准 PDF 结构，Chrome / Edge 打开不再出现"文字不可见"问题。

打开 PDF → 浏览 / 编辑两种模式 → 修改原文或添加新文本 → 导出新的 PDF 文件。

## 架构

```
浏览器 / Electron 前端（pdf.js 渲染预览 + 文字层交互）
        │  POST /api/export  {pdf: base64, ops: {fonts, texts, deletes, fills}}
        ▼
本地 Python 后端（PyMuPDF + fontTools）
  · 原文真删除（redaction，保留照片/彩色背景；删除失败自动回退底色遮盖）
  · 完整字体库中按所用字形子集嵌入（逐字符跨字体回退，如楷体缺 ¥ 时自动换字体）
  · 渲染自检：墨迹采样 + 文本提取 + 词条重叠检测，结果随导出报告返回
        │  返回 {pdf: base64, report: [...]}
        ▼
下载新 PDF
```

## 快速开始（本地网页版）

需要 Python 3.9+ 与 Node.js。

```bash
# 1) 后端：创建虚拟环境并安装依赖（backend/.venv 已 gitignore）
cd backend
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt

# 2) 前端：构建（自动下载内置中文字体到 public/fonts/）
cd ..
npm install
npm run build

# 3) 启动后端：托管前端产物 + 提供导出接口
cd backend && ./.venv/bin/python app.py
# 输出: PDF 编辑器后端已启动: http://127.0.0.1:8765
```

浏览器打开 <http://127.0.0.1:8765/> 即可使用。**导出 PDF 前必须保持后端运行**，否则导出会提示启动命令。

前端开发模式（HMR）：`npm run dev`（http://localhost:5173），后端保持运行即可（已开 CORS）。

## 测试

```bash
npm test
```

运行 `backend/test_http.py` 端到端回归：自启动后端（随机端口）→ 完整 /api/export 请求 → 校验文本提取、原文删除、底色绘制、跨字体同行不重叠、像素级渲染检查。全部通过输出 `总体: PASS`。

## 功能

- 打开本地 PDF（文件选择框或直接拖入窗口），多页浏览；加密 PDF 会弹窗要求输入密码
- **浏览模式**：纯查看页面（工具栏只显示打开/编辑/导出）
- **编辑模式**（Word 风格工具栏）：
  - **单击**页面上任意原文文字 → 选中（显示虚线可编辑框，直接拖动即可移动）；**双击**进入编辑（自动保留原字号、颜色，竖排文字合并为一个多行框，表格数值按列拆分）
  - **双击空白处**新建文本框（直接进入编辑）；**单击其他空白处**提交预览（不退出编辑模式）
  - 选中后拖动框身移动、右下角手柄调整大小、点右上角 ✕ 或按 Delete/Backspace 删除
  - **格式工具**：粗体（B）、斜体（I）、下划线（U）、字号、字体、颜色、底色（可选无色）；Ctrl/Cmd+C 复制、Ctrl/Cmd+V 粘贴
  - **撤销/重做**：工具栏按钮或 Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z（覆盖添加、删除、移动、缩放、文字与样式修改）
  - **临时保存**：编辑过程自动暂存（localStorage），刷新/重启后自动恢复上次未完成的编辑；点「导出 PDF」下载最终文件后清除暂存
  - 文本框内容超出框宽时自动撑宽（长文本如税号不会在框内折行）；清空内容且保留底色 = 只遮盖该处原文
  - **悬停文本框显示当前所用字体**；编辑原文时自动按原文字体名（含中英别名）匹配字体库，匹配不到时使用工具栏当前字体并在悬停提示中标出原文所用字体
- **字体扩展**：
  - 内置字体随构建配置：`npm run fetch:font /路径/到/你的字体.ttf` 使用本地字体，否则自动下载开源霞鹜文楷（OFL 协议可商用）
  - **内置字体必须是静态 .ttf（TrueType）**
  - 网页版 / 桌面版通用：点击「导入字体」选择字体文件即时加载（推荐 TTF）
  - 桌面版：点击「字体目录」按钮打开本地字体目录（系统用户数据目录下的 `fonts/`），把完整字体文件放进去即可扩展
  - `public/fonts-library/` 可放置本机字体库（已 gitignore，不提交进仓库；后端与前端共享同一目录）
- 导出：按所选字体嵌入**所用字形的子集**（字体库文件保持完整不动，输出体积小），支持任意文字颜色、粗斜体、下划线；缺字时逐字符回退到其他可用字体

## 目录结构

```
├── index.html               # 页面骨架
├── src/
│   ├── main.js              # 编辑器交互：pdf.js 渲染、文字层、文本框增删移缩放
│   ├── fonts.js             # 字体扩展：解析 TTF/OTF/WOFF 并注册预览字体
│   ├── backend-export.js    # 导出：组装 ops 并请求本地 Python 后端
│   ├── pdf-save.js          # 预览辅助：遮盖层重绘与字体加载
│   └── style.css
├── backend/
│   ├── app.py               # HTTP 服务：/api/export、/api/health、/api/fonts、托管 dist
│   ├── pdf_ops.py           # 核心：删除/底色/字体回退/子集嵌入/写入/渲染自检
│   ├── test_http.py         # 端到端回归（npm test）
│   └── requirements.txt
├── electron/
│   ├── main.cjs             # 桌面壳：窗口、app:// 协议、保存对话框、字体目录 IPC
│   └── preload.cjs
├── scripts/
│   ├── fetch-font.mjs       # 下载内置中文字体（构建前自动执行）
│   └── gen-font-manifest.mjs / copy-worker.mjs
└── .github/workflows/       # CI：桌面打包 + 网页部署
```

## 实现原理与限制

- 导出在**后端真正删除原文**（PyMuPDF redaction）：不覆盖照片与彩色背景；个别删除不彻底的字形会自动回退为底色遮盖。
- 新增文本以嵌入字体子集的形式写入，坐标与预览一致；导出前对每段新文字做渲染自检（墨迹采样 + 文本提取），失败会在导出报告中标出。
- 旋转了 90°/270° 的页面：文本框位置映射可能不准确（导出前会弹窗提醒），旋转的文本行不会被识别为可编辑原文。
- 加密 PDF 需要密码才能打开。
- 导出的 PDF 中新增文本不是「可编辑文本域」，而是固定文字。
- **桌面版（Electron）打包暂未内置后端**：当前导出来自本地 Python 服务；桌面集成方案后续迭代。网页版与开发模式完全可用。
- macOS 安装包使用临时签名（ad-hoc，无 Apple 开发者证书）：下载后首次打开请**右键 → 打开**；若提示"已损坏"，在终端执行 `xattr -cr /Applications/PDFTextEditor.app` 即可（正式分发需配置 Apple 证书与公证）。
- 发布前请把 `package.json` 里的 `author` 改成你自己的名字和邮箱（Linux deb 包需要）。

## GitHub Actions

仓库已包含两个工作流：

1. **Build Desktop**（`.github/workflows/build-desktop.yml`）：打 tag（如 `v1.0.0`）或手动触发，在 Windows / macOS / Linux 三平台上并行构建安装包并上传为 artifacts；打 tag 时还会自动创建 GitHub Release 并附带安装包。
2. **Deploy Web**（`.github/workflows/deploy-pages.yml`）：推送到 `main` 分支时自动构建并部署网页版到 GitHub Pages（需在仓库 Settings → Pages 中选择 GitHub Actions 作为来源）。注意：Pages 托管仅含前端界面，导出需要本地 Python 后端，页面会给出启动提示。

## 技术栈

[Vite](https://vitejs.dev) + [pdf.js](https://mozilla.github.io/pdf.js)（渲染与文字提取）+ [PyMuPDF](https://pymupdf.io) + [fontTools](https://fonttools.readthedocs.io)（后端写入）+ [Electron](https://www.electronjs.org) + [electron-builder](https://www.electron.build)（打包）
