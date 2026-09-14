# -*- coding: utf-8 -*-
"""验证「清空处理记录」接口：/api/mock/logs/clear 清空 logs，但不影响运行状态与命中计数。"""
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


def main():
    state.store.set_persist(None)
    state.store.clear_all()
    seq = state.store.add(make_rec("GET", "/api/x", "", json.dumps({"v": 1})))
    state.mock_manager.start()
    client = server.app.test_client()

    client.post("/api/mock/test", json={"seq": seq})
    logs = client.post("/api/mock/logs", json={}).get_json()["logs"]
    assert len(logs) >= 1, logs
    print("ok: 处理记录已有 %d 条" % len(logs))

    # 命中计数（清空日志前）
    hits_before = [a["hits"] for a in client.get("/api/mock/apis").get_json()["apis"] if a["seq"] == seq][0]
    assert hits_before >= 1, hits_before

    # 清空
    r = client.post("/api/mock/logs/clear", json={}).get_json()
    assert r.get("ok") is True, r
    logs_after = client.post("/api/mock/logs", json={}).get_json()["logs"]
    assert logs_after == [], logs_after
    print("ok: 清空后处理记录为 0 条")

    # 运行状态与命中计数不受影响
    assert state.mock_manager.running is True
    hits_after = [a["hits"] for a in client.get("/api/mock/apis").get_json()["apis"] if a["seq"] == seq][0]
    assert hits_after == hits_before, (hits_before, hits_after)
    print("ok: 清空日志不影响运行状态与命中计数")

    # 清空后仍能继续记录
    client.post("/api/mock/test", json={"seq": seq})
    logs_new = client.post("/api/mock/logs", json={}).get_json()["logs"]
    assert len(logs_new) == 1, logs_new
    print("ok: 清空后新请求照常记录")

    state.mock_manager.stop()
    print("\nALL PASS: test_mock_logs_clear")


if __name__ == "__main__":
    main()
