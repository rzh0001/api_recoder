# -*- coding: utf-8 -*-
"""用 PyInstaller 把 API Recorder 冻结为 Windows 文件夹形态（onedir）。

用法：
    python packaging/build.py
"""
import os
import sys

from PyInstaller.__main__ import run

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)                       # E:\api_recoder
SRC = os.path.join(PROJECT, "main.py")
DIST = r"C:\api_recorder_build\dist"
WORK = r"C:\api_recorder_build\build"

opts = [
    SRC,
    "--name", "API_Recorder",
    "--onedir",
    "--windowed",
    "--paths", PROJECT,
    "--distpath", DIST,
    "--workpath", WORK,
    "--noconfirm",
    # WebView2 平台（Windows 上 pywebview 用的就是它）
    "--hidden-import", "webview.platforms.edgechromium",
    "--collect-submodules", "webview",
    # pywebview 的 edgechromium 后端通过 pythonnet 的 clr 模块加载 WebView2，
    # 必须显式冻结 clr（否则冻结产物启动即 ImportError）。
    "--hidden-import", "clr",
    # DrissionPage / flask-sock 含动态导入，整体收集子模块更稳
    "--collect-submodules", "DrissionPage",
    "--collect-submodules", "flask_sock",
    # websocket 相关（flask-sock 默认走 simple_websocket）
    "--hidden-import", "simple_websocket",
    "--hidden-import", "simple_websocket.ws",
    "--hidden-import", "websockets",
    "--hidden-import", "websocket",
    # 前端静态资源打进 _MEIPASS/static（config.STATIC_DIR 指向这里）
    "--add-data", os.path.join(PROJECT, "static") + os.pathsep + "static",
]

if __name__ == "__main__":
    print("PyInstaller building with Python", sys.version.split()[0])
    run(opts)
