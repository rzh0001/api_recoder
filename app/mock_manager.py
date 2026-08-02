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
            "response": {
                "status": resp.get("status", 200),
                "headers": resp.get("headers") or {},
                "body": resp.get("body"),
            },
        })
    return out


def _make_app(data):
    app = Flask("mock")
    app.url_map.strict_slashes = False

    def find_match(method, path, query_str):
        path = _norm(path)
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
            return Response("", status=404, headers={"Content-Type": "text/plain; charset=utf-8"})
        resp = m.get("response") or {}
        body = resp.get("body") or ""
        if not isinstance(body, str):
            body = json.dumps(body, ensure_ascii=False)
        headers = {k: v for k, v in (resp.get("headers") or {}).items() if k.lower() not in EXCLUDE_HEADERS}
        return Response(body, status=resp.get("status", 200), headers=headers)

    return app


class MockManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._srv = None
        self._thread = None
        self.host = "127.0.0.1"
        self.port = None
        self.data = []
        self.started_at = None

    @property
    def running(self):
        return self._srv is not None

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
            app = _make_app(data)
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
                    "status": (r.get("response") or {}).get("status", 200),
                }
                for r in self.data
            ]

    def _url(self):
        if self.port is None:
            return None
        return "http://%s:%d/" % (self.host, self.port)
