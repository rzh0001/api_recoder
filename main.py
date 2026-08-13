# -*- coding: utf-8 -*-
"""客户端入口：后台启动 Flask 本地服务，用 pywebview 打开原生窗口作为控制面板。

- 启动即拉起本地服务（127.0.0.1:PORT），随后弹出桌面窗口加载该页面。
- 点「开始录制」时才会由后端用 DrissionPage 拉起被监控的浏览器（独立的 Chrome 窗口）。
- 关闭窗口时自动停止录制并退出被监控浏览器。
"""
import base64
import ctypes
import json
import os
import socket
import sys
import threading
import time
import webbrowser

from app import state
from app.config import HOST, PORT, RUNTIME_DIR
from app.server import app, resolve_port


def _warn_box(msg):
    """弹一个系统消息框（无 GUI 依赖）；失败则退回打印。"""
    try:
        ctypes.windll.user32.MessageBoxW(0, str(msg), "API Recorder", 0x30)
    except Exception:
        print(msg)


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

            def save_to_path(self, path, content_b64):
                """直接覆盖写入指定路径（不弹对话框），用于「保存」覆盖已打开的文件。"""
                if not path:
                    return {"ok": False, "error": "路径为空"}
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

            def open_file(self):
                """原生「打开文件」对话框：返回真实路径 + base64 内容，供前端导入并关联来源。"""
                if not self._window:
                    return {"ok": False, "error": "窗口未就绪"}
                result = self._window.create_file_dialog(
                    webview.OPEN_DIALOG,
                    file_types=("HAR JSON files (*.har;*.json)",),
                    allow_multiple=False,
                )
                if not result:
                    return {"ok": False, "cancelled": True}
                path = result[0] if isinstance(result, (list, tuple)) else result
                try:
                    with open(path, "rb") as f:
                        data = f.read()
                except Exception as e:
                    return {"ok": False, "error": str(e)}
                return {
                    "ok": True,
                    "path": path,
                    "name": os.path.basename(path),
                    "content_b64": base64.b64encode(data).decode(),
                }

            def import_files(self):
                """桌面端「导入」：原生多选对话框拿到完整路径并读盘。

                - 单文件导入时记录来源路径（之后「保存」可直接覆盖写回该文件）；
                - 多文件合并时来源不唯一，不设来源（「保存」回退为另存为）。
                - 复用服务端 _import_files 的解析/校验/两阶段原子导入逻辑。
                """
                if not self._window:
                    return {"ok": False, "error": "窗口未就绪"}
                result = self._window.create_file_dialog(
                    webview.OPEN_DIALOG,
                    file_types=("HAR JSON files (*.har;*.json)",),
                    allow_multiple=True,
                )
                if not result:
                    return {"ok": False, "cancelled": True}
                paths = list(result) if isinstance(result, (list, tuple)) else [result]

                mems = []
                for p in paths:
                    try:
                        with open(p, "rb") as fh:
                            data = fh.read()
                    except Exception as e:
                        return {"ok": False, "error": f"读取失败 {p}：{e}"}
                    mems.append(_MemFile(os.path.basename(p), data))

                from app.server import _import_files, USER_CONFIG, CONFIG_FILE

                ok, resp, status = _import_files(mems)
                if ok:
                    if len(paths) == 1:
                        sp = paths[0]
                        state.store.source_path = sp
                        try:
                            cfg = USER_CONFIG
                            cfg["last_source_har"] = sp
                            with open(CONFIG_FILE, "w", encoding="utf-8") as fh:
                                json.dump(cfg, fh, ensure_ascii=False, indent=2)
                        except Exception:
                            pass
                        resp["source_path"] = sp
                    else:
                        state.store.source_path = None
                return {"ok": ok, "data": resp, "status": status}

        class _MemFile:
            """内存文件对象，模拟 flask FileStorage 的最小接口（供 _import_files 用）。"""

            def __init__(self, filename, data):
                self.filename = filename
                self._d = data

            def read(self):
                return self._d

        api = RecorderApi()
        _icon = os.path.join(
            getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__))),
            "static", "icon.ico",
        )
        window = webview.create_window(
            "API Recorder · API 录制器",
            f"http://{HOST}:{actual_port}/",
            width=1280,
            height=820,
            js_api=api,
            icon=_icon if os.path.exists(_icon) else None,
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
