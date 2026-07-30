# -*- coding: utf-8 -*-
"""组装最终的 Win7 发布文件夹。

把 PyInstaller 冻结产物（dist/API_Recorder）与外部运行时资源整合到一起：
  - WebView2 109 固定运行时  -> API_Recorder/WebView2Runtime/  (控制面板 UI 用)
  - Supermium 144 (Win7 版 Chromium, 以 chrome.exe 命名) -> API_Recorder/Chrome/ (DrissionPage 抓包用)
  - WebView2Loader.dll       -> API_Recorder/ 与 WebView2Runtime/ (加载器需与 exe 同目录)
  - UCRT 冷启动 DLL 16 个     -> API_Recorder/ (exe 同目录, 保证 Win7 冷启动)
  - vc_redist.x64.exe        -> API_Recorder/ (首次运行静默安装)

注意：本脚本在 Python 3.8 构建环境外也能跑（纯 shutil/zipfile）。
"""
import os
import shutil
import zipfile

BUILD = r"C:\api_recorder_build"
DIST = os.path.join(BUILD, "dist", "API_Recorder")          # 最终发布根目录
WV2_SRC = os.path.join(BUILD, "wv2pkg", "contentFiles", "any", "any", "WebView2")
WV2_LOADER = os.path.join(BUILD, "wv2sdk", "runtimes", "win-x64", "native", "WebView2Loader.dll")
SUPER_ZIP = os.path.join(BUILD, "supermium.zip")
UCRT_SRC = os.path.join(BUILD, "ucrt")
VCREDIST = os.path.join(BUILD, "vc_redist.x64.exe")

WEBVIEW2_DIR = os.path.join(DIST, "WebView2Runtime")
CHROME_DIR = os.path.join(DIST, "Chrome")

README_TXT = """API Recorder · Windows 7 发布包
================================

本文件夹是一个「开箱即用」的绿色版 API 录制器，目标系统为 Windows 7（x64）。
所有依赖均已随包捆绑，无需联网安装。

【目录说明】
- API_Recorder.exe      主程序（双击启动，弹出控制面板窗口）
- WebView2Runtime/      WebView2 109 固定运行时（控制面板 UI 的内核，Win7 最后一个可用版本）
- Chrome/               随包捆绑的 Chromium 浏览器（chrome.exe），由 DrissionPage 驱动抓包
- WebView2Loader.dll    与 exe 同目录的 WebView2 加载器
- *.dll (ucrt*)         UCRT 冷启动运行库（保证缺补丁的 Win7 也能启动）
- vc_redist.x64.exe     首次运行时自动静默安装的 Visual C++ 运行库

【运行方式】
1. 把整个 API_Recorder 文件夹拷贝到 Win7 目标机（任意位置，路径不要含中文/空格最佳）。
2. 右键 API_Recorder.exe -> 以管理员身份运行（首次运行需安装 VC++ 运行库，写系统目录需要权限）。
   之后日常使用普通双击即可。
3. 等待控制面板窗口出现（首次会静默安装 VC++，可能稍慢）。

【重要说明 / 已知限制】
1. 抓包浏览器：本包捆绑的是 Supermium 144（一个持续维护、专门支持 Windows 7/8/8.1 的
   Chromium 分支），而非 Google Chrome 109。原因：Google 已从所有公开镜像下架 Chrome 109
   安装包（Chrome-for-Testing、Google 官方、Slimjet 归档均只到 104 或 112+），
   确属无法自动获取。Supermium 与 Chrome 109 同源（都是 Chromium），DevTools 协议兼容，
   DrissionPage 可正常驱动。如果你手头有官方 Chrome 109（109.0.5414.120）的绿色版，
   直接替换 Chrome/chrome.exe 即可。
2. 控制面板 UI 内核为 WebView2 109（最后一个支持 Win7 的 WebView2 版本），已随包固定，
   不依赖系统已安装的 WebView2。
3. VC++ 运行库首次安装需要管理员权限；若自动安装失败，请手动运行包内 vc_redist.x64.exe。
4. Win7 需为 SP1 并安装 KB2999226 / KB3118401（UCRT 补丁）；本包已附带 UCRT DLL 作为兜底，
   但完整运行库仍以 vc_redist 安装为准。

【排错】
- 启动黑屏/无窗口：确认以管理员身份首次运行过（VC++ 已装）。
- 控制面板打不开：查看 runtime/app.log（程序日志）。
- 抓包浏览器起不来：确认 Chrome/chrome.exe 存在且未被杀软隔离。
"""


def log(msg):
    print("[assemble] " + msg)


def ensure_dir(p):
    os.makedirs(p, exist_ok=True)


def copy_file(src, dst):
    ensure_dir(os.path.dirname(dst))
    shutil.copy2(src, dst)
    log("copied %s -> %s" % (src, dst))


# 1) WebView2 固定运行时
log("=== 复制 WebView2 109 固定运行时 -> WebView2Runtime/ ===")
ensure_dir(WEBVIEW2_DIR)
# 源目录整体拷入（保留 msedgewebview2.exe 等 60 个文件）
for entry in os.listdir(WV2_SRC):
    s = os.path.join(WV2_SRC, entry)
    d = os.path.join(WEBVIEW2_DIR, entry)
    if os.path.isdir(s):
        shutil.copytree(s, d, dirs_exist_ok=True)
    else:
        shutil.copy2(s, d)
# 补上 WebView2Loader.dll（Runtime nupkg 不含，需从 SDK nupkg 取）
copy_file(WV2_LOADER, os.path.join(WEBVIEW2_DIR, "WebView2Loader.dll"))
copy_file(WV2_LOADER, os.path.join(DIST, "WebView2Loader.dll"))   # exe 同目录也放一份


# 2) Supermium (chrome.exe) -> Chrome/
log("=== 解压 Supermium -> Chrome/ ===")
ensure_dir(CHROME_DIR)
tmp = os.path.join(BUILD, "_super_extract")
if os.path.isdir(tmp):
    shutil.rmtree(tmp)
with zipfile.ZipFile(SUPER_ZIP) as z:
    z.extractall(tmp)
super_src = os.path.join(tmp, "Supermium")
if not os.path.isdir(super_src):
    raise SystemExit("Supermium 解压后未找到 Supermium/ 目录")
# 复制（排除 Supermium 自带的 setup.exe / uninstall.exe，避免误装系统）
shutil.copytree(
    super_src, CHROME_DIR,
    dirs_exist_ok=True,
    ignore=shutil.ignore_patterns("setup.exe", "uninstall.exe"),
)
# 根目录的 NotoEmoji.ttf 一并带走（Chrome 表情字体）
for f in os.listdir(tmp):
    if f.lower().endswith(".ttf"):
        copy_file(os.path.join(tmp, f), os.path.join(CHROME_DIR, f))
shutil.rmtree(tmp, ignore_errors=True)
# 校验
chrome_exe = os.path.join(CHROME_DIR, "chrome.exe")
if not os.path.exists(chrome_exe):
    raise SystemExit("Chrome/chrome.exe 未生成！")
log("Chrome/chrome.exe 就绪: %d bytes" % os.path.getsize(chrome_exe))


# 3) UCRT 冷启动 DLL -> exe 同目录
log("=== 复制 UCRT 冷启动 DLL -> 发布根目录 ===")
for f in os.listdir(UCRT_SRC):
    if f.lower().endswith(".dll"):
        copy_file(os.path.join(UCRT_SRC, f), os.path.join(DIST, f))


# 4) VC++ redist -> 发布根目录
if os.path.exists(VCREDIST):
    copy_file(VCREDIST, os.path.join(DIST, "vc_redist.x64.exe"))
else:
    log("WARNING: 未找到 vc_redist.x64.exe，跳过（首次运行安装 VC++ 会失败）")


# 5) 写使用说明
log("=== 写 README.txt ===")
readme = os.path.join(DIST, "README.txt")
with open(readme, "w", encoding="utf-8") as fh:
    fh.write(README_TXT)
log("README.txt 已写")

log("=== 组装完成，发布根目录: %s ===" % DIST)
