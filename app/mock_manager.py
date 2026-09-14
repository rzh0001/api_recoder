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


def _body_preview(body, limit=160):
    """响应体转字符串并截断，供列表行内预览/展开查看。"""
    if body is None:
        return ""
    if not isinstance(body, str):
        try:
            body = json.dumps(body, ensure_ascii=False)
        except Exception:
            body = str(body)
    body = body.strip()
    return body if len(body) <= limit else body[:limit] + "…"


def _body_pretty(body):
    """把响应/请求体格式化为可读 JSON（含缩进）。解析失败则原样返回。"""
    if body is None:
        return ""
    if isinstance(body, (dict, list)):
        try:
            return json.dumps(body, ensure_ascii=False, sort_keys=True, indent=2)
        except Exception:
            return str(body)
    if isinstance(body, (bytes, bytearray)):
        try:
            body = body.decode("utf-8", "replace")
        except Exception:
            return repr(body)
    if not isinstance(body, str):
        body = str(body)
    body = body.strip()
    if not body:
        return ""
    try:
        return json.dumps(json.loads(body), ensure_ascii=False, sort_keys=True, indent=2)
    except Exception:
        return body


def _norm_body(body):
    """请求体归一化为可比较对象：能解析成 JSON 则按语义(dict/list)，否则原字符串；空/None 归一为 None。"""
    if body is None:
        return None
    if not isinstance(body, str):
        return body  # 已是 dict/list，交给 == 做语义比较
    s = body.strip()
    if not s:
        return None
    try:
        return json.loads(s)
    except Exception:
        return s


def _body_equal(a, b):
    """两条请求体是否语义相等（JSON 对象键序无关）。"""
    na, nb = _norm_body(a), _norm_body(b)
    if na is None and nb is None:
        return True
    if na is None or nb is None:
        return False
    return na == nb  # dict/list 深度比较（键序无关），否则字符串比较


def _get_store():
    """延迟取 store，避免 mock_manager 与 state 循环导入。"""
    from . import state
    return state.store


def _make_app(manager):
    app = Flask("mock")
    app.url_map.strict_slashes = False

    # match_mode 真源：环境变量 > config.json > 默认严格（见 app/config.py），每次启动时动态读取
    from . import config
    strict = config.get_match_mode()

    @app.route("/", defaults={"path": ""}, methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
    @app.route("/<path:path>", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
    def mock(path):
        # 请求体（用于按请求体匹配不同返回），日志也要用，只取一次
        req_body = request.get_data(cache=True)
        if isinstance(req_body, bytes):
            req_body = req_body.decode("utf-8", "replace")
        m = manager.match(request.method, "/" + path, request.query_string.decode("utf-8", "replace"), req_body, strict=strict)
        if not m:
            # 严格模式：入参无匹配 -> 返回 404（接口在 mock 库中未找到）
            # 非严格模式：保持原回退行为，仍返回 404
            status = 404
            body = ""
            headers = {"Content-Type": "text/plain; charset=utf-8"}
            miss_reason = manager.miss_reason(
                request.method, "/" + path,
                request.query_string.decode("utf-8", "replace"), req_body)
        else:
            manager._bump_hit(m.get("seq"))
            resp = m.get("response") or {}
            body = resp.get("body") or ""
            if not isinstance(body, str):
                body = json.dumps(body, ensure_ascii=False)
            headers = {k: v for k, v in (resp.get("headers") or {}).items() if k.lower() not in EXCLUDE_HEADERS}
            status = resp.get("status", 200)

        # 记录处理日志（收到的请求 + 返回数据），供界面点击查看
        try:
            from . import state
            _np = _norm(path) or "/"
            _q = request.query_string.decode("utf-8", "replace")
            state.mock_manager.log_request({
                "ts": time.time(),
                "method": request.method,
                "path": _np,
                "query": _q,
                "url": _np + ("?" + _q if _q else ""),
                "matched": bool(m),
                "miss_reason": miss_reason if not m else None,
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
        self._hits = {}  # 运行期命中计数：seq -> 次数（start/stop 时清零）
        self.started_at = None

    def log_request(self, entry):
        """追加一条处理记录；超出 MAX_MOCK_LOGS 丢最旧。"""
        with self._lock:
            self.logs.append(entry)
            if len(self.logs) > MAX_MOCK_LOGS:
                self.logs = self.logs[-MAX_MOCK_LOGS:]

    def _bump_hit(self, seq):
        """记录一次命中（某条记录被返回给调用方）。"""
        if seq is None:
            return
        with self._lock:
            self._hits[seq] = self._hits.get(seq, 0) + 1

    def hit_of(self, seq):
        """取某条记录本运行期的命中次数。"""
        with self._lock:
            return self._hits.get(seq, 0)

    def miss_reason(self, method, path, query_str, req_body):
        """未命中时定位卡在哪个环节：method+path 无匹配 -> query 不匹配 -> 请求体不匹配。"""
        data = _get_store().get_mock_data()
        path = _norm(path)
        same_mp = [r for r in data
                   if r.get("method") == method and _norm(r.get("path", "") or "") == path]
        if not same_mp:
            return "库中无此接口（method+path 无匹配记录）"
        same_q = [r for r in same_mp if (r.get("query") or "") == query_str]
        if not same_q:
            return "同路径记录 %d 条，query 均不匹配（请求 query: %s）" % (
                len(same_mp), query_str or "空")
        nb = _norm_body(req_body)
        if nb is None:
            return "同 query 记录 %d 条，请求未携带请求体，记录均带请求体" % len(same_q)
        if isinstance(nb, dict):
            for r in same_q[:3]:
                nr = _norm_body(r.get("req_body"))
                if not isinstance(nr, dict):
                    continue
                miss = sorted(set(nb) - set(nr))
                extra = sorted(set(nr) - set(nb))
                diff = []
                if miss:
                    diff.append("请求多出键: " + ", ".join(miss))
                if extra:
                    diff.append("记录多出键: " + ", ".join(extra))
                if diff:
                    return "同 query 记录 %d 条，请求体均不匹配；与其中一条对比：%s" % (
                        len(same_q), "；".join(diff))
                return "同 query 记录 %d 条，请求体键一致但值不同（请求体: %s）" % (
                    len(same_q), _body_preview(req_body, 80))
        return "同 query 记录 %d 条，请求体均不匹配（请求体: %s）" % (
            len(same_q), _body_preview(req_body, 80))

    def logs_list(self):
        """返回处理记录（最新在前）。"""
        with self._lock:
            return list(reversed(self.logs))

    def clear_logs(self):
        """清空处理记录（不影响运行与命中计数）。"""
        with self._lock:
            self.logs = []

    @property
    def running(self):
        return self._srv is not None

    def rebuild(self):
        """实时模式下无需重建：Mock 每次匹配都直接读最新录制库，固定/编辑即时生效。"""
        return

    def start(self, port=None):
        with self._lock:
            if self.running:
                return {
                    "ok": True, "already_running": True,
                    "url": self._url(), "port": self.port, "count": len(_get_store().get_mock_data()),
                }
            # 实时读取当前录制库（不再冻结快照）；录制/编辑/Mock 可并发
            data = _get_store().get_mock_data()
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
            self._hits = {}
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
            self._hits = {}
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
                "count": len(_get_store().get_mock_data()),
                "started_at": self.started_at,
            }

    def match(self, method, path, query_str, req_body=None, strict=True):
        """按 (method, path, query, 请求体) 匹配一条录制记录，返回该记录或 None。

        默认(pin) 命中分两级，所有模式下都最高优先：
          1) 同 method+path+query 的默认 → 返回（query 精确优先，多 query 各锁各的）
          2) 同 method+path 下「唯一一条」默认 → 无视 query/body 返回
             （动态 query 接口如 ?t=时间戳：设了默认就整接口固定返回该条）
          若同 path 存在多条不同 query 的默认则不做 2)，仅各自 query 精确命中。
        之后按模式回退：
          strict=True（默认）：仅 method+path+query+请求体 精确匹配，未命中返回 None。
          strict=False（模糊）：
            1) method+path+query+请求体 精确
            2) method+path+query 精确
            3) 回退 method+path
        """
        data = _get_store().get_mock_data()
        path = _norm(path)

        pins = [r for r in data
                if r.get("mock_pin") and r.get("method") == method
                and _norm(r.get("path", "") or "") == path]
        if pins:
            for r in pins:
                if (r.get("query") or "") == query_str:
                    return r
            if len(pins) == 1:
                return pins[0]

        if strict:
            # 严格模式：仅 method+path+query+req_body 精确匹配，任何未命中一律返回 None
            for r in data:
                if (r.get("method") == method
                        and _norm(r.get("path", "")) == path
                        and (r.get("query") or "") == query_str
                        and _body_equal(r.get("req_body"), req_body)):
                    return r
            return None  # 未命中即不回退

        # 模糊 1) 请求体精确（同 query 多条、请求体不同时各自返回自己的）
        for r in data:
            if (r.get("method") == method and _norm(r.get("path", "")) == path
                    and (r.get("query") or "") == query_str
                    and _body_equal(r.get("req_body"), req_body)):
                return r
        # 模糊 2) 仅 query
        for r in data:
            if (r.get("method") == method and _norm(r.get("path", "")) == path
                    and (r.get("query") or "") == query_str):
                return r
        # 模糊 3) 回退 method+path
        for r in data:
            if r.get("method") == method and _norm(r.get("path", "")) == path:
                return r
        return None

    def apis(self):
        """返回当前正在模拟的接口清单（给前端展示列表用）。实时读取。"""
        return [
            {
                "method": r.get("method"),
                "path": r.get("path") or "",
                "query": r.get("query") or "",
                "seq": r.get("seq"),
                "mock_pin": bool(r.get("mock_pin")),
                "status": (r.get("response") or {}).get("status", 200),
                "hits": self._hits.get(r.get("seq"), 0),
                "note": r.get("note") or "",
                "tags": r.get("tags") or [],
                "body_preview": _body_preview((r.get("response") or {}).get("body"), 160),
                "body_view": _body_preview((r.get("response") or {}).get("body"), 8000),
                "body_pretty": _body_pretty((r.get("response") or {}).get("body")),
                "req_body_preview": _body_preview(r.get("req_body"), 160),
                "req_body_view": _body_preview(r.get("req_body"), 8000),
                "req_body_pretty": _body_pretty(r.get("req_body")),
            }
            for r in _get_store().get_mock_data()
        ]

    def _url(self):
        if self.port is None:
            return None
        return "http://%s:%d/" % (self.host, self.port)
