# -*- coding: utf-8 -*-
"""客户端入口：后台启动 Flask 本地服务，用 pywebview 打开原生窗口作为控制面板。

- 启动即拉起本地服务（127.0.0.1:PORT），随后弹出桌面窗口加载该页面。
- 点「开始录制」时才会由后端用 DrissionPage 拉起被监控的浏览器（独立的 Chrome 窗口）。
- 关闭窗口时自动停止录制并退出被监控浏览器。
"""
import base64
import ctypes
import os
import socket
import sys
import subprocess
import threading
import time
import webbrowser

from app import state
from app.config import HOST, PORT, WEBVIEW2_RUNTIME_DIR, VCREDIST_EXE, RUNTIME_DIR
from app.server import app, resolve_port


def _warn_box(msg):
    """弹一个系统消息框（无 GUI 依赖）；失败则退回打印。"""
    try:
        ctypes.windll.user32.MessageBoxW(0, str(msg), "API Recorder", 0x30)
    except Exception:
        print(msg)


def configure_packaged_runtime():
    """打包版启动时的运行时初始化（开发期这些路径通常不存在，自动跳过）。

    - 若有随包的 WebView2 109 固定运行时，设置 WEBVIEW2_BROWSER_EXECUTABLE_FOLDER，
      让控制面板窗口在 Win7 上也能用 WebView2（>109 在 Win7 起不来）。
    - 若随包附带了 vc_redist.x64.exe 且尚未安装，则首次静默安装（Win7 缺 UCRT 会起不来）。
    """
    if WEBVIEW2_RUNTIME_DIR.exists():
        os.environ["WEBVIEW2_BROWSER_EXECUTABLE_FOLDER"] = str(WEBVIEW2_RUNTIME_DIR)
    if VCREDIST_EXE and VCREDIST_EXE.exists():
        marker = RUNTIME_DIR / ".vcredist_installed"
        # 注意：UCRT 缺失时本进程可能根本无法启动到此处；包内已额外附带 ucrtbase.dll
        # 与 api-ms-win-crt-*.dll 以保证冷启动。这里负责把完整的 VC++ 运行库装到系统，
        # 以便 WebView2 等独立进程也能用到。
        if not marker.exists():
            try:
                r = subprocess.run(
                    [str(VCREDIST_EXE), "/quiet", "/norestart"],
                    capture_output=True, text=True, timeout=420,
                )
                if r.returncode in (0, 3010):
                    try:
                        marker.write_text("ok", encoding="utf-8")
                    except Exception:
                        pass
                else:
                    _warn_box(
                        "API Recorder 需要 Visual C++ 运行库才能运行。\n"
                        "自动安装未完成（返回码 %s，可能缺少系统补丁 KB2999226/KB3118401）。\n"
                        "请手动运行包内的 vc_redist.x64.exe 后重试。" % r.returncode
                    )
            except Exception as e:
                _warn_box(
                    "API Recorder 需要 Visual C++ 运行库。\n自动安装失败：%s\n"
                    "请手动运行包内的 vc_redist.x64.exe。" % e
                )


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
    configure_packaged_runtime()
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

        class RecorderApi:
            """暴露给前端（js_api）的 Python 端能力。

            下载文件在 pywebview/WebView2 下由网页直接触发会被内核拦截，
            因此改为由 Python 端弹出原生「保存文件」对话框并写盘。
            """

            def __init__(self):
                self._window = None

            def _bind(self, win):
                self._window = win

            def save_file(self, filename, content_b64):
                if not self._window:
                    return {"ok": False, "error": "窗口未就绪"}
                # pywebview 4.x+ 用 window.create_file_dialog()（非模块级函数）
                # 返回值可能是 tuple / list / None（用户取消）
                result = self._window.create_file_dialog(
                    webview.SAVE_DIALOG, save_filename=filename
                )
                if not result:
                    return {"ok": False, "cancelled": True}
                path = result[0] if isinstance(result, (list, tuple)) else result
                try:
                    data = base64.b64decode(content_b64)
                except Exception:
                    data = content_b64.encode("utf-8")
                try:
                    with open(path, "wb") as f:
                        f.write(data)
                except Exception as e:
                    return {"ok": False, "error": str(e)}
                return {"ok": True, "path": path}

        api = RecorderApi()
        window = webview.create_window(
            "API Recorder · API 录制器",
            f"http://{HOST}:{actual_port}/",
            width=1280,
            height=820,
            js_api=api,
        )
        api._bind(window)

        def on_closed():
            try:
                state.browser_manager.stop()
            except Exception:
                pass

        window.events.closed += on_closed
        webview.start()
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
