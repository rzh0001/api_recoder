# API Recorder

本地运行的 **API 录制 / 抓包 / Mock 一体化桌面工具**（Windows）。

API Recorder 通过驱动浏览器实时抓取请求与响应，按域名组织成树，支持全字段检索、按需编辑造数据、一键导出 HAR/JSON，并能把录制结果直接起一个进程内 Mock 服务供被测程序对接。

## 核心功能

- **录制抓包**：基于 DrissionPage 驱动浏览器，实时抓取所有请求/响应，按域名分组展示。
- **全字段过滤**：搜索覆盖 URL、域名、请求头、请求体、响应头、响应体、Query、备注、标签、字段注释；多个值用 `|` 或换行分隔表示「或」；可勾选「忽略请求头」避开 `Authorization`/`Cookie` 干扰；命中文本高亮。
- **复制与编辑**：详情页一键复制请求地址；可编辑 URL / 请求头 / 请求体，编辑后自动重算域名/路径/Query，便于造测试数据。
- **标记 / 标签**：每条请求可打标签（标记区精简为标签输入），Mock 接口列表同步显示接口标记。
- **Mock 服务**：把录制结果作为快照起一个独立端口的 Mock 服务；录制与 Mock 互斥（Mock 运行时冻结录制库）。
- **导入 / 导出**：支持打开 / 导入 HAR、JSON；「保存」直接覆盖原文件（导入单文件时记录来源路径）。
- **搜索历史**：本地保存最近 12 条搜索词，可一键复用、删除或清空。

## 技术栈

- 后端：Python + Flask + flask-sock（WebSocket 实时推送）
- 前端：原生 HTML / CSS / JS（WebView2 内核渲染控制面板）
- 抓包：DrissionPage（驱动 Chromium）
- 打包：PyInstaller `--onedir`（Win7 绿色文件夹形态）

## 快速开始（开发模式）

```bash
pip install -r requirements.txt
python main.py
```

启动后弹出控制面板窗口，点「开始录制」拉起浏览器即可抓包。

## 打包发布（Win7 绿色文件夹）

目标系统：**Windows 7 x64（SP1）**。受 Win7 兼容性硬约束，必须在 **Python 3.8** 环境下构建：

```bash
# 1) 用 Python 3.8 冻结
C:\api_recorder_build\python38\python.exe packaging\build.py

# 2) 组装外部运行时（WebView2 109 / Supermium / VC++ 2015-2019 / UCRT）
python packaging\assemble.py
```

最终产物位于 `C:\api_recorder_build\dist\API_Recorder`，双击 `API_Recorder.exe` 即可运行。

> 外部运行时（WebView2 109 固定版、Supermium、Visual C++ 2015-2019、UCRT 兜底 DLL）需自行准备并放入 `C:\api_recorder_build\` 对应目录，详见 `packaging/assemble.py` 顶部常量与注释。

## 自动化发布

推送 `v*` 标签（如 `v1.0.0`）会触发 GitHub Actions 自动构建并发布 Release（见 `.github/workflows/release.yml`）：

```bash
git tag v1.0.0
git push origin v1.0.0
```

工作流在 Windows  runner 上用 Python 3.8 执行 PyInstaller，把 `API_Recorder` 文件夹打包为 `API_Recorder-<tag>-win64.zip` 并作为 Release 资产上传。

> 说明：当前工作流发布的是**核心 onedir 包**；完整「开箱即用」的 Win7 绿色文件夹还需在本地执行 `packaging/assemble.py` 补上 WebView2 109 / Supermium / VC++ 等运行时（这些大体积二进制不进仓库，由本地准备）。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `app/` | 后端：Flask 服务、录制存储、Mock 管理 |
| `static/` | 前端：HTML / CSS / JS 控制面板 |
| `main.py` | 入口：pywebview 窗口 + 原生文件对话框 |
| `packaging/` | 构建（`build.py`）与组装（`assemble.py`）脚本 |
| `tests/` | 测试 |

## 已知限制

- 控制面板 UI 内核为 WebView2 109（最后一个支持 Win7 的版本），随包固定，不依赖系统已装 WebView2。
- 抓包浏览器捆绑 Supermium（专支持 Win7/8/8.1 的 Chromium 分支）；若手头有官方 Chrome 109 绿版，直接替换 `Chrome/chrome.exe` 即可。
- 首次运行需**管理员身份**安装 VC++ 运行库（写系统目录需要权限），之后普通双击即可。
