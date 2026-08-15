# -*- coding: utf-8 -*-
"""Flask 服务：静态页面、REST 控制接口、WebSocket 实时推流。"""
import base64
import json
import mimetypes
import os
import socket as _socket
import time as _time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlparse

from flask import Flask, Response, request, send_file, send_from_directory
from flask_sock import Sock

from . import state
from .capture_store import _registered_domain
from .config import HOST, PORT, MOCK_PORT, PORT_CANDIDATES, STATIC_DIR, CONFIG_FILE, USER_CONFIG, EXPORT_DIR


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
    # 互斥守卫：Mock 运行中不允许再开始录制（快照模型下两者不能共存）
    if state.mock_manager.running:
        return json.dumps(
            {"ok": False, "error": "请先停止 Mock 服务，再开始录制（录制与 Mock 不能同时进行）"},
            ensure_ascii=False,
        ), 400
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


@app.post("/api/request/delete")
def api_request_delete():
    """删除单条录制记录。请求体：{"seq": N}"""
    data = request.get_json(silent=True) or {}
    seq = data.get("seq")
    if not isinstance(seq, int) or seq <= 0:
        return json.dumps({"ok": False, "error": "缺少有效的 seq"}, ensure_ascii=False), 400
    # 互斥守卫：Mock 运行中录制库已冻结（快照模型），与导入/清空保持一致
    if state.mock_manager.running:
        return json.dumps(
            {"ok": False, "error": "Mock 运行中，录制库已锁定；请先停止 Mock 再删除"},
            ensure_ascii=False,
        ), 400
    if not state.store.remove(seq):
        return json.dumps({"ok": False, "error": "记录不存在或已删除"}, ensure_ascii=False), 404
    _broadcast_snapshot()
    return json.dumps({"ok": True}, ensure_ascii=False)


def _broadcast_snapshot():
    """把最新快照推给所有已连接的客户端，前端树/详情自动刷新。"""
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


def _json_err(error, status):
    """统一的错误 JSON 响应（带正确 Content-Type）。"""
    return Response(
        json.dumps({"ok": False, "error": error}, ensure_ascii=False),
        status=status,
        mimetype="application/json",
    )


@app.post("/api/request/mark")
def api_request_mark():
    """更新记录级标记（备注 note / 标签 tags）。请求体：{"seq": N, "note"?: str, "tags"?: [str]}"""
    data = request.get_json(silent=True) or {}
    seq = data.get("seq")
    if not isinstance(seq, int) or seq <= 0:
        return json.dumps({"ok": False, "error": "缺少有效的 seq"}, ensure_ascii=False), 400
    note = data.get("note")
    tags = data.get("tags")
    if note is not None and not isinstance(note, str):
        return json.dumps({"ok": False, "error": "note 必须是字符串"}, ensure_ascii=False), 400
    if tags is not None:
        if not isinstance(tags, list):
            return json.dumps({"ok": False, "error": "tags 必须是字符串数组"}, ensure_ascii=False), 400
        tags = [str(t).strip() for t in tags if str(t).strip()]
    if not state.store.set_mark(seq, note=note, tags=tags):
        return json.dumps({"ok": False, "error": "记录不存在或已删除"}, ensure_ascii=False), 404
    _broadcast_snapshot()
    return json.dumps({"ok": True}, ensure_ascii=False)


@app.post("/api/request/annotate")
def api_request_annotate():
    """设置/删除字段级注释。请求体：{"seq": N, "target": "req"|"res", "path": "a.b.0.c", "note": "注释或空串删除"}"""
    data = request.get_json(silent=True) or {}
    seq = data.get("seq")
    target = data.get("target")
    path = data.get("path")
    note = data.get("note")
    if not isinstance(seq, int) or seq <= 0:
        return json.dumps({"ok": False, "error": "缺少有效的 seq"}, ensure_ascii=False), 400
    if target not in ("req", "res"):
        return json.dumps({"ok": False, "error": "target 必须是 req 或 res"}, ensure_ascii=False), 400
    if not isinstance(path, str) or not path.strip():
        return json.dumps({"ok": False, "error": "缺少有效的 path"}, ensure_ascii=False), 400
    if note is not None and not isinstance(note, str):
        return json.dumps({"ok": False, "error": "note 必须是字符串"}, ensure_ascii=False), 400
    if not state.store.set_annotation(seq, target, path.strip(), (note or "").strip()):
        return json.dumps({"ok": False, "error": "记录不存在或已删除"}, ensure_ascii=False), 404
    _broadcast_snapshot()
    return json.dumps({"ok": True}, ensure_ascii=False)


@app.post("/api/request/edit")
def api_request_edit():
    """编辑请求数据（造数据用）：修改 URL / 请求头 / 请求体。
    请求体：{"seq":N, "url"?:str, "req_headers"?:str(JSON 文本), "req_body"?:str}
    修改 URL 时自动重算 scheme/host/registered_domain/path/query，保持左侧树分组与导出一致。
    与删除/导入一致，Mock 运行中冻结录制库，拒绝编辑。"""
    data = request.get_json(silent=True) or {}
    seq = data.get("seq")
    if not isinstance(seq, int) or seq <= 0:
        return _json_err("缺少有效的 seq", 400)
    if state.mock_manager.running:
        return _json_err("Mock 运行中，录制库已锁定；请先停止 Mock 再编辑", 400)
    rec = state.store.get(seq)
    if rec is None:
        return _json_err("记录不存在或已删除", 404)

    new_url = data.get("url")
    if new_url is not None:
        new_url = str(new_url).strip()
        if not new_url:
            return _json_err("URL 不能为空", 400)
        parsed = urlparse(new_url)
        if not parsed.scheme or not parsed.netloc:
            return _json_err("URL 格式无效（需含 http(s)://host）", 400)
        rec["url"] = new_url
        rec["scheme"] = parsed.scheme
        rec["host"] = parsed.netloc
        rec["registered_domain"] = _registered_domain(new_url) or parsed.netloc
        rec["path"] = parsed.path
        rec["query"] = parsed.query

    hdr_raw = data.get("req_headers")
    if hdr_raw is not None:
        try:
            hdr = json.loads(hdr_raw) if str(hdr_raw).strip() else {}
        except Exception as e:
            return _json_err(f"请求头不是合法 JSON：{e}", 400)
        if not isinstance(hdr, dict):
            return _json_err("请求头必须是 JSON 对象", 400)
        rec.setdefault("request", {})["headers"] = {str(k): str(v) for k, v in hdr.items()}

    body_raw = data.get("req_body")
    if body_raw is not None:
        rec.setdefault("request", {})["post_data"] = str(body_raw)

    _broadcast_snapshot()
    return Response(json.dumps({"ok": True}, ensure_ascii=False), mimetype="application/json")


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
            "mock_port": USER_CONFIG.get("mock_port"),
            "running_port": request.host.split(":")[1] if ":" in request.host else "80",
            "browser_options": ["auto", "chrome", "edge"],
            "last_source_har": USER_CONFIG.get("last_source_har"),
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
    mock_port = data.get("mock_port")
    if mock_port is not None:
        try:
            mock_port = int(mock_port)
            if not (1 <= mock_port <= 65535):
                raise ValueError("端口范围 1-65535")
        except (TypeError, ValueError) as e:
            return json.dumps({"ok": False, "error": f"Mock 端口无效：{e}"}, ensure_ascii=False), 400
    # 读取现有配置并覆写字段，避免丢失其他键
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
    if mock_port is None:
        cfg.pop("mock_port", None)
    else:
        cfg["mock_port"] = mock_port
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


def _export_content(fmt, desensitize, mask_cfg):
    """生成导出文本内容，返回 (text, ext)。与 /api/export 共用生成逻辑。"""
    if fmt == "json":
        return json.dumps(
            state.store.export_json(desensitize=desensitize, mask_cfg=mask_cfg), ensure_ascii=False
        ), "json"
    return json.dumps(
        state.store.export_har(desensitize=desensitize, mask_cfg=mask_cfg), ensure_ascii=False
    ), "har"


def _save_export_file(text, filename):
    """把文本写到 EXPORT_DIR（避免重名覆盖：已存在则追加序号），返回绝对路径。"""
    dst = EXPORT_DIR / filename
    if dst.exists():
        stem, ext = os.path.splitext(filename)
        i = 1
        while (EXPORT_DIR / f"{stem}({i}){ext}").exists():
            i += 1
        dst = EXPORT_DIR / f"{stem}({i}){ext}"
    dst.write_text(text, encoding="utf-8")
    return str(dst.resolve())


@app.post("/api/export/save")
def api_export_save():
    """导出并直接落盘到 EXPORT_DIR，返回绝对路径（可靠、不依赖 WebView2 下载）。"""
    data = request.get_json(silent=True) or {}
    fmt = (data.get("format") or "har").lower()
    if fmt not in ("har", "json"):
        return _json_err("format 仅支持 har / json", 400)
    desensitize = bool(data.get("desensitize"))
    mask_cfg = None
    if desensitize:
        mask_cfg = {}
        for key in ("cjk", "digit", "alpha"):
            v = data.get(key)
            if v is not None and str(v) != "":
                mask_cfg[key] = str(v)
    text, ext = _export_content(fmt, desensitize, mask_cfg)
    ts = _time.strftime("%Y%m%d-%H%M%S")
    path = _save_export_file(text, f"api-recording-{ts}.{ext}")
    return Response(json.dumps({"ok": True, "path": path}, ensure_ascii=False), mimetype="application/json")


@app.post("/api/open")
def api_open():
    """在资源管理器中打开并选中指定文件。仅允许 EXPORT_DIR 内，防止越权打开任意路径。"""
    data = request.get_json(silent=True) or {}
    path = data.get("path") or ""
    try:
        p = Path(path).resolve()
    except Exception:
        return _json_err("路径无效", 400)
    if p.parent != EXPORT_DIR.resolve() or not p.exists():
        return _json_err("只能打开导出目录内的文件", 400)
    try:
        os.startfile(str(p)) if hasattr(os, "startfile") else _subprocess_explorer(p)
        return Response(json.dumps({"ok": True}, ensure_ascii=False), mimetype="application/json")
    except Exception as e:
        return _json_err(f"打开失败：{e}", 500)


def _subprocess_explorer(p):
    import subprocess
    subprocess.Popen(["explorer", "/select,", str(p)])


@app.post("/api/file/save")
def api_file_save():
    """把任意文本/二进制内容（如单条响应体「下载文件」）落盘到 EXPORT_DIR，返回绝对路径。"""
    data = request.get_json(silent=True) or {}
    content = data.get("content")
    if content is None:
        return _json_err("缺少 content", 400)
    filename = (data.get("filename") or "download.txt").replace("\\", "_").replace("/", "_")
    # 内容可能含非 BMP 字符，统一以 utf-8 写文本
    path = _save_export_file(str(content), filename)
    return Response(json.dumps({"ok": True, "path": path}, ensure_ascii=False), mimetype="application/json")


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


@app.post("/api/export_mock/save")
def api_export_mock_save():
    """生成 Mock 脚本并落盘到 EXPORT_DIR，返回绝对路径。"""
    records = _mock_records()
    if not records:
        return _json_err("没有可模拟的 API 录制（仅 XHR/FETCH 类型会被导出，请先录制接口调用）", 400)
    data_json = json.dumps(records, ensure_ascii=False)
    script = MOCK_TEMPLATE.replace("__DATA__", data_json)
    ts = _time.strftime("%Y%m%d-%H%M%S")
    path = _save_export_file(script, f"mock_server-{ts}.py")
    return Response(json.dumps({"ok": True, "path": path}, ensure_ascii=False), mimetype="application/json")


# ---------------- 进程内 Mock 服务（点按钮直接起，无需导出脚本） ----------------
@app.post("/api/mock/start")
def api_mock_start():
    data = request.get_json(silent=True) or {}
    # 互斥守卫：正在录制时不允许启动 Mock（快照模型下两者不能共存）
    if state.browser_manager._running:
        return Response(
            json.dumps(
                {"ok": False, "error": "请先停止录制，再启动 Mock（录制与 Mock 不能同时进行）"},
                ensure_ascii=False,
            ),
            status=400, mimetype="application/json",
        )
    port = data.get("port")
    if port is not None:
        try:
            port = int(port)
        except (TypeError, ValueError):
            return Response(
                json.dumps({"ok": False, "error": "端口无效"}, ensure_ascii=False),
                status=400, mimetype="application/json",
            )
    else:
        # 前端未指定端口时，回退到配置里的 mock_port（再不行由 MockManager 随机分配）。
        port = MOCK_PORT
    res = state.mock_manager.start(port)
    if res.get("ok"):
        # 与 status()/stop 返回格式保持统一，带上 running 字段，
        # 否则前端 updateMockUI 靠 info.running 判断会误判为未启动。
        res["running"] = True
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


@app.route("/api/mock/apis", methods=["GET", "POST"])
def api_mock_apis():
    """返回正在模拟的接口清单（供前端展示列表）。"""
    m = state.mock_manager
    return Response(
        json.dumps(
            {"running": m.running, "url": m._url(), "apis": m.apis()},
            ensure_ascii=False,
        ),
        mimetype="application/json",
    )


@app.route("/api/mock/logs", methods=["GET", "POST"])
def api_mock_logs():
    """返回 Mock 处理记录（收到的请求 + 返回数据），最新在前。"""
    m = state.mock_manager
    return Response(
        json.dumps(
            {"running": m.running, "logs": m.logs_list()},
            ensure_ascii=False,
        ),
        mimetype="application/json",
    )


@app.post("/api/mock/test")
def api_mock_test():
    """快速测试某条 mock 接口：由主服务代理请求到 mock 端口，避开跨域(CORS)。

    请求体：{"method": "GET", "path": "/v1/x", "query": "a=1"}
    返回：{"ok": true, "status": 200, "ms": 12, "body": "..."} 或错误。
    """
    m = state.mock_manager
    if not m.running:
        return Response(
            json.dumps({"ok": False, "error": "Mock 未运行"}, ensure_ascii=False),
            status=400, mimetype="application/json",
        )
    data = request.get_json(silent=True) or {}
    method = (data.get("method") or "GET").upper()
    path = data.get("path") or "/"
    query = data.get("query") or ""
    base = (m._url() or "").rstrip("/")
    url = base + path
    if query:
        url += "?" + query
    t0 = _time.time()
    try:
        req = urllib.request.Request(url, method=method)
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8", "replace")
            code = resp.getcode()
        ms = int((_time.time() - t0) * 1000)
        return Response(
            json.dumps(
                {"ok": True, "status": code, "ms": ms, "body": body[:3000]},
                ensure_ascii=False,
            ),
            mimetype="application/json",
        )
    except urllib.error.HTTPError as e:
        # 404 等也是"正常响应"，如实返回状态码
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        ms = int((_time.time() - t0) * 1000)
        return Response(
            json.dumps(
                {"ok": True, "status": e.code, "ms": ms, "body": body[:3000]},
                ensure_ascii=False,
            ),
            mimetype="application/json",
        )
    except Exception as e:
        ms = int((_time.time() - t0) * 1000)
        return Response(
            json.dumps({"ok": False, "error": str(e), "ms": ms}, ensure_ascii=False),
            status=500, mimetype="application/json",
        )


@app.post("/api/mock/pin")
def api_mock_pin():
    """固定/取消固定某条记录作为 Mock 返回（同一 method+path 只保留一个固定项）。
    请求体：{"seq": 12, "pinned": true}。运行中时实时重建匹配表，未运行时仅记录标记、下次启动生效。"""
    data = request.get_json(silent=True) or {}
    seq = data.get("seq")
    pinned = bool(data.get("pinned"))
    if not isinstance(seq, int):
        return Response(
            json.dumps({"ok": False, "error": "seq 无效"}, ensure_ascii=False),
            status=400, mimetype="application/json",
        )
    ok = state.store.set_pin(seq, pinned)
    if not ok:
        return Response(
            json.dumps({"ok": False, "error": "记录不存在"}, ensure_ascii=False),
            status=400, mimetype="application/json",
        )
    state.mock_manager.rebuild()
    return Response(json.dumps({"ok": True}, ensure_ascii=False), mimetype="application/json")


def _import_files(files):
    """公共导入逻辑（多文件 / 单文件 / base64 打开共用）：
    两阶段原子导入——先全部解析+格式识别+结构校验（不碰 store），
    有任一坏文件则整体拒绝（现有数据不丢），全部合法才 clear 一次后合并追加。
    返回 (ok: bool, resp: dict, status: int)。"""
    files = [f for f in files if f is not None and f.filename]
    if not files:
        return False, {"ok": False, "error": "未收到文件"}, 400

    parsed = []  # (filename, kind, obj)
    errors = []
    for f in files:
        try:
            # utf-8-sig：兼容带 UTF-8 BOM 的 HAR（Chrome/Fiddler 导出偶尔带）
            obj = json.loads(f.read().decode("utf-8-sig", "replace"))
        except Exception as e:
            errors.append(f"{f.filename}：不是合法 JSON/HAR（{e}）")
            continue
        if (
            isinstance(obj, dict)
            and isinstance(obj.get("log"), dict)
            and isinstance(obj["log"].get("entries"), list)
        ):
            parsed.append((f.filename, "HAR", obj))
        elif isinstance(obj, dict) and isinstance(obj.get("requests"), list):
            parsed.append((f.filename, "JSON", obj))
        else:
            errors.append(f"{f.filename}：无法识别文件格式（既不是本工具 JSON，也不是 HAR）")

    if errors:
        return False, {"ok": False, "error": "以下文件无法导入：\n" + "\n".join(errors)}, 400
    if not parsed:
        return False, {"ok": False, "error": "未识别到任何可导入的文件"}, 400

    total = 0
    kinds = []
    try:
        state.store.clear_all()
        for _fn, kind, obj in parsed:
            if kind == "HAR":
                n = state.store.import_from_har(obj, clear=False)
            else:
                n = state.store.import_from_json(obj, clear=False)
            if n > 0 and kind not in kinds:
                kinds.append(kind)
            total += n
    except Exception as e:
        return False, {"ok": False, "error": f"导入失败：{e}"}, 500

    _broadcast_snapshot()
    return True, {"ok": True, "kind": "+".join(kinds) or "HAR", "count": total, "files": len(parsed)}, 200


class _MemoryFile:
    """内存文件对象（给 _import_files 用，模拟 flask FileStorage 的最小接口）。"""

    def __init__(self, filename, data):
        self.filename = filename
        self._d = data

    def read(self):
        return self._d


@app.post("/api/import")
def api_import():
    # 支持多文件：FormData 里多个 "files"；兼容旧的单个 "file" 字段
    files = request.files.getlist("files")
    if not files:
        f = request.files.get("file")
        files = [f] if f is not None else []
    ok, resp, status = _import_files(files)
    # 上传导入拿不到完整路径，不可再「保存」覆盖旧文件：清空来源关联
    if ok:
        state.store.source_path = None
        try:
            cfg = USER_CONFIG
            if cfg.get("last_source_har"):
                cfg["last_source_har"] = ""
                with open(CONFIG_FILE, "w", encoding="utf-8") as fh:
                    json.dump(cfg, fh, ensure_ascii=False, indent=2)
        except Exception:
            pass
    return json.dumps(resp, ensure_ascii=False), status


@app.post("/api/import_base64")
def api_import_base64():
    """「打开」流程：前端经 pywebview 原生打开对话框拿到真实路径 + base64 内容，
    这里导入并记录来源路径（之后「保存」可直接覆盖写回该文件）。
    请求体：{"name", "content_b64", "source_path"}"""
    data = request.get_json(silent=True) or {}
    name = data.get("name") or "imported.har"
    content_b64 = data.get("content_b64") or ""
    source_path = data.get("source_path") or ""
    try:
        raw = base64.b64decode(content_b64)
    except Exception as e:
        return json.dumps({"ok": False, "error": f"内容解码失败：{e}"}, ensure_ascii=False), 400
    ok, resp, status = _import_files([_MemoryFile(name, raw)])
    if ok:
        state.store.source_path = source_path or None
        if source_path:
            try:
                cfg = USER_CONFIG
                cfg["last_source_har"] = source_path
                with open(CONFIG_FILE, "w", encoding="utf-8") as fh:
                    json.dump(cfg, fh, ensure_ascii=False, indent=2)
            except Exception:
                pass
        resp["source_path"] = source_path
    return json.dumps(resp, ensure_ascii=False), status


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
