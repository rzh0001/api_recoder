# -*- coding: utf-8 -*-
"""全局配置：端口、runtime 目录、浏览器内核路径、截断阈值等。"""
import json
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

import sys
if getattr(sys, "frozen", False):
    # 被 PyInstaller 冻结后：可执行文件所在目录（dist 根），用于存放需持久化的
    # 运行时数据（config.json / 浏览器 user_data）以及随包捆绑的资源。
    APP_DIR = Path(os.path.dirname(os.path.abspath(sys.executable)))
else:
    APP_DIR = BASE_DIR

RUNTIME_DIR = APP_DIR / "runtime"
CHROMIUM_DIR = RUNTIME_DIR / "chromium"          # 自带内核下载目录
USER_DATA_DIR = RUNTIME_DIR / "user_data"          # 浏览器用户数据目录
STATIC_DIR = BASE_DIR / "static"                  # 冻结后由 PyInstaller 把 static 打进 _MEIPASS
CONFIG_FILE = RUNTIME_DIR / "config.json"         # 用户持久化配置（端口等）

# 随包捆绑、与 exe 同目录的运行时资源（仅打包版使用，开发期这些路径多半不存在）
BUNDLED_CHROME = APP_DIR / "Chrome" / "chrome.exe"  # 随包捆绑的 Chrome（可选；不存在则回退系统浏览器）

for _d in (RUNTIME_DIR, CHROMIUM_DIR, USER_DATA_DIR, STATIC_DIR):
    try:
        _d.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass


def _load_user_config():
    """读取 runtime/config.json 中的用户配置；读取失败则返回空 dict。"""
    try:
        if CONFIG_FILE.exists():
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                if isinstance(cfg, dict):
                    return cfg
    except Exception:
        pass
    return {}


USER_CONFIG = _load_user_config()

HOST = "127.0.0.1"
# 端口优先级：环境变量 API_RECORDER_PORT > 配置文件 config.json 的 port > None(自动选)。
# 直接写死 6789 曾触发 WSAEACCES(10013)：端口落在 Windows 保留区间里，即使没被占用也 bind 失败。
_PORT_ENV = os.environ.get("API_RECORDER_PORT")
if _PORT_ENV:
    try:
        PORT = int(_PORT_ENV)
    except ValueError:
        PORT = None
else:
    _cfg_port = USER_CONFIG.get("port")
    PORT = int(_cfg_port) if isinstance(_cfg_port, int) else None
# 自动选端口时的候选顺序（靠前的优先；末尾的 0 表示交给系统分配一个完全空闲的端口）。
PORT_CANDIDATES = [6789, 6790, 8080, 8888, 8000, 5000, 9000, 5001, 7777, 0]

# Mock 服务端口：独立端口（与被测程序对接用）。
# 优先级：环境变量 API_RECORDER_MOCK_PORT > config.json 的 mock_port > None(每次随机分配)。
_MOCK_PORT_ENV = os.environ.get("API_RECORDER_MOCK_PORT")
if _MOCK_PORT_ENV:
    try:
        MOCK_PORT = int(_MOCK_PORT_ENV)
    except ValueError:
        MOCK_PORT = None
else:
    _cfg_mock_port = USER_CONFIG.get("mock_port")
    MOCK_PORT = int(_cfg_mock_port) if isinstance(_cfg_mock_port, int) else None

# 浏览器内核模式：builtin(自带 Chromium) / local(本机已装 Chrome/Edge)
DEFAULT_BROWSER_MODE = os.environ.get("API_RECORDER_BROWSER_MODE", "builtin")
# 本机浏览器显式路径（local 模式优先使用）；为空则自动探测
DEFAULT_LOCAL_BROWSER = os.environ.get("API_RECORDER_LOCAL_BROWSER", "")

# 本机浏览器自动探测的候选路径（Windows）
LOCAL_BROWSER_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Users\{}\AppData\Local\Google\Chrome\Application\chrome.exe".format(os.environ.get("USERNAME", "")),
]

# 资源上限，避免内存爆炸
MAX_REQUESTS = int(os.environ.get("API_RECORDER_MAX_REQUESTS", "50000"))
MAX_BODY_STORE = 2 * 1024 * 1024     # 单请求 body 在内存中最多存 2MB
MAX_BODY_WS = 200 * 1024             # 经 WebSocket 实时推送的 body 最多 200KB

APP_NAME = "API Recorder"
APP_VERSION = "0.1.0"
