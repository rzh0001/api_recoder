# -*- coding: utf-8 -*-
"""验证 Mock「固定返回某一条」功能：同一 API 多条记录时，固定项优先返回。"""
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
    state.store.add(make_rec("GET", "/api/y", "", json.dumps({"y": 1})))

    r = state.mock_manager.start()
    assert r.get("ok"), r
    print("start:", r)

    client = server.app.test_client()

    # 默认（未固定）：返回最早录制的那条 s1 (v:1)
    d = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    print("默认返回:", d["body"])
    assert '"v": 1' in d["body"], d["body"]

    # 固定 s2
    pr = client.post("/api/mock/pin", json={"seq": s2, "pinned": True}).get_json()
    print("pin s2:", pr)
    assert pr.get("ok")

    # 固定后：返回 s2 (v:2)
    d2 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    print("固定后返回:", d2["body"])
    assert '"v": 2' in d2["body"], d2["body"]

    # 不同 query 也应命中固定项（按 method+path 固定）
    d2b = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "a=9"}).get_json()
    assert '"v": 2' in d2b["body"], d2b["body"]

    # /api/mock/apis 应反映固定态：仅 s2 被标记
    apis = client.get("/api/mock/apis").get_json()["apis"]
    pinned = [a["seq"] for a in apis if a["mock_pin"]]
    print("固定项 seq:", pinned)
    assert pinned == [s2], pinned

    # 取消固定：回到默认（最早 s1）
    client.post("/api/mock/pin", json={"seq": s2, "pinned": False})
    d3 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 1' in d3["body"], d3["body"]

    state.mock_manager.stop()
    print("ALL PASS")


if __name__ == "__main__":
    main()
