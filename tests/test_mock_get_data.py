# -*- coding: utf-8 -*-
"""Mock 数据源回归测试：验证 CaptureStore.get_mock_data() 与 mock_manager 调用链。

注意：当前 CaptureStore 为纯内存实现（__init__ 不接收 db_path，无 CaptureDB），
因此本测试仅使用真实可用的内存 API 构造 store。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app.state as state
from app.capture_store import CaptureStore
from app.mock_manager import MockManager, _make_app


def _rec(method, path, query="", status=200, body="{}", tags=None, rtype="XHR", pin=False):
    return {
        "url": f"https://h.com{path}" + (f"?{query}" if query else ""),
        "scheme": "https", "host": "h.com", "registered_domain": "h.com",
        "path": path, "query": query, "method": method, "resource_type": rtype,
        "is_failed": False, "fail_info": None,
        "request": {"headers": {"Content-Type": "application/json"}, "post_data": None, "post_size": 0},
        "response": {"status": status, "status_text": "OK", "headers": {"Content-Type": "application/json"},
                     "mime_type": "application/json", "body": body, "body_size": len(body),
                     "size_bytes": len(body), "truncated": False},
        "note": None, "tags": tags or [], "annotations": {}, "mock_pin": pin,
        "captured_at": 1700000000.0, "timing": {}, "duration_ms": 10,
    }


def _assert(cond, msg):
    if not cond:
        print("FAIL:", msg)
        raise SystemExit(1)
    print("ok:", msg)


def main():
    store = CaptureStore()
    store.add(_rec("GET", "/api/a", "", 200, '{"x":1}', ["t"]))
    store.add(_rec("POST", "/api/a", "", 201, '{"y":2}'))
    store.add(_rec("GET", "/api/b", "q=1", 200, '{"z":3}'))
    store.add(_rec("GET", "/api/doc", "", 200, '{"d":1}', rtype="DOCUMENT"))  # 非 XHR/FETCH，应排除

    # 1) get_mock_data 只返回 XHR/FETCH，且字段结构正确
    data = store.get_mock_data()
    _assert(len(data) == 3, "仅返回 3 条 XHR/FETCH 记录（排除 DOCUMENT）")
    paths = sorted(d["path"] for d in data)
    _assert(paths == ["/api/a", "/api/a", "/api/b"], "路径集合正确")
    for d in data:
        _assert("req_body" in d and "response" in d, "每条含 req_body / response 字段")
        _assert(d["response"]["status"] in (200, 201), "response.status 透传")
        _assert("method" in d and "path" in d and "query" in d, "含 method/path/query")

    # 2) mock_manager.apis() 经 _get_store().get_mock_data() 实时读取（修复 AttributeError）
    state.store = store
    mgr = MockManager()
    apis = mgr.apis()
    _assert(len(apis) == 3, "MockManager.apis() 返回 3 条（实时读取 get_mock_data 不再抛异常）")
    _assert(all("status" in a and "body_preview" in a for a in apis), "apis() 输出含渲染字段")

    # 3) _make_app 不再依赖不存在的 state.store.db（改用 config.STRICT_MODE）
    app = _make_app(mgr)
    _assert(app is not None, "_make_app 不再因 state.store.db 缺失而崩溃")

    print("\nALL PASS: test_mock_get_data")


if __name__ == "__main__":
    main()
