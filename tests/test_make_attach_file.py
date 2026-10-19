# -*- coding: utf-8 -*-
"""验证「文件下载类接口」的完整造数据链路：
POST /api/mock/make 造一条 → POST /api/mock/file 挂文件 → Mock 命中时真的按字节返回该文件并带下载头。

这是真实场景：OA 的 /oa/api/business/downloadAttachment 这类接口，光造 JSON 响应体没用，
客户端要的是能触发的文件下载。
"""
import base64
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

# 一段最小 PDF 头字节，用来看清「按字节回放」
PDF_BYTES = b"%PDF-1.4\n%fake-pdf-for-test\n%%EOF\n"


def main():
    state.store.set_persist(None)
    state.store.clear_all()
    client = server.app.test_client()

    # ---- 1) 造一条文件下载接口的 Mock ----
    mk = client.post("/api/mock/make", json={
        "method": "POST",
        "path": "/oa/api/business/downloadAttachment",
        "query": "a=1&b=2",
        "req_body": "id=cddaa0c3f25cab4f&businessId=17983051",
        "res_status": 200,
        "res_body": "{}",
    }).get_json()
    assert mk.get("ok") and isinstance(mk.get("seq"), int), mk
    seq = mk["seq"]

    # ---- 2) 挂文件（模拟前端 FileReader → base64 → POST /api/mock/file）----
    b64 = base64.b64encode(PDF_BYTES).decode("ascii")
    att = client.post("/api/mock/file", json={
        "seq": seq, "filename": "报表.pdf", "mime": "application/pdf", "b64": b64,
    }).get_json()
    assert att.get("ok"), att

    # ---- 3) 记录上确实带上了 mock_file（filename/mime/size）----
    raw = client.get("/api/request/%d" % seq).get_data(as_text=True)
    rec = json.loads(raw)
    mf = rec.get("mock_file") or {}
    assert mf.get("filename") == "报表.pdf", mf
    assert mf.get("mime") == "application/pdf", mf
    assert mf.get("size") == len(PDF_BYTES), mf

    # ---- 4) 启动引擎，实际请求一次：应按字节返回文件 + 下载头 ----
    r = state.mock_manager.start()
    assert r.get("ok"), r

    hit = client.post("/api/mock/test", json={
        "method": "POST", "path": "/oa/api/business/downloadAttachment", "query": "a=1&b=2",
    }).get_json()
    assert hit["status"] == 200, hit
    # 挂文件优先于文本响应体：返回的是 PDF 原文，不是造的 "{}"
    assert hit["body"] == PDF_BYTES.decode("utf-8", "replace"), hit

    # ---- 5) 直接打 Mock 服务，验证真的是一份文件下载 ----
    import urllib.request
    url = state.mock_manager.status()["url"].rstrip("/") + "/oa/api/business/downloadAttachment?a=1&b=2"
    req = urllib.request.Request(url, method="POST", data=b"id=cddaa0c3f25cab4f")
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = resp.read()
        headers = {k.lower(): v for k, v in resp.headers.items()}
        status = resp.status
    assert status == 200, status
    assert body == PDF_BYTES, (body[:40], PDF_BYTES[:40])
    cdisp = headers.get("content-disposition", "")
    assert "attachment" in cdisp, cdisp
    # 中文文件名必须走 RFC 5987：filename* 里是百分号编码的真名，外层 filename 是 ASCII 兜底
    assert "filename*=UTF-8''" in cdisp, cdisp
    assert "%E6%8A%A5%E8%A1%A8.pdf" in cdisp, cdisp          # 「报表.pdf」的 UTF-8 百分号编码
    assert 'filename="' in cdisp, cdisp
    assert headers.get("content-type", "").startswith("application/pdf"), headers
    assert int(headers.get("content-length", 0)) == len(PDF_BYTES), headers

    # ---- 6) 移除挂文件后，回落到文本响应体（不再触发下载）----
    cl = client.post("/api/mock/file/clear", json={"seq": seq}).get_json()
    assert cl.get("ok"), cl
    raw2 = json.loads(client.get("/api/request/%d" % seq).get_data(as_text=True))
    assert "mock_file" not in raw2, raw2.get("mock_file")

    with urllib.request.urlopen(req, timeout=5) as resp2:
        body2 = resp2.read()
        headers2 = {k.lower(): v for k, v in resp2.headers.items()}
    assert body2 == b"{}", body2
    assert "attachment" not in headers2.get("content-disposition", ""), headers2

    state.mock_manager.stop()
    print("ALL PASS: test_make_attach_file")


if __name__ == "__main__":
    main()
