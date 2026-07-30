# -*- coding: utf-8 -*-
"""Flask 服务：静态页面、REST 控制接口、WebSocket 实时推流。"""
import json
import mimetypes
import os
import socket as _socket
from pathlib import Path
from urllib.parse import quote, urlparse

from flask import Flask, Response, request, send_file, send_from_directory
from flask_sock import Sock

from . import state
from .config import HOST, PORT, PORT_CANDIDATES, STATIC_DIR, CONFIG_FILE, USER_CONFIG


def resolve_port(preferred=None):
    """挑一个能成功 bind 的端口，避开 Windows 保留区间（bind 报 10013 的情况）。

    做法：对每个候选端口先 bind 测试，成功即关闭并返回该端口，再交给 Flask 使用。
    由于是本地桌面工具、候选端口本就空闲，bind->close->Flask bind 之间的竞态窗口可忽略。
    """
    candidates = []
    if preferred:
        candidates.append(preferred)
    candidates += list(PORT_CANDIDATES)
    tried = set()
    for p in candidates:
        if p in tried:
            continue
        tried.add(p)
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        s.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
        try:
            s.bind((HOST, p))
            actual = s.getsockname()[1]
            s.close()
            return actual
        except OSError:
            s.close()
    return 0

app = Flask(__name__, static_folder=None)
sock = Sock(app)


# ---------------- 页面 / 静态资源 ----------------
@app.route("/")
def index():
    return send_file(str(STATIC_DIR / "index.html"))


@app.route("/static/<path:p>")
def static_files(p):
    return send_from_directory(str(STATIC_DIR), p)


# ---------------- REST 控制接口 ----------------
@app.route("/api/status")
def api_status():
    return json.dumps(state.browser_manager.status_info(), ensure_ascii=False)


@app.post("/api/start")
def api_start():
    data = request.get_json(silent=True) or {}
    mode = data.get("mode") or None
    local_path = data.get("local_path") or None
    browser = data.get("browser") or None
    start_url = data.get("start_url") or "about:blank"
    try:
        info = state.browser_manager.launch(
            mode=mode, local_path=local_path, start_url=start_url, browser=browser
        )
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False), 500
    return json.dumps({"ok": True, "status": info}, ensure_ascii=False)


@app.post("/api/stop")
def api_stop():
    info = state.browser_manager.stop()
    return json.dumps({"ok": True, "status": info}, ensure_ascii=False)


@app.post("/api/clear")
def api_clear():
    state.store.clear_all()
    state.broadcast(json.dumps({"type": "cleared"}, ensure_ascii=False))
    return json.dumps({"ok": True})


@app.route("/api/request/<int:seq>")
def api_request(seq):
    rec = state.store.get(seq)
    if rec is None:
        return json.dumps({"error": "not found"}, ensure_ascii=False), 404
    return json.dumps(rec, ensure_ascii=False)


# ---------------- 辅助：从记录推断文件名 / MIME ----------------
_MIME_BY_TYPE = {
    "SCRIPT": "application/javascript",
    "STYLESHEET": "text/css",
    "XHR": "application/json",
    "FETCH": "application/json",
    "IMAGE": "application/octet-stream",
    "FONT": "font/woff2",
    "DOCUMENT": "text/html",
    "MEDIA": "application/octet-stream",
}


def _infer_mime(rec, resp):
    headers = resp.get("headers") or {}
    ct = headers.get("Content-Type") or headers.get("content-type") or resp.get("mime_type") or ""
    ct = ct.split(";")[0].strip()
    if ct:
        return ct
    rt = (rec.get("resource_type") or "").upper()
    return _MIME_BY_TYPE.get(rt, "application/octet-stream")


def _infer_filename(rec, resp):
    url = rec.get("url") or ""
    seg = ""
    try:
        seg = urlparse(url).path.rstrip("/").split("/")[-1]
    except Exception:
        seg = ""
    if seg and "." in seg:  # 已有扩展名（如 src_xxx.js）
        return seg
    rt = (rec.get("resource_type") or "").upper()
    ext = mimetypes.guess_extension(_infer_mime(rec, resp)) or ""
    if not ext:
        ext = {
            "SCRIPT": ".js", "STYLESHEET": ".css", "XHR": ".json",
            "FETCH": ".json", "IMAGE": ".bin", "FONT": ".woff2",
            "DOCUMENT": ".html",
        }.get(rt, ".txt")
    base = seg or (rec.get("path") or "download").rstrip("/").split("/")[-1] or "download"
    return base + ext


@app.route("/api/download")
def api_download():
    """把某条请求的响应体另存为文件（主要用于 JS/CSS/JSON 等静态/文本资源）。

    文件名从 URL path 末段推断（无扩展名时按 MIME / 资源类型补），
    MIME 优先取响应头 Content-Type。二进制响应体（未捕获原文）时返回 404。
    """
    try:
        seq = int(request.args.get("seq"))
    except (TypeError, ValueError):
        return json.dumps({"error": "seq 参数无效"}, ensure_ascii=False), 400
    rec = state.store.get(seq)
    if rec is None:
        return json.dumps({"error": "not found"}, ensure_ascii=False), 404
    resp = rec.get("response") or {}
    body = resp.get("body")
    if body is None:
        return json.dumps(
            {"error": "该请求无响应体（可能是二进制未捕获原文，或本身无 body）"},
            ensure_ascii=False,
        ), 404
    filename = _infer_filename(rec, resp)
    mime = _infer_mime(rec, resp) or "application/octet-stream"
    data = body.encode("utf-8", "replace") if isinstance(body, str) else body
    # filename*=UTF-8'' 兼容中文/特殊字符文件名，外层 filename 用 ASCII 兜底
    cd = "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (
        filename.encode("ascii", "replace").decode("ascii"),
        quote(filename, safe=""),
    )
    return Response(data, mimetype=mime, headers={"Content-Disposition": cd})


# ---------------- 配置（端口等，改后需重启生效） ----------------
@app.route("/api/config")
def api_get_config():
    return json.dumps(
        {
            "saved_port": USER_CONFIG.get("port"),
            "running_port": request.host.split(":")[1] if ":" in request.host else "80",
            "browser_options": ["auto", "chrome", "edge"],
        },
        ensure_ascii=False,
    )


@app.post("/api/config")
def api_set_config():
    data = request.get_json(silent=True) or {}
    port = data.get("port")
    if port is not None:
        try:
            port = int(port)
            if not (1 <= port <= 65535):
                raise ValueError("端口范围 1-65535")
        except (TypeError, ValueError) as e:
            return json.dumps({"ok": False, "error": f"端口无效：{e}"}, ensure_ascii=False), 400
    # 读取现有配置并覆写 port 字段，避免丢失其他键
    cfg = {}
    try:
        if CONFIG_FILE.exists():
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f) or {}
    except Exception:
        cfg = {}
    if port is None:
        cfg.pop("port", None)
    else:
        cfg["port"] = port
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({"ok": False, "error": f"写入配置失败：{e}"}, ensure_ascii=False), 500
    return json.dumps({"ok": True, "restart_required": True}, ensure_ascii=False)


@app.route("/api/export")
def api_export():
    fmt = (request.args.get("format") or "har").lower()
    desensitize = request.args.get("desensitize") in ("1", "true", "yes", "on")
    mask_cfg = None
    if desensitize:
        # 仅收集用户显式配置（非空）的类别；未配置/留空的类别不脱敏（原样保留）。
        mask_cfg = {}
        for key in ("cjk", "digit", "alpha"):
            v = request.args.get(key)
            if v is not None and v != "":
                mask_cfg[key] = v
    if fmt == "json":
        data = json.dumps(state.store.export_json(desensitize=desensitize, mask_cfg=mask_cfg), ensure_ascii=False)
        return Response(
            data,
            mimetype="application/json",
            headers={"Content-Disposition": "attachment; filename=api-recording.json"},
        )
    data = json.dumps(state.store.export_har(desensitize=desensitize, mask_cfg=mask_cfg), ensure_ascii=False)
    return Response(
        data,
        mimetype="application/json",
        headers={"Content-Disposition": "attachment; filename=api-recording.har"},
    )


# ---------------- 导出 Mock 服务器脚本 ----------------
MOCK_TEMPLATE = r'''#!/usr/bin/env python
# -*- coding: utf-8 -*-
# Auto-generated mock server by API Recorder.
# 录制到的 API（仅 XHR/FETCH）被内嵌在 DATA 中。运行：
#     pip install flask
#     python mock_server.py [--port 8080] [--host 127.0.0.1]
# 匹配规则：先按 method + path + query 精确匹配；未命中则按 method + path 匹配；
#          仍无命中返回 404。响应体 / 状态码 / 响应头均来自录制。
import argparse
import json

from flask import Flask, request, Response

DATA = __DATA__

app = Flask(__name__)
EXCLUDE_HEADERS = {"content-length", "content-encoding", "transfer-encoding", "connection"}


def _norm(p):
    return p if p.startswith("/") else "/" + p


def find_match(method, path, query_str):
    path = _norm(path)
    for r in DATA:
        if r.get("method") == method and _norm(r.get("path", "")) == path and (r.get("query") or "") == query_str:
            return r
    for r in DATA:
        if r.get("method") == method and _norm(r.get("path", "")) == path:
            return r
    return None


@app.route("/", defaults={"path": ""}, methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
@app.route("/<path:path>", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
def mock(path):
    m = find_match(request.method, "/" + path, request.query_string.decode("utf-8", "replace"))
    if not m:
        return Response("", status=404, headers={"Content-Type": "text/plain; charset=utf-8"})
    resp = m.get("response") or {}
    body = resp.get("body") or ""
    if not isinstance(body, str):
        body = json.dumps(body, ensure_ascii=False)
    headers = {k: v for k, v in (resp.get("headers") or {}).items() if k.lower() not in EXCLUDE_HEADERS}
    return Response(body, status=resp.get("status", 200), headers=headers)


def main():
    parser = argparse.ArgumentParser(description="API Recorder mock server")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    print("Mock server running at http://%s:%d/  (recorded %d API calls)" % (args.host, args.port, len(DATA)))
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
'''


def _mock_records():
    """提取录制中的 API（XHR/FETCH）调用，构造 mock 数据。"""
    out = []
    for r in state.store.requests:
        rt = (r.get("resource_type") or "").upper()
        if rt not in ("XHR", "FETCH"):
            continue
        resp = r.get("response") or {}
        out.append({
            "method": r.get("method"),
            "path": r.get("path") or "",
            "query": r.get("query") or "",
            "response": {
                "status": resp.get("status", 200),
                "headers": resp.get("headers") or {},
                "body": resp.get("body"),
            },
        })
    return out


@app.route("/api/export_mock")
def api_export_mock():
    records = _mock_records()
    if not records:
        return json.dumps(
            {"error": "没有可模拟的 API 录制（仅 XHR/FETCH 类型会被导出，请先录制接口调用）"},
            ensure_ascii=False,
        ), 400
    data_json = json.dumps(records, ensure_ascii=False)
    script = MOCK_TEMPLATE.replace("__DATA__", data_json)
    return Response(
        script,
        mimetype="text/x-python",
        headers={"Content-Disposition": 'attachment; filename="mock_server.py"'},
    )


# ---------------- 进程内 Mock 服务（点按钮直接起，无需导出脚本） ----------------
@app.post("/api/mock/start")
def api_mock_start():
    data = request.get_json(silent=True) or {}
    port = data.get("port")
    if port is not None:
        try:
            port = int(port)
        except (TypeError, ValueError):
            return Response(
                json.dumps({"ok": False, "error": "端口无效"}, ensure_ascii=False),
                status=400, mimetype="application/json",
            )
    res = state.mock_manager.start(port)
    if res.get("ok"):
        state.broadcast(
            json.dumps({"type": "mock", "status": state.mock_manager.status()}, ensure_ascii=False)
        )
    return Response(
        json.dumps(res, ensure_ascii=False),
        status=(200 if res.get("ok") else 400),
        mimetype="application/json",
    )


@app.post("/api/mock/stop")
def api_mock_stop():
    res = state.mock_manager.stop()
    state.broadcast(
        json.dumps({"type": "mock", "status": state.mock_manager.status()}, ensure_ascii=False)
    )
    return Response(json.dumps(res, ensure_ascii=False), mimetype="application/json")


@app.route("/api/mock/status")
def api_mock_status():
    return Response(
        json.dumps(state.mock_manager.status(), ensure_ascii=False), mimetype="application/json"
    )


@app.post("/api/import")
def api_import():
    f = request.files.get("file")
    if f is None or not f.filename:
        return json.dumps({"ok": False, "error": "未收到文件"}, ensure_ascii=False), 400
    raw = f.read()
    try:
        obj = json.loads(raw.decode("utf-8", "replace"))
    except Exception as e:
        return json.dumps({"ok": False, "error": f"文件不是合法 JSON/HAR：{e}"}, ensure_ascii=False), 400

    try:
        if (
            isinstance(obj, dict)
            and isinstance(obj.get("log"), dict)
            and "entries" in obj["log"]
        ):
            n = state.store.import_from_har(obj)
            kind = "HAR"
        elif isinstance(obj, dict) and "requests" in obj:
            n = state.store.import_from_json(obj)
            kind = "JSON"
        else:
            return json.dumps(
                {"ok": False, "error": "无法识别文件格式（既不是本工具 JSON，也不是 HAR）"},
                ensure_ascii=False,
            ), 400
    except Exception as e:
        return json.dumps({"ok": False, "error": f"导入失败：{e}"}, ensure_ascii=False), 500

    # 把最新快照推给所有已连接的客户端，前端树会自动刷新
    try:
        snap = {
            "type": "snapshot",
            "status": state.browser_manager.status_info(),
            "stats": state.store.stats(),
            "requests": [state.store.light(r) for r in state.store.requests],
        }
        state.broadcast(json.dumps(snap, ensure_ascii=False))
    except Exception:
        pass
    return json.dumps({"ok": True, "kind": kind, "count": n}, ensure_ascii=False)


# ---------------- WebSocket 实时推流 ----------------
@sock.route("/ws")
def ws_route(ws):
    state.ws_clients.add(ws)
    try:
        snap = {
            "type": "snapshot",
            "status": state.browser_manager.status_info(),
            "stats": state.store.stats(),
            "requests": [state.store.light(r) for r in state.store.requests],
        }
        ws.send(json.dumps(snap, ensure_ascii=False))
        while True:
            msg = ws.receive()
            if msg is None:
                break
    except Exception:
        pass
    finally:
        state.ws_clients.discard(ws)


if __name__ == "__main__":
    actual = resolve_port(PORT)
    app.run(host=HOST, port=actual, threaded=True, use_reloader=False)
