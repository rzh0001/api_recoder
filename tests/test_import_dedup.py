# -*- coding: utf-8 -*-
"""验证导入去重：按 method+path+query+请求体+返回体语义（JSON 键序无关）判断重复并跳过。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import state, server


def _assert(name, cond, extra=None):
    if not cond:
        print("FAIL:", name, extra or "")
        raise SystemExit(1)
    print("ok:", name)


def _har(method, path, query, post, resp_body, status=200):
    return {
        "log": {"entries": [{
            "request": {
                "method": method,
                "url": "http://x" + path + (("?" + query) if query else ""),
                "headers": [],
                "postData": {"text": post} if post is not None else {},
                "bodySize": len(post or ""),
            },
            "response": {
                "status": status, "statusText": "OK", "headers": [],
                "content": {"text": resp_body, "mimeType": "application/json", "size": len(resp_body or "")},
            },
            "time": 1, "timings": {},
        }]}
    }


def _json_recs(recs):
    return {"requests": recs}


def main():
    state.store.set_persist(None)  # 测试隔离
    state.store.clear_all()

    # 1) HAR 同内容重复导入：第二次全部去重
    har = _har("POST", "/api/x", "", json.dumps({"a": 1, "b": 2}), json.dumps({"ok": True}))
    n, dup = state.store.import_from_har(har, clear=False)
    _assert("首次导入 1 条", n == 1 and dup == 0, (n, dup))
    n, dup = state.store.import_from_har(har, clear=False)
    _assert("重复导入全去重", n == 0 and dup == 1, (n, dup))

    # 2) 请求体 JSON 键序不同但内容相同 -> 语义相等，应去重
    har2 = _har("POST", "/api/x", "", json.dumps({"b": 2, "a": 1}), json.dumps({"ok": True}))
    n, dup = state.store.import_from_har(har2, clear=False)
    _assert("请求体键序不同视为重复", n == 0 and dup == 1, (n, dup))

    # 3) 返回体不同 -> 不去重
    har3 = _har("POST", "/api/x", "", json.dumps({"a": 1, "b": 2}), json.dumps({"ok": False}))
    n, dup = state.store.import_from_har(har3, clear=False)
    _assert("返回体不同不去重", n == 1 and dup == 0, (n, dup))

    # 4) query 不同 -> 不去重
    har4 = _har("POST", "/api/x", "a=9", json.dumps({"a": 1, "b": 2}), json.dumps({"ok": True}))
    n, dup = state.store.import_from_har(har4, clear=False)
    _assert("query 不同不去重", n == 1 and dup == 0, (n, dup))

    # 5) JSON 格式导入：文件内两条相同 -> 去重 1 条
    state.store.clear_all()
    rec = {
        "url": "http://x/api/y", "host": "x", "registered_domain": "x",
        "path": "/api/y", "query": "", "method": "GET",
        "resource_type": "XHR", "is_failed": False, "fail_info": None,
        "request": {"headers": {}, "post_data": None, "post_size": 0},
        "response": {"status": 200, "status_text": "OK", "headers": {}, "body": '{"y": 1}', "body_size": 8},
        "timing": {}, "duration_ms": 1,
    }
    n, dup = state.store.import_from_json(_json_recs([rec, rec]), clear=False)
    _assert("JSON 文件内重复去重", n == 1 and dup == 1, (n, dup))

    # 6) 多文件导入（_import_files 路径）：文件间重复去重且响应带 duplicates
    state.store.clear_all()
    f1 = _har("GET", "/api/z", "", None, '{"z": 1}')
    f2 = _har("GET", "/api/z", "", None, '{"z": 1}')
    ok, resp, status = server._import_files([
        server._MemoryFile("a.har", json.dumps(f1).encode("utf-8")),
        server._MemoryFile("b.har", json.dumps(f2).encode("utf-8")),
    ])
    _assert("多文件导入 ok", ok and resp.get("ok") is True)
    _assert("多文件间去重 count=1", resp.get("count") == 1, resp)
    _assert("响应带 duplicates=1", resp.get("duplicates") == 1, resp)

    # 7) 单文件内重复条目的 HAR（同一文件两条相同 entry）
    state.store.clear_all()
    har_dup = {"log": {"entries": [
        {"request": {"method": "GET", "url": "http://x/api/w", "headers": []},
         "response": {"status": 200, "statusText": "OK", "headers": [], "content": {"text": '{"w": 1}'}},
         "time": 1, "timings": {}},
        {"request": {"method": "GET", "url": "http://x/api/w", "headers": []},
         "response": {"status": 200, "statusText": "OK", "headers": [], "content": {"text": '{"w": 1}'}},
         "time": 1, "timings": {}},
    ]}}
    n, dup = state.store.import_from_har(har_dup, clear=False)
    _assert("HAR 文件内重复去重", n == 1 and dup == 1, (n, dup))

    # 8) 增量合并：旧库数据保留；导入与旧库重复的条目被去重；新条目追加
    state.store.clear_all()
    state.store.import_from_har(_har("GET", "/api/m", "", None, '{"m": 1}'), clear=False)
    ok, resp, status = server._import_files([
        server._MemoryFile("inc.har", json.dumps(_har("GET", "/api/m", "", None, '{"m": 1}')).encode("utf-8")),
        server._MemoryFile("new.har", json.dumps(_har("GET", "/api/n", "", None, '{"n": 1}')).encode("utf-8")),
    ])
    _assert("增量合并 ok", ok and resp.get("ok") is True)
    _assert("新增 1 条（旧库重复被去重）", resp.get("count") == 1, resp)
    _assert("去重 1 条", resp.get("duplicates") == 1, resp)
    _assert("旧库数据保留", len(state.store.requests) == 2, len(state.store.requests))

    print("\nALL PASS: test_import_dedup")


if __name__ == "__main__":
    main()
