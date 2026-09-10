# -*- coding: utf-8 -*-
"""验证 Mock「默认(pin)固定返回」的匹配语义：

- 同 method+path+query 有默认 → 精确命中返回（多条不同 query 默认互不干扰）；
- 同 method+path 仅有一条默认（唯一默认）→ 无视 query/body 整接口固定返回
  （覆盖 ?t=时间戳 这类动态 query 接口）；
- 严格/模糊模式同样生效。本测试用临时 config.json 分别以 match_mode=false/true 验证。
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import config, state, server

_tmp = Path(tempfile.mkdtemp()) / "config.json"
_tmp.write_text(json.dumps({"match_mode": False}, ensure_ascii=False), encoding="utf-8")
config.CONFIG_FILE = _tmp


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
    state.store.set_persist(None)  # 测试隔离：不落盘到真实 data/records.json
    state.store.clear_all()
    s1 = state.store.add(make_rec("GET", "/api/x", "", json.dumps({"v": 1})))
    s2 = state.store.add(make_rec("GET", "/api/x", "", json.dumps({"v": 2})))
    s3 = state.store.add(make_rec("GET", "/api/x", "a=9", json.dumps({"v": 3})))
    state.store.add(make_rec("GET", "/api/y", "", json.dumps({"y": 1})))

    r = state.mock_manager.start()
    assert r.get("ok"), r

    client = server.app.test_client()

    # 无 pin：query "" 返回最早 s1(v:1)；query "a=9" 返回 s3(v:3)
    d = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 1' in d["body"], d["body"]
    d_a9 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "a=9"}).get_json()
    assert '"v": 3' in d_a9["body"], d_a9["body"]

    # 唯一默认 s2（query ""）：同 query 返回 s2；且「唯一默认」跨 query 兜底
    # —— 动态 query 接口（如 ?t=时间戳）设了默认就整接口固定返回该条
    pr = client.post("/api/mock/pin", json={"seq": s2, "pinned": True}).get_json()
    assert pr.get("ok")
    d2 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 2' in d2["body"], d2["body"]
    d2b = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "a=9"}).get_json()
    assert '"v": 2' in d2b["body"], d2b["body"]  # 关键：唯一默认覆盖其它 query
    d2c = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "zz=1"}).get_json()
    assert '"v": 2' in d2c["body"], d2c["body"]  # 全新动态 query 也命中默认

    # /api/mock/apis 反映固定态：仅 s2 被标记；且透出 seq/query/mock_pin 供前端分组
    apis = client.get("/api/mock/apis").get_json()["apis"]
    pinned = [a["seq"] for a in apis if a["mock_pin"]]
    assert pinned == [s2], pinned
    for a in apis:
        assert "seq" in a and "query" in a and "mock_pin" in a

    # 再加默认 s3（query a=9）：两条不同 query 的默认 → 各自 query 精确命中，不做整接口兜底
    client.post("/api/mock/pin", json={"seq": s3, "pinned": True})
    d_m1 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "a=9"}).get_json()
    assert '"v": 3' in d_m1["body"], d_m1["body"]
    d_m2 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 2' in d_m2["body"], d_m2["body"]
    d_m3 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "zz=1"}).get_json()
    assert '"v": 1' in d_m3["body"], d_m3["body"]  # 多默认无精确：走模糊回退，不猜

    # 取消 s2（只剩唯一默认 s3 a=9）：query "" 与动态 query 都被兜底到 s3
    client.post("/api/mock/pin", json={"seq": s2, "pinned": False})
    d4 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "a=9"}).get_json()
    assert '"v": 3' in d4["body"], d4["body"]
    d4b = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 3' in d4b["body"], d4b["body"]  # 唯一默认跨 query 兜底
    d4c = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "zz=1"}).get_json()
    assert '"v": 3' in d4c["body"], d4c["body"]

    # 取消 s3：全部回到无 pin 行为
    client.post("/api/mock/pin", json={"seq": s3, "pinned": False})
    d5 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 1' in d5["body"], d5["body"]

    state.mock_manager.stop()

    # ---- 严格模式（match_mode=true，默认）下默认同样生效 ----
    tmp_s = Path(tempfile.mkdtemp()) / "config.json"
    tmp_s.write_text(json.dumps({"match_mode": True}, ensure_ascii=False), encoding="utf-8")
    config.CONFIG_FILE = tmp_s
    state.store.clear_all()
    sa = state.store.add(make_rec("GET", "/api/x", "", json.dumps({"v": 1})))
    sb = state.store.add(make_rec("GET", "/api/x", "", json.dumps({"v": 2})))
    ok_s = state.mock_manager.start()
    assert ok_s.get("ok"), ok_s

    # 严格 + 未固定：同 query 命中最早一条
    d6 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 1' in d6["body"], d6["body"]
    # 严格 + 固定 sb（唯一默认）：同 query 返回 sb；动态 query 也被兜底返回 sb
    pr_s = client.post("/api/mock/pin", json={"seq": sb, "pinned": True}).get_json()
    assert pr_s.get("ok")
    d7 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 2' in d7["body"], d7["body"]
    d8 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "t=17858036"}).get_json()
    assert '"v": 2' in d8["body"], d8["body"]  # 动态时间戳 query 命中唯一默认
    # 取消固定后严格模式回到精确匹配（动态 query 不再兜底 → 404）
    client.post("/api/mock/pin", json={"seq": sb, "pinned": False})
    d9 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": ""}).get_json()
    assert '"v": 1' in d9["body"], d9["body"]
    d10 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/x", "query": "t=17858036"}).get_json()
    assert d10["status"] == 404, d10

    state.mock_manager.stop()
    print("ALL PASS")


if __name__ == "__main__":
    main()
