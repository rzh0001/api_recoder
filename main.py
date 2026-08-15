# -*- coding: utf-8 -*-
"""客户端入口：后台启动 Flask 本地服务，用 pywebview 打开原生窗口作为控制面板。

- 启动即拉起本地服务（127.0.0.1:PORT），随后弹出桌面窗口加载该页面。
- 点「开始录制」时才会由后端用 DrissionPage 拉起被监控的浏览器（独立的 Chrome 窗口）。
- 关闭窗口时自动停止录制并退出被监控浏览器。
"""
import os
import socket
import sys
import threading
import time
import webbrowser

from app import state
from app.config import HOST, PORT, RUNTIME_DIR
from app.server import app, resolve_port


def wait_for_port(port, host="127.0.0.1", timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def run_flask(port):
    app.run(host=HOST, port=port, threaded=True, use_reloader=False)


def _redirect_logs():
    """冻结版把 stdout/stderr 重定向到 runtime/app.log，便于在目标机排错
    （--windowed 下没有控制台）。"""
    if getattr(sys, "frozen", False):
        try:
            RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
            log_path = RUNTIME_DIR / "app.log"
            sys.stdout = open(log_path, "a", encoding="utf-8", buffering=1)
            sys.stderr = sys.stdout
        except Exception:
            pass


def main():
    _redirect_logs()
    actual_port = resolve_port(PORT)
    print(f"* API Recorder 本地服务将启动于 http://{HOST}:{actual_port}/")
    t = threading.Thread(target=run_flask, args=(actual_port,), daemon=True)
    t.start()
    if not wait_for_port(actual_port):
        print("错误：本地服务未能在预期时间内启动。")
        return

    try:
        import webview

        # 允许下载：否则 WebView2 的 on_download_starting 会直接 Cancel 下载，
        # 导出（blob 下载）会静默失败且不弹窗。开启后浏览器下载会改走
        # WebView2 的原生保存对话框（UI 线程触发，不经 js_api 线程，可靠）。
        webview.settings["ALLOW_DOWNLOADS"] = True

        _icon = os.path.join(
            getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__))),
            "static", "icon.ico",
        )
        window = webview.create_window(
            "API Recorder · API 录制器",
            f"http://{HOST}:{actual_port}/",
            width=1280,
            height=820,
        )

        def on_closed():
            try:
                state.browser_manager.stop()
            except Exception:
                pass

        window.events.closed += on_closed
        webview.start(icon=_icon if os.path.exists(_icon) else None)
    except ImportError:
        print(
            f"未安装 pywebview，已在系统浏览器打开 http://{HOST}:{actual_port}/ "
            f"（Ctrl+C 退出，或先 pip install pywebview 获得桌面窗口）"
        )
        webbrowser.open(f"http://{HOST}:{actual_port}/")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            state.browser_manager.stop()


if __name__ == "__main__":
    main()
