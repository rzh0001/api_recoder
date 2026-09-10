# -*- coding: utf-8 -*-
"""验证「录制侧编辑响应体」端点 /api/response/edit：
状态码/状态文本/响应头/响应体 就地修改，派生字段（body_size/size_bytes/mime_type）
同步重算，导出 HAR/JSON 与 Mock 数据源口径一致；Mock 运行中编辑同样实时生效。
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import state, server

_REC = {
    "url": "http://x/api/login",
    "scheme": "http", "host": "x", "registered_domain": "x",
    "path": "/api/login", "query": "", "method": "POST",
    "resource_type": "XHR", "is_failed": False, "fail_info": None,
    "request": {"headers": {"Content-Type": "application/json"}, "post_data": '{"u":"a"}', "post_size": 8},
    "response": {
        "status": 200, "status_text": "OK",
        "headers": {"Content-Type": "application/json", "Set-Cookie": "sid=1"},
        "mime_type": "application/json",
        "body": '{"v": 1}',
        "body_size": 8, "size_bytes": 10,
    },
    "timing": {}, "duration_ms": 5,
}


def main():
    state.store.set_persist(None)
    state.store.clear_all()
    seq = state.store.add(json.loads(json.dumps(_REC)))
    client = server.app.test_client()

    # ---- 参数校验 ----
    r = client.post("/api/response/edit", json={"seq": "x"}).get_json()
    assert not r["ok"] and r["error"], r
    r = client.post("/api/response/edit", json={"seq": 99999, "res_status": 200}).get_json()
    assert not r["ok"], r
    r = client.post("/api/response/edit", json={"seq": seq, "res_status": 99}).get_json()
    assert not r["ok"], r
    r = client.post("/api/response/edit", json={"seq": seq, "res_status": 700}).get_json()
    assert not r["ok"], r
    r = client.post("/api/response/edit", json={"seq": seq, "res_headers": "{bad"}).get_json()
    assert not r["ok"], r
    r = client.post("/api/response/edit", json={"seq": seq, "res_headers": "[1,2]"}).get_json()
    assert not r["ok"], r
    r = client.post("/api/response/edit", json={"seq": seq, "res_body": {"o": 1}}).get_json()
    assert not r["ok"], r

    # 校验失败必须零副作用（仍 200/OK/原 body）
    rec = state.store.get(seq)
    assert rec["response"]["status"] == 200 and rec["response"]["body"] == '{"v": 1}', rec["response"]

    # ---- 完整编辑：状态码/文本/头/体 ----
    body = '{"v": 9, "msg": "rejected"}'
    ok = client.post("/api/response/edit", json={
        "seq": seq, "res_status": 403, "res_status_text": "Forbidden",
        "res_headers": '{"Content-Type": "application/json", "X-Mock": "1"}',
        "res_body": body,
    }).get_json()
    assert ok["ok"], ok
    rec = state.store.get(seq)
    resp = rec["response"]
    assert resp["status"] == 403
    assert resp["status_text"] == "Forbidden"
    assert resp["headers"] == {"Content-Type": "application/json", "X-Mock": "1"}
    assert resp["mime_type"] == "application/json", resp  # 头变但 Content-Type 未变
    assert resp["body"] == body
    assert resp["body_size"] == len(body.encode("utf-8"))
    assert resp["size_bytes"] == resp["body_size"]
    assert "truncated" not in resp
    assert rec["seq"] == seq and rec["path"] == "/api/login"  # 请求侧不动

    # ---- 派生口径：Mock 数据源 / HAR / JSON 均用新值 ----
    md = [m for m in state.store.get_mock_data() if m["seq"] == seq][0]
    assert md["response"]["status"] == 403 and md["response"]["body"] == body, md
    har = state.store.export_har()["log"]["entries"][0]
    assert har["response"]["status"] == 403 and har["response"]["statusText"] == "Forbidden"
    assert '"msg": "rejected"' in har["response"]["content"]["text"]
    j = state.store.export_json()["requests"][0]
    assert j["response"]["body"] == body and j["response"]["status"] == 403

    # ---- 只改状态码：旧码标准文本自动换成新码标准短语（不带 res_status_text）----
    seq2 = state.store.add(json.loads(json.dumps(_REC)))
    client.post("/api/response/edit", json={"seq": seq2, "res_status": 500})
    resp2 = state.store.get(seq2)["response"]
    assert resp2["status"] == 500 and resp2["status_text"] == "Internal Server Error", resp2

    # ---- 前端总是同时发 text：旧标准文本已过时也自动替换 ----
    seq3 = state.store.add(json.loads(json.dumps(_REC)))
    client.post("/api/response/edit", json={"seq": seq3, "res_status": 404, "res_status_text": "OK"})
    r3 = state.store.get(seq3)["response"]
    assert r3["status"] == 404 and r3["status_text"] == "Not Found", r3

    # ---- 自定义文本保留 ----
    seq4 = state.store.add(json.loads(json.dumps(_REC)))
    client.post("/api/response/edit", json={"seq": seq4, "res_status_text": "自定义"})
    assert state.store.get(seq4)["response"]["status_text"] == "自定义"

    # ---- 清空响应体（''/null → body None, size 归零, truncated 移除）----
    seq5 = state.store.add(json.loads(json.dumps(_REC)))
    state.store.get(seq5)["response"]["truncated"] = True
    client.post("/api/response/edit", json={"seq": seq5, "res_body": ""})
    r5 = state.store.get(seq5)["response"]
    assert r5["body"] is None and r5["body_size"] == 0 and r5["size_bytes"] == 0
    assert "truncated" not in r5
    client.post("/api/response/edit", json={"seq": seq5, "res_body": None})
    assert state.store.get(seq5)["response"]["body"] is None

    # ---- 换掉 Content-Type 时 mime_type 跟随 ----
    seq6 = state.store.add(json.loads(json.dumps(_REC)))
    client.post("/api/response/edit", json={"seq": seq6, "res_headers": '{"Content-Type": "text/html"}'})
    assert state.store.get(seq6)["response"]["mime_type"] == "text/html"

    # ---- Mock 运行中编辑不锁定：编辑/删除实时写回 Mock 数据源 ----
    state.mock_manager.start()
    try:
        seq7 = state.store.add(json.loads(json.dumps(_REC)))
        ok7 = client.post("/api/response/edit", json={
            "seq": seq7, "res_status": 201, "res_body": '{"v": 2}',
        }).get_json()
        assert ok7["ok"], ok7
        md7 = [m for m in state.store.get_mock_data() if m["seq"] == seq7][0]
        assert md7["response"]["status"] == 201 and md7["response"]["body"] == '{"v": 2}', md7
        ok8 = client.post("/api/request/edit", json={"seq": seq7, "req_body": "x"}).get_json()
        assert ok8["ok"], ok8
        assert state.store.get(seq7)["request"]["post_data"] == "x"
        ok9 = client.post("/api/request/delete", json={"seq": seq7}).get_json()
        assert ok9["ok"], ok9
        assert not [m for m in state.store.get_mock_data() if m["seq"] == seq7]
    finally:
        state.mock_manager.stop()

    print("ALL PASS")


if __name__ == "__main__":
    main()
