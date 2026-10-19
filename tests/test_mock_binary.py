# -*- coding: utf-8 -*-
"""验证「Mock 模拟真实下载」：二进制响应体捕获、回放与手动挂文件。

- 捕获层 parse_body_full 把字节体存为 body_b64 + is_binary；
- get_mock_data / apis 透传二进制与 mock_file 字段；
- Mock 路由按字节下发：录制二进制原样回放（含 Content-Disposition 则下载），
  手动挂文件优先并合成下载头 + 正确 Content-Type/Content-Length；
- /api/mock/file、/api/mock/file/clear、/api/file/save(b64) 端到端可用。
"""
import base64
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app.state as state
from app.capture_store import parse_body_full, CaptureStore
from app.mock_manager import MockManager, _make_app
from app import config, server

_tmp = Path(__file__).resolve().parent / "_tmp_cfg_binary.json"
_tmp.write_text(json.dumps({"match_mode": False}, ensure_ascii=False), encoding="utf-8")
config.CONFIG_FILE = _tmp


def _bin_rec(method, path, query="", b64="", headers=None, rtype="XHR", mock_file=None):
    hdrs = headers or {"Content-Type": "application/octet-stream"}
    rec = {
        "url": "https://h.com%s%s" % (path, ("?" + query) if query else ""),
        "scheme": "https", "host": "h.com", "registered_domain": "h.com",
        "path": path, "query": query, "method": method, "resource_type": rtype,
        "is_failed": False, "fail_info": None,
        "request": {"headers": {}, "post_data": None, "post_size": 0},
        "response": {
            "status": 200, "status_text": "OK", "headers": hdrs,
            "mime_type": hdrs.get("Content-Type"),
            "body": None, "body_b64": b64 or None, "is_binary": bool(b64),
            "body_size": (len(base64.b64decode(b64)) if b64 else 0),
            "size_bytes": (len(base64.b64decode(b64)) if b64 else 0),
            "truncated": False,
        },
        "note": None, "tags": [], "annotations": {}, "mock_pin": True,
        "captured_at": 1700000000.0, "timing": {}, "duration_ms": 10,
    }
    if mock_file is not None:
        rec["mock_file"] = mock_file
    return rec


def _assert(cond, msg):
    if not cond:
        print("FAIL:", msg)
        raise SystemExit(1)
    print("ok:", msg)


def main():
    state.store.set_persist(None)
    state.store.clear_all()

    # 1) parse_body_full：字节体 → (None, b64, True, size)；文本体不变
    t, b64, ib, sz = parse_body_full(b"PK\x03\x04")
    _assert(t is None and ib is True and b64 == base64.b64encode(b"PK\x03\x04").decode(), "parse_body_full 字节体→base64+is_binary")
    t2, b642, ib2, sz2 = parse_body_full('{"a":1}')
    _assert(t2 == '{"a":1}' and ib2 is False and b642 is None, "parse_body_full 文本体→text")

    # 2) 录制二进制下载接口：真实响应头带 Content-Disposition（应回放为下载）
    zip_b64 = base64.b64encode(b"PK\x03\x04fakezip").decode()
    rec_bin = _bin_rec("GET", "/api/export/zip", "", zip_b64,
                      headers={"Content-Type": "application/zip",
                               "Content-Disposition": 'attachment; filename="r.zip"'})
    seq_bin = state.store.add(rec_bin)
    # 3) 手动挂文件的规则（覆盖录制体，合成下载头）
    pdf_b64 = base64.b64encode(b"%PDF-1.4 mock").decode()
    rec_file = _bin_rec("GET", "/api/report", "", "",
                        headers={})
    rec_file["mock_file"] = {"filename": "manual.pdf", "mime": "application/pdf",
                             "b64": pdf_b64, "size": len(b"%PDF-1.4 mock")}
    seq_file = state.store.add(rec_file)
    # 4) 普通文本接口
    seq_txt = state.store.add(_bin_rec("GET", "/api/ping", "", "",
                                       headers={"Content-Type": "application/json"}))

    # get_mock_data 透传二进制与 mock_file
    md = state.store.get_mock_data()
    by_path = {r["path"]: r for r in md}
    _assert(by_path["/api/export/zip"]["response"]["is_binary"] is True, "get_mock_data 含 is_binary")
    _assert(by_path["/api/export/zip"]["response"]["body_b64"] == zip_b64, "get_mock_data 含 body_b64")
    _assert(by_path["/api/report"].get("mock_file") is not None, "get_mock_data 含 mock_file")

    # 5) Mock 路由按字节下发：录制二进制原样回放（含 Content-Disposition）
    state.store = state.store  # 确保 _get_store 读到
    mgr = MockManager()
    app = _make_app(mgr)
    c = app.test_client()
    r = c.get("/api/export/zip")
    _assert(r.status_code == 200, "二进制接口 200")
    _assert(r.data == b"PK\x03\x04fakezip", "二进制体原样回放")
    _assert(r.headers.get("Content-Type") == "application/zip", "Content-Type 回放")
    _assert('attachment; filename="r.zip"' in (r.headers.get("Content-Disposition") or ""), "录制 Content-Disposition 触发下载")
    _assert(r.headers.get("Content-Length") == str(len(b"PK\x03\x04fakezip")), "Content-Length 正确")

    # 6) 手动挂文件优先：合成下载头 + 正确 mime
    r2 = c.get("/api/report")
    _assert(r2.status_code == 200, "挂文件接口 200")
    _assert(r2.data == b"%PDF-1.4 mock", "返回挂的文件字节")
    _assert(r2.headers.get("Content-Type") == "application/pdf", "合成 Content-Type")
    _assert('attachment; filename="manual.pdf"' in (r2.headers.get("Content-Disposition") or ""), "合成 Content-Disposition")

    # 7) 文本接口仍走字符串
    r3 = c.get("/api/ping")
    _assert(r3.status_code == 200 and r3.data == b"", "文本接口空体正常")

    # 8) 服务端接口：/api/mock/file 挂文件 + /api/mock/apis 含 has_file
    client = server.app.test_client()
    new_b64 = base64.b64encode(b"HELLO-FILE").decode()
    resp = client.post("/api/mock/file", json={
        "seq": seq_txt, "filename": "hello.bin", "mime": "application/octet-stream", "b64": new_b64,
    }).get_json()
    _assert(resp.get("ok") is True, "/api/mock/file 成功")
    apis = client.get("/api/mock/apis").get_json()["apis"]
    ha = [a for a in apis if a["seq"] == seq_txt][0]
    _assert(ha.get("has_file") is True and ha.get("mock_file", {}).get("filename") == "hello.bin", "apis 含 has_file")
    # 经 Mock 引擎实测（主服务代理）
    state.mock_manager.start()
    hit = client.post("/api/mock/test", json={"method": "GET", "path": "/api/ping", "query": ""}).get_json()
    _assert(hit["status"] == 200 and "HELLO-FILE" in hit["body"], "挂文件后 Mock 返回该文件")
    # 移除
    clr = client.post("/api/mock/file/clear", json={"seq": seq_txt}).get_json()
    _assert(clr.get("ok") is True, "/api/mock/file/clear 成功")
    state.mock_manager.stop()

    # 9) /api/file/save 支持 b64 写字节（用唯一文件名避免与 ~/Downloads 既有文件冲突）
    out_name = "api_recoder_test_%d.bin" % int(time.time() * 1000)
    save = client.post("/api/file/save", json={"filename": out_name, "b64": base64.b64encode(b"RAWBYTES").decode()}).get_json()
    _assert(save.get("ok") is True and out_name in save.get("path", ""), "/api/file/save(b64) 落盘")
    saved = Path(save["path"]).read_bytes()
    _assert(saved == b"RAWBYTES", "/api/file/save 写出原始字节")

    print("\nALL PASS: test_mock_binary")


if __name__ == "__main__":
    main()
