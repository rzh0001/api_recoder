# -*- coding: utf-8 -*-
"""验证 match_mode 端到端匹配行为：默认严格（无 body 不命中），配置 match_mode=false 后回退命中。"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import config, state


def _assert(name, cond, extra=None):
    if not cond:
        print("FAIL:", name, extra or "")
        raise SystemExit(1)
    print("ok:", name)


def _rec(method, path, query, body, post_data=None, status=200):
    return {
        "url": "http://x" + path + (("?" + query) if query else ""),
        "host": "x", "registered_domain": "x",
        "path": path, "query": query, "method": method,
        "resource_type": "XHR", "is_failed": False, "fail_info": None,
        "request": {"headers": {}, "post_data": post_data, "post_size": 0},
        "response": {
            "status": status, "status_text": "OK",
            "headers": {"Content-Type": "application/json"},
            "mime_type": "application/json", "body": body,
            "body_size": len(body), "size_bytes": len(body),
        },
        "timing": {}, "duration_ms": 1,
    }


def main():
    state.store.set_persist(None)  # 测试隔离
    state.store.clear_all()
    state.store.add(_rec("GET", "/api/x", "", json.dumps({"v": 1}), post_data=json.dumps({"v": 1})))
    state.store.add(_rec("GET", "/api/x", "a=9", json.dumps({"v": 3}), post_data=json.dumps({"v": 3})))

    tmp = Path(tempfile.mkdtemp()) / "config.json"
    config.CONFIG_FILE = tmp

    m = state.mock_manager

    # 1) 默认严格（config.json 为空）：无 body 不命中；精确 body 才命中
    tmp.write_text(json.dumps({}), encoding="utf-8")
    _assert("默认严格：无 body 不命中", m.match("GET", "/api/x", "") is None)
    _assert("默认严格：精确 body 命中", m.match("GET", "/api/x", "", json.dumps({"v": 1})) is not None)
    _assert("默认严格：query 不同且无 body 不命中", m.match("GET", "/api/x", "a=9") is None)
    _assert("默认严格：query+body 全精确命中", m.match("GET", "/api/x", "a=9", json.dumps({"v": 3})) is not None)

    # 2) 模糊匹配（启动 Mock 时配置 match_mode=false -> _make_app 传 strict=False）：
    #    无 body 也回退命中 method+path；有 query 时精确优先
    tmp.write_text(json.dumps({"match_mode": False}), encoding="utf-8")
    _assert("配置模糊：get_match_mode() 为 False", config.get_match_mode() is False)
    _assert("配置模糊：无 body 回退命中", m.match("GET", "/api/x", "", strict=False) is not None)
    _assert("配置模糊：不同 query 精确优先", m.match("GET", "/api/x", "a=9", strict=False).get("req_body") == json.dumps({"v": 3}))

    # 3) match() 默认参数即严格
    _assert("match() 默认 strict=True", m.match.__defaults__[1] is True)

    # 4) miss_reason 未命中原因定位
    r1 = m.miss_reason("GET", "/api/nope", "", "")
    _assert("未命中原因：库中无此接口", "库中无此接口" in r1, r1)
    r2 = m.miss_reason("GET", "/api/x", "q=1", "")
    _assert("未命中原因：query 均不匹配", "query 均不匹配" in r2 and "q=1" in r2, r2)
    r3 = m.miss_reason("GET", "/api/x", "", "")
    _assert("未命中原因：请求未携带请求体", "请求未携带请求体" in r3, r3)
    r4 = m.miss_reason("GET", "/api/x", "", json.dumps({"v": 1, "w": 2}))
    _assert("未命中原因：请求多出键 w", "请求多出键: w" in r4, r4)
    r5 = m.miss_reason("GET", "/api/x", "", json.dumps({"x": 1}))
    _assert("未命中原因：记录多出键 v", "记录多出键: v" in r5, r5)
    r6 = m.miss_reason("GET", "/api/x", "", json.dumps({"v": 99}))
    _assert("未命中原因：键一致但值不同", "键一致但值不同" in r6, r6)
    r7 = m.miss_reason("GET", "/api/x", "", json.dumps({"a": 1, "b": 2}))
    _assert("未命中原因：同时多出/缺失键", "请求多出键: a, b" in r7 and "记录多出键: v" in r7, r7)

    # 5) 端到端：真实请求 Mock 服务，未命中日志带 miss_reason
    import urllib.error
    import urllib.request
    tmp.write_text(json.dumps({}), encoding="utf-8")  # 严格模式
    r = m.start()
    assert r.get("ok"), r
    try:
        req = urllib.request.Request(r["url"].rstrip("/") + "/api/x", method="GET")
        try:
            urllib.request.urlopen(req, timeout=5)
            _assert("端到端：未命中返回 404", False, "意外命中")
        except urllib.error.HTTPError as e:
            _assert("端到端：未命中返回 404", e.code == 404)
        logs = m.logs_list()
        _assert("端到端：日志含 miss_reason", bool(logs) and logs[0].get("miss_reason") and not logs[0]["matched"], logs[0] if logs else None)
        _assert("端到端：miss_reason 为请求未携带请求体", bool(logs) and "请求未携带请求体" in logs[0]["miss_reason"], logs[0]["miss_reason"] if logs else None)
    finally:
        m.stop()

    print("\nALL PASS: test_match_mode_behavior")


if __name__ == "__main__":
    main()
