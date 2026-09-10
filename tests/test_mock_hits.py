# -*- coding: utf-8 -*-
"""验证 Mock 命中计数与「按 seq 测试记录」：
- 每条记录命中（被 mock 返回给调用方）后 /api/mock/apis 的 hits 实时 +1；
- /api/mock/test 支持 {seq} 直接用记录自身的 method/path/query/请求体测试；
- 404 未命中时响应附 miss_reason；
- Mock 停止后命中计数清零。
"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import config, state, server

_tmp = Path(tempfile.mkdtemp()) / "config.json"
_tmp.write_text(json.dumps({"match_mode": False}, ensure_ascii=False), encoding="utf-8")
config.CONFIG_FILE = _tmp


def make_rec(method, path, query, body, status=200, post_data=None):
    return {
        "url": "http://x" + path + (("?" + query) if query else ""),
        "host": "x", "registered_domain": "x",
        "path": path, "query": query, "method": method,
        "resource_type": "XHR", "is_failed": False, "fail_info": None,
        "request": {"headers": {}, "post_data": post_data, "post_size": len(post_data or "")},
        "response": {
            "status": status, "status_text": "OK",
            "headers": {"Content-Type": "application/json"},
            "mime_type": "application/json", "body": body,
            "body_size": len(body), "size_bytes": len(body),
        },
        "timing": {}, "duration_ms": 1,
    }


def hits_of(client, seq):
    for a in client.get("/api/mock/apis").get_json()["apis"]:
        if a["seq"] == seq:
            return a["hits"]
    return None


def main():
    state.store.set_persist(None)
    state.store.clear_all()
    s1 = state.store.add(make_rec("GET", "/api/x", "", json.dumps({"v": 1})))
    s2 = state.store.add(make_rec("GET", "/api/x", "", json.dumps({"v": 2})))
    state.mock_manager.start()
    client = server.app.test_client()

    # 初始命中为 0
    assert hits_of(client, s1) == 0 and hits_of(client, s2) == 0

    # seq 模式测试 s1：命中 s1，hits +1
    d = client.post("/api/mock/test", json={"seq": s1}).get_json()
    assert d["ok"] and d["status"] == 200 and '"v": 1' in d["body"], d
    assert hits_of(client, s1) == 1 and hits_of(client, s2) == 0

    # 通用模式手动打 GET /api/x（无 body）→ 命中同 query 最早一条（s1）
    d2 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert d2["ok"] and '"v": 1' in d2["body"], d2
    assert hits_of(client, s1) == 2 and hits_of(client, s2) == 0

    # pin s2 后再按 seq 测试 s2：命中 s2
    client.post("/api/mock/pin", json={"seq": s2, "pinned": True})
    d3 = client.post("/api/mock/test", json={"seq": s2}).get_json()
    assert d3["ok"] and '"v": 2' in d3["body"], d3
    assert hits_of(client, s2) == 1

    # 不存在的 seq：400
    r = client.post("/api/mock/test", json={"seq": 99999}).get_json()
    assert not r["ok"], r

    # 未命中：404 + miss_reason 定位原因
    d4 = client.post("/api/mock/test", json={"method": "GET", "path": "/nope", "query": ""}).get_json()
    assert d4["ok"] and d4["status"] == 404 and d4["miss_reason"], d4
    assert "method+path" in d4["miss_reason"], d4

    # POST 记录：seq 模式会带请求体（body 不一致不会命中同 query 其它 GET 记录）
    s3 = state.store.add(make_rec("POST", "/api/save", "", json.dumps({"s": True}), post_data='{"a":1}'))
    d5 = client.post("/api/mock/test", json={"seq": s3}).get_json()
    assert d5["ok"] and d5["status"] == 200 and '"s": true' in d5["body"], d5
    assert hits_of(client, s3) == 1

    # Mock 停止：命中计数清零
    state.mock_manager.stop()
    assert hits_of(client, s3) == 0, hits_of(client, s3)
    print("ALL PASS")


if __name__ == "__main__":
    main()
