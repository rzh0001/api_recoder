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
- **PyInstaller 不收集完整 API-set DLL（关键！）**：PyInstaller 只收集部分旧版（l1-1-0）api-set DLL，但 `ucrtbase.dll` 实际依赖高版本（l1-1-1, l1-2-0 等）。必须**额外补全**：从 Win10+ 的 `System32\downlevel\` 缓存全部 ~91 个 api-set-*.dll 到发布包 + `C:\api_recorder_build\apiset\`；`assemble.py` 步骤 3.5 自动补全。工具脚本 `check_apiset_deps.py`(pefile 分析) 可验证完整性。
- **VC++ 冲突处理**：若用户之前误装过 VC++ 2022（不支持 Win7 但可能「假装成功」），会与 2015-2019 冲突报 0x80070666。bat 启动器需**先从注册表查并卸载 VC++ 2022**，再装 2015-2019；若仍失败则**管理员拷贝 UCRT DLL 到 System32**（兜底）。

## Chrome 109 已不可获取（关键结论）
- 所有可达镜像（Chrome-for-Testing、npmmirror、Google 官方版本化安装器、Slimjet 归档）均 404 或只到 104/112+。Google 已下架 Chrome 109。
- 替代方案：用 **Supermium**（专支持 Win7/8/8.1 的 Chromium 分支，GitHub releases 可达）作为随包抓包浏览器，主程序即 `chrome.exe`。若用户手头有官方 Chrome 109 绿版，直接替换 `Chrome/chrome.exe`。

## 构建/组装要点
- `packaging/build.py`：PyInstaller `--onedir --windowed`，必须 `--hidden-import clr`（pywebview edgechromium 后端依赖 pythonnet 的 clr；纯 py 模块进 EXE 内嵌归档，磁盘上看不到散落文件属正常）。
- `packaging/assemble.py`：`WEBVIEW2_RUNTIME_DIR` 指向随包 WebView2；`WebView2Loader.dll` 要从 WebView2 SDK nupkg（非 Runtime nupkg）补，且放 exe 同目录 + 运行时目录。
- **沙箱坑**：PyInstaller COLLECT 与 assemble 的密集文件操作在 WorkBuddy 沙箱内因文件锁/权限失败（Exit 1，日志在 "Removing dir" 处截断）。须先清空旧 `dist/API_Recorder`+`build/API_Recorder`，再以 `dangerouslyDisableSandbox:true` 运行。
- **win7 分支专用（Python 3.7 降级线）**：依赖降级到 3.7 能跑（requirements.txt 已锁版本）。build.py 用 PyInstaller 5.13.2 + `--hidden-import clr`；assemble.py 须 **3.7 兼容**（用 `copytree_compat` 替代 3.8+ 的 `dirs_exist_ok`），统一用 `C:\api_recorder_build\python37\python.exe` 跑 build+assemble。`packaging/launcher.bat` 由 assemble 拷为发布包 `启动 API_Recorder.bat`，负责首启静默装 VC++ 2015-2019（先卸 2022 解 0x80070666）+ UCRT 兜底；标记写 `runtime/.vcredist_installed` 与 app 对齐。

## 协作约定（来自用户上下文）
- 本项目是**参考/被保护项目**：只读写本项目目录，绝不改动其它参考项目（如 E:\smartedu_auto）；不要在他人项目里写文件或复用其 .venv。

## Mock 功能前后端状态契约（易错坑！★）
- 前端 `updateMockUI(info)` 用 **`info.running`**（布尔）判断 mock 是否运行；`handleMsg` 处理 WS `type:"mock"` 推送时也调它。
- 后端三类返回**必须都带 `running` 字段**：
  - `/api/mock/status` → `mock_manager.status()`（running 时含 `running:True`）
  - `/api/mock/stop` → `{ok, running:False}`
  - `/api/mock/start` → **曾漏掉 `running` 字段**（只返回 `{ok,url,port,count}`），导致前端 `info.running===undefined` 误判为未启动：按钮恢复可点、状态改回空闲，表现即"点启动没反应，其实 mock 已在后台跑"。**修法**：`api_mock_start` 在 `res.get("ok")` 时补 `res["running"]=True`。
- 调试"前端没反应"类问题：别只看源码静态读——用 Playwright + 系统浏览器真实加载点击复现，并看后端视图函数真实 HTTP 返回结构，比 test_client 更接近线上。

## Mock 快照模型 + 录制互斥（架构约定 ★）
- **结论**：Mock 是 `start()` 瞬间的**快照**（`mock_manager._build_data()` 把 store 拷成 `self.data`），之后只读快照、与 `state.store` 脱钩。因此快照启动后，录制库的任何变动（继续录制/导入/清空）都不会反映到正在服务的 Mock —— 会造成"API 页看到的和 Mock 实际返回的不一致"。
- **用户拍板采用「模型 A」**：快照 + 互斥。录制与 Mock 不应共存；Mock 运行时冻结录制库。
- **前端锁（`applyLocks()`）**：`mockRunning` 真→禁用 `开始录制/导入/清空`+tooltip；`recordingActive` 真→禁用 `启动 Mock`+tooltip。`updateStatus`/`updateMockUI` 写状态后调用。
- **后端守卫**：`POST /api/start` 查 `state.mock_manager.running`；`POST /api/mock/start` 查 `state.browser_manager._running`（注意是 `_running` 私有属性，True 表示正在录）。两者冲突均返回 `{ok:False,error}` 中文提示。
- 这是快照模型下的正确自洽方案；若以后想让 Mock 实时跟随录制库改动，需改成"实时读库"并加并发锁 + 处理"清空会瞬间让 Mock 全 404"的坑（成本高，未采用）。

## 端口模型（★易错坑）
- **主服务端口 ≠ Mock 端口，是两个独立端口**：
  - 主控制面板（`server.py`）= 配置 `port`（config.json / 环境变量 `API_RECORDER_PORT`），即 config 里唯一那个端口。
  - Mock 服务（`mock_manager.py`，独立 Flask+独立线程，host 127.0.0.1）= `mock_port`：优先级 `API_RECORDER_MOCK_PORT` > `config.json.mock_port` > None(每次随机 `0`)。前端「启动 Mock」可带 `{port}` 覆盖；空则后端回退 `MOCK_PORT`。
  - Mock 端口必须独立：被测程序对接的是 Mock 端口而非控制面板；且因跨端口，前端测试走主服务代理 `/api/mock/test` 绕过 CORS。
- **`applyLocks()` 曾踩坑（已修）**：原 `startMockBtn.disabled = recordingActive || (mockRunning ? true : startMockBtn.disabled)` 在 `mockRunning=false` 时回退旧 disabled 值，导致停 Mock 后 start 永久禁用。正确写法：`startMockBtn.disabled = recordingActive || mockRunning`（显式计算）。
- config 写盘入口 `POST /api/config` 用「读旧 cfg → 覆写字段 → 写回」避免丢键；`mock_port` 校验 1-65535。
