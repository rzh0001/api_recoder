# -*- coding: utf-8 -*-
"""进程内 Mock 服务管理：把录制到的 XHR/FETCH 接口直接起成一个本地 Flask 服务。

- start()：从当前录制快照构建匹配表，在独立端口起一个 Werkzeug 服务线程。
- stop()：shutdown 服务线程。
- status()：返回运行状态 / URL / 接口数。
匹配规则与「导出 Mock 脚本」一致：method+path+query 精确 → method+path → 404。
"""
import json
import threading
import time

from flask import Flask, request, Response
from werkzeug.serving import make_server

EXCLUDE_HEADERS = {
    "content-length", "content-encoding", "transfer-encoding", "connection",
}

# 处理记录（收到的请求 + 返回数据）最多保留条数，超出丢最旧
MAX_MOCK_LOGS = 500


def _norm(p):
    return p if p.startswith("/") else "/" + p


def _build_data():
    # 延迟导入，避免与 state 形成循环依赖
    from . import state

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
            "seq": r.get("seq"),
            "note": r.get("note") or "",
            "tags": r.get("tags") or [],
            "mock_pin": bool(r.get("mock_pin")),
            "url": r.get("url") or "",
            "response": {
                "status": resp.get("status", 200),
                "headers": resp.get("headers") or {},
                "body": resp.get("body"),
            },
        })
    return out


def _make_app(manager):
    app = Flask("mock")
    app.url_map.strict_slashes = False

    def find_match(method, path, query_str):
        data = manager.data  # 每次请求动态读取，rebuild() 重新赋值后才能实时生效
        path = _norm(path)
        # 优先返回被「固定(pin)」的记录（与未固定时保持一致的两级匹配：精确 query → 仅 method+path）
        for r in data:
            if r.get("mock_pin") and r.get("method") == method and _norm(r.get("path", "")) == path and (r.get("query") or "") == query_str:
                return r
        for r in data:
            if r.get("mock_pin") and r.get("method") == method and _norm(r.get("path", "")) == path:
                return r
        for r in data:
            if r.get("method") == method and _norm(r.get("path", "")) == path and (r.get("query") or "") == query_str:
                return r
        for r in data:
            if r.get("method") == method and _norm(r.get("path", "")) == path:
                return r
        return None

    @app.route("/", defaults={"path": ""}, methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
    @app.route("/<path:path>", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
    def mock(path):
        m = find_match(request.method, "/" + path, request.query_string.decode("utf-8", "replace"))
        if not m:
            status = 404
            body = ""
            headers = {"Content-Type": "text/plain; charset=utf-8"}
        else:
            resp = m.get("response") or {}
            body = resp.get("body") or ""
            if not isinstance(body, str):
                body = json.dumps(body, ensure_ascii=False)
            headers = {k: v for k, v in (resp.get("headers") or {}).items() if k.lower() not in EXCLUDE_HEADERS}
            status = resp.get("status", 200)

        # 记录处理日志（收到的请求 + 返回数据），供界面点击查看
        try:
            from . import state
            req_body = request.get_data(cache=True)
            if isinstance(req_body, bytes):
                req_body = req_body.decode("utf-8", "replace")
            state.mock_manager.log_request({
                "ts": time.time(),
                "method": request.method,
                "path": _norm(path) or "/",
                "query": request.query_string.decode("utf-8", "replace"),
                "url": request.url,
                "matched": bool(m),
                "status": status,
                "req_headers": {k: v for k, v in request.headers.items()},
                "req_body": req_body[:65536],
                "res_headers": headers,
                "res_body": body[:65536],
            })
            state.broadcast(json.dumps({"type": "mock_log"}, ensure_ascii=False))
        except Exception:
            pass

        return Response(body, status=status, headers=headers)

    return app


class MockManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._srv = None
        self._thread = None
        self.host = "127.0.0.1"
        self.port = None
        self.data = []
        self.logs = []  # 处理记录（最新追加，logs_list 倒序返回）
        self.started_at = None

    def log_request(self, entry):
        """追加一条处理记录；超出 MAX_MOCK_LOGS 丢最旧。"""
        with self._lock:
            self.logs.append(entry)
            if len(self.logs) > MAX_MOCK_LOGS:
                self.logs = self.logs[-MAX_MOCK_LOGS:]

    def logs_list(self):
        """返回处理记录（最新在前）。"""
        with self._lock:
            return list(reversed(self.logs))

    @property
    def running(self):
        return self._srv is not None

    def rebuild(self):
        """运行中时按最新录制库重建匹配表（固定/取消固定后实时生效）。未运行时为空操作。"""
        with self._lock:
            if not self.running:
                return
            self.data = _build_data()

    def start(self, port=None):
        with self._lock:
            if self.running:
                return {
                    "ok": True, "already_running": True,
                    "url": self._url(), "port": self.port, "count": len(self.data),
                }
            data = _build_data()
            if not data:
                return {
                    "ok": False,
                    "error": "没有可模拟的 API 录制（仅 XHR/FETCH 类型会被模拟，请先录制接口调用）",
                }
            app = _make_app(self)
            # 优先用请求端口；占用或为空时回退到系统分配空闲端口(0)
            candidates = [port] if port else []
            candidates.append(0)
            srv = None
            for p in candidates:
                try:
                    srv = make_server(self.host, p, app, threaded=True)
                    break
                except OSError:
                    srv = None
            if srv is None:
                return {"ok": False, "error": "无法绑定端口（%s）" % port}
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            self._srv = srv
            self._thread = t
            self.port = srv.server_address[1]
            self.data = data
            self.logs = []
            self.started_at = time.time()
            return {"ok": True, "url": self._url(), "port": self.port, "count": len(data)}

    def stop(self):
        with self._lock:
            if not self.running:
                return {"ok": True, "running": False}
            try:
                self._srv.shutdown()
            except Exception:
                pass
            try:
                self._thread.join(timeout=3)
            except Exception:
                pass
            self._srv = None
            self._thread = None
            self.port = None
            self.data = []
            self.logs = []
            self.started_at = None
            return {"ok": True, "running": False}

    def status(self):
        with self._lock:
            if not self.running:
                return {"running": False, "count": 0}
            return {
                "running": True,
                "url": self._url(),
                "port": self.port,
                "count": len(self.data),
                "started_at": self.started_at,
            }

    def apis(self):
        """返回当前正在模拟的接口清单（给前端展示列表用）。"""
        with self._lock:
            return [
                {
                    "method": r.get("method"),
                    "path": r.get("path") or "",
                    "query": r.get("query") or "",
                    "seq": r.get("seq"),
                    "mock_pin": bool(r.get("mock_pin")),
                    "status": (r.get("response") or {}).get("status", 200),
                    "note": r.get("note") or "",
                    "tags": r.get("tags") or [],
                }
                for r in self.data
            ]

    def _url(self):
        if self.port is None:
            return None
        return "http://%s:%d/" % (self.host, self.port)
