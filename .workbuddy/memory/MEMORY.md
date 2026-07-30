# API Recorder 项目长期记忆

## 项目定位
- Python + Flask 本地服务 + pywebview(WebView2) 桌面控制面板 + DrissionPage 驱动浏览器抓包，录制 API 请求/响应，可导出 HAR/JSON、Mock 脚本、进程内 Mock 服务。
- 目标交付：Win7 x64 绿色文件夹版（非单文件 exe）。

## Win7 打包硬约束（重要，反复踩坑）
- Python ≤ 3.8.x（3.9+ 安装器在 Win7 拒跑）。用 Python 3.8.10 embeddable + 手动 bootstrap pip。
- WebView2 Runtime ≤ 109（109.0.1518.78 是最后一个 Win7 兼容版）。控制面板 UI 用它。
- 浏览器 ≤ 109 才能在 Win7 跑（Chrome 109 是最后 Win7 版）。DrissionPage 抓包用它。
- **VC++ 必须用 2015-2019 x64（不是 2022！）**：VC++ 2022 redist 不支持 Win7（要求 Win10+），在 Win7 上装了等于没装，UCRT 还是缺失。必须用 `https://aka.ms/vs/16/release/vc_redist.x64.exe`（VC++ 2015-2019，最后一个支持 Win7 的版本，内含 UCRT 安装器）。随包文件名 `vc_redist_win7.x64.exe`。
- **Win7 API-set DLL 兜底（关键！已踩坑）**：不能只拷 `api-ms-win-crt-*`（C 运行时），必须同时从 `System32\downlevel\` 拷贝全部 `api-ms-win-core-*` / `api-ms-win-base-*` / `api-ms-win-shell-*` 等（共 ~91 个）。这些是 Windows 核心 API 转发 DLL，Win7 无 KB2999226 时全缺。只拷 crt 的话 Win7 启动就报「丢失 api-ms-win-core-sysinfo-l1-2-0.dll」。
- **但光拷 dll 没用**：Win7 加载器不认散落在 exe 同目录的 API-set 转发 DLL（这些在 Win10 通过系统级 Schema 解析）。正确做法是用 bat 启动器**先装 VC++ 2015-2019**（它把 UCRT 正确注册到系统目录），再启动 exe。KB2999226 直链已 404，不必单独下。
- **VC++ 冲突处理**：若用户之前误装过 VC++ 2022（不支持 Win7 但可能「假装成功」），会与 2015-2019 冲突报 0x80070666。bat 启动器需**先从注册表查并卸载 VC++ 2022**，再装 2015-2019；若仍失败则**管理员拷贝 UCRT DLL 到 System32**（兜底）。

## Chrome 109 已不可获取（关键结论）
- 所有可达镜像（Chrome-for-Testing、npmmirror、Google 官方版本化安装器、Slimjet 归档）均 404 或只到 104/112+。Google 已下架 Chrome 109。
- 替代方案：用 **Supermium**（专支持 Win7/8/8.1 的 Chromium 分支，GitHub releases 可达）作为随包抓包浏览器，主程序即 `chrome.exe`。若用户手头有官方 Chrome 109 绿版，直接替换 `Chrome/chrome.exe`。

## 构建/组装要点
- `packaging/build.py`：PyInstaller `--onedir --windowed`，必须 `--hidden-import clr`（pywebview edgechromium 后端依赖 pythonnet 的 clr；纯 py 模块进 EXE 内嵌归档，磁盘上看不到散落文件属正常）。
- `packaging/assemble.py`：`WEBVIEW2_RUNTIME_DIR` 指向随包 WebView2；`WebView2Loader.dll` 要从 WebView2 SDK nupkg（非 Runtime nupkg）补，且放 exe 同目录 + 运行时目录。
- **沙箱坑**：PyInstaller COLLECT 与 assemble 的密集文件操作在 WorkBuddy 沙箱内因文件锁/权限失败（Exit 1，日志在 "Removing dir" 处截断）。须先清空旧 `dist/API_Recorder`+`build/API_Recorder`，再以 `dangerouslyDisableSandbox:true` 运行。

## 协作约定（来自用户上下文）
- 本项目是**参考/被保护项目**：只读写本项目目录，绝不改动其它参考项目（如 E:\smartedu_auto）；不要在他人项目里写文件或复用其 .venv。
