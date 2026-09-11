# -*- coding: utf-8 -*-
"""验证 /api/endpoint/doc 与 /api/endpoint/docs 接口存在且返回 JSON。"""
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


def make_rec(method, path, note="", tags=None):
    return {
        "url": "http://x" + path,
        "host": "x", "registered_domain": "x",
        "path": path, "query": "", "method": method,
        "resource_type": "XHR", "is_failed": False, "fail_info": None,
        "request": {"headers": {}, "post_data": None},
        "response": {"status": 200, "status_text": "OK", "headers": {}, "mime_type": "application/json", "body": "{}", "body_size": 2, "size_bytes": 2},
        "timing": {}, "duration_ms": 1,
        "note": note, "tags": tags or [],
    }


def main():
    state.store.set_persist(None)
    state.store.clear_all()
    client = server.app.test_client()

    # 空读
    r = client.post("/api/endpoint/doc", json={"method": "GET", "path": "/api/x"})
    assert r.status_code == 200, r.data
    d = r.get_json()
    assert d["ok"] and d["doc"]["tags"] == [] and d["doc"]["note"] == "", d

    # 写入
    r = client.post("/api/endpoint/doc", json={"method": "GET", "path": "/api/x", "note": "n1", "tags": ["a", "b"]})
    d = r.get_json()
    assert d["ok"] and d["doc"]["note"] == "n1" and d["doc"]["tags"] == ["a", "b"], d

    # 再读
    r = client.post("/api/endpoint/doc", json={"method": "GET", "path": "/api/x"})
    d = r.get_json()
    assert d["doc"]["note"] == "n1", d

    # 批量读
    r = client.post("/api/endpoint/docs", json={})
    d = r.get_json()
    assert d["ok"] and len(d["docs"]) == 1 and d["docs"][0]["path"] == "/api/x", d

    # fallback：先加带 note/tags 的记录，再读未保存的端点
    state.store.add(make_rec("POST", "/api/y", "legacy note", ["old"]))
    r = client.post("/api/endpoint/doc", json={"method": "POST", "path": "/api/y"})
    d = r.get_json()
    assert d["ok"] and d["doc"]["note"] == "legacy note" and "old" in d["doc"]["tags"], d

    print("ALL PASS")


if __name__ == "__main__":
    main()
