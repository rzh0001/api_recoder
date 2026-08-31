# -*- coding: utf-8 -*-
"""验证导出改为「后端落盘」：/api/export/save 与 /api/export_mock/save 真写文件，
/api/open 仅允许 EXPORT_DIR 内、越权拦截。"""
import json
import os
import tempfile

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
    state.store.set_persist(None)  # 测试隔离：不落盘到真实 data/records.json
    state.store.clear_all()
    state.store.add(make_rec("GET", "/api/x", "", json.dumps({"v": 1})))
    client = server.app.test_client()

    # HAR 落盘
    r = client.post("/api/export/save", json={"format": "har"})
    j = r.get_json()
    print("HAR save:", j)
    assert j.get("ok"), j
    p = j["path"]
    assert os.path.isfile(p), p
    with open(p, "r", encoding="utf-8") as f:
        content = f.read()
    assert "/api/x" in content, "HAR 内容应含录制 URL"
    os.remove(p)

    # JSON 落盘
    r = client.post("/api/export/save", json={"format": "json"})
    j = r.get_json()
    assert j.get("ok"), j
    pj = j["path"]
    assert os.path.isfile(pj)
    os.remove(pj)

    # Mock 脚本落盘
    r = client.post("/api/export_mock/save", json={})
    j = r.get_json()
    print("MOCK save:", j)
    assert j.get("ok"), j
    pm = j["path"]
    assert os.path.isfile(pm), pm
    with open(pm, "r", encoding="utf-8") as f:
        assert "mock" in f.read().lower()
    os.remove(pm)

    # /api/open 越权拦截：传入非 EXPORT_DIR 内的路径应 400
    outside = os.path.join(tempfile.gettempdir(), "secret.txt")
    with open(outside, "w") as f:
        f.write("x")
    r = client.post("/api/open", json={"path": outside})
    print("open(outside):", r.status_code, r.get_json())
    assert r.status_code == 400, r.get_json()
    os.remove(outside)

    # /api/open 正常路径（存在且位于 EXPORT_DIR）：不应 400（startfile 在沙箱可能失败但路径校验通过）
    inside = os.path.join(str(server.EXPORT_DIR), "probe.txt")
    with open(inside, "w") as f:
        f.write("x")
    r = client.post("/api/open", json={"path": inside})
    print("open(inside):", r.status_code, r.get_json())
    # 沙箱可能无 startfile（Linux）或无权打开窗口，只要不是 400 越权即可；允许 500（环境限制）
    assert r.status_code != 400, r.get_json()
    os.remove(inside)

    print("ALL PASS")


if __name__ == "__main__":
    main()
