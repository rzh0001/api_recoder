# -*- coding: utf-8 -*-
"""验证 Mock「固定返回某一条」功能：精确到 (method, path, query)，不同 query 互不干扰。"""
import json

from app import state, server


def make_rec(method, path, query, body, status=200):
    return {
        "url": "http://x" + path + (("?" + query) if query else ""),
        "host": "x", "registered_domain": "x",
        "path": path, "query": query, "method": method,
        "resource_type": "XHR", "is_failed": False, "fail_info": None,
        "request": {"headers": {}, "post_data": None, "post_size": 0},
        "response": {
            "status": status, "status_text": "OK",
            "headers": {"Content-Type": "application/json"},
            "mime_type": "application/json", "body": body,
            "body_size": len(body), "size_bytes": len(body),
        },
        "timing": {}, "duration_ms": 1,
    }


def main():
    state.store.clear_all()
    s1 = state.store.add(make_rec("GET", "/api/x", "", json.dumps({"v": 1})))
    s2 = state.store.add(make_rec("GET", "/api/x", "", json.dumps({"v": 2})))
    s3 = state.store.add(make_rec("GET", "/api/x", "a=9", json.dumps({"v": 3})))
    state.store.add(make_rec("GET", "/api/y", "", json.dumps({"y": 1})))

    r = state.mock_manager.start()
    assert r.get("ok"), r

    client = server.app.test_client()

    # 默认：query "" 返回最早 s1(v:1)；query "a=9" 返回 s3(v:3)
    d = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 1' in d["body"], d["body"]
    d_a9 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "a=9"}).get_json()
    assert '"v": 3' in d_a9["body"], d_a9["body"]

    # 固定 s2（query ""）：同 query 返回 s2(v:2)，不同 query 不受影响（仍 s3 v:3）
    pr = client.post("/api/mock/pin", json={"seq": s2, "pinned": True}).get_json()
    assert pr.get("ok")
    d2 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 2' in d2["body"], d2["body"]
    d2b = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "a=9"}).get_json()
    assert '"v": 3' in d2b["body"], d2b["body"]  # 关键：不同 query 不被覆盖

    # /api/mock/apis 反映固定态：仅 s2 被标记；且透出 seq/query/mock_pin 供前端分组
    apis = client.get("/api/mock/apis").get_json()["apis"]
    pinned = [a["seq"] for a in apis if a["mock_pin"]]
    assert pinned == [s2], pinned
    for a in apis:
        assert "seq" in a and "query" in a and "mock_pin" in a

    # 取消固定 s2：query "" 回到 s1(v:1)
    client.post("/api/mock/pin", json={"seq": s2, "pinned": False})
    d3 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 1' in d3["body"], d3["body"]

    # 固定 s3（query a=9）：query a=9 返回 s3(v:3)，query "" 不受影响（s1 v:1）
    client.post("/api/mock/pin", json={"seq": s3, "pinned": True})
    d4 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "a=9"}).get_json()
    assert '"v": 3' in d4["body"], d4["body"]
    d4b = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 1' in d4b["body"], d4b["body"]

    state.mock_manager.stop()
    print("ALL PASS")


if __name__ == "__main__":
    main()
