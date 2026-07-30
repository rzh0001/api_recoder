# -*- coding: utf-8 -*-
"""逻辑冒烟测试：用 mock 的 DataPacket 验证解析、存储、统计与 HAR 导出。

不依赖真实浏览器，可在任意环境运行：PYTHONPATH=. python tests/smoke.py
"""
import json
import sys
from types import SimpleNamespace

from app.browser_manager import BrowserManager, registered_domain
from app.capture_store import CaptureStore


class MockPacket:
    def __init__(self, failed=False):
        self.is_failed = failed
        self.resourceType = "XHR" if not failed else "FETCH"
        self._raw_fail_info = {"errorText": "net::ERR_FAILED"} if failed else None
        if failed:
            self._raw_request = {
                "request": {
                    "method": "GET",
                    "url": "https://cdn.example.com/static/app.js",
                    "headers": {"referer": "https://example.com/"},
                }
            }
            self._raw_response = None
            self.url = "https://cdn.example.com/static/app.js"
            self.method = "GET"
            self.request = SimpleNamespace(postData=False)
            self.response = SimpleNamespace(body=None)
            return

        self._raw_request = {
            "request": {
                "method": "POST",
                "url": "https://api.example.com/v1/users?page=2",
                "headers": {"content-type": "application/json", "authorization": "Bearer x"},
                "postData": '{"name":"茅子"}',
                "hasPostData": True,
            }
        }
        self._raw_response = {
            "status": 200,
            "statusText": "OK",
            "headers": {"content-type": "application/json", "content-length": "25"},
            "mimeType": "application/json",
            "timing": {"requestTime": 1234.5, "receiveHeadersEnd": 0.123},
            "encodedDataLength": 25,
        }
        self._raw_fail_info = None
        self.url = "https://api.example.com/v1/users?page=2"
        self.method = "POST"
        self.request = SimpleNamespace(postData='{"name":"茅子"}')
        self.response = SimpleNamespace(body='{"id":1,"name":"茅子"}', status=200)


def main():
    store = CaptureStore()
    bm = BrowserManager(store, lambda m: None)

    # 主域名提取
    assert registered_domain("https://api.example.com/v1/users") == "example.com", "registered_domain 错误"
    print("[OK] registered_domain ->", registered_domain("https://api.example.com/v1/users"))

    # 正常请求
    rec = bm._packet_to_record(MockPacket())
    assert rec["registered_domain"] == "example.com"
    assert rec["host"] == "api.example.com"
    assert rec["method"] == "POST"
    assert rec["resource_type"] == "XHR"
    assert rec["response"]["status"] == 200
    assert rec["response"]["body"] == '{"id":1,"name":"茅子"}'
    assert rec["request"]["post_data"] == '{"name":"茅子"}'
    assert rec["duration_ms"] == round(0.123 * 1000, 1)
    print("[OK] 正常请求解析:", rec["url"], "status", rec["response"]["status"])

    store.add(rec)

    # 失败请求
    recf = bm._packet_to_record(MockPacket(failed=True))
    assert recf["is_failed"] is True
    assert recf["response"]["status"] is None
    assert recf["registered_domain"] == "example.com"
    print("[OK] 失败请求解析:", recf["url"], "is_failed", recf["is_failed"])
    store.add(recf)

    # 统计
    st = store.stats()
    assert st["total"] == 2, st
    assert st["by_type"].get("XHR") == 1
    assert st["errors"] == 1
    print("[OK] 统计:", st)

    # HAR 导出
    har = store.export_har()
    assert har["log"]["entries"][0]["request"]["method"] == "POST"
    assert har["log"]["entries"][0]["response"]["status"] == 200
    assert har["log"]["entries"][1]["_failed"] is True
    print("[OK] HAR 导出 entries:", len(har["log"]["entries"]))

    # 轻量拷贝截断
    big = dict(rec)
    big["response"] = dict(rec["response"]); big["response"]["body"] = "x" * 500000
    light = store.light(big)
    assert len(light["response"]["body"].encode("utf-8", "replace")) <= 200 * 1024 + 64
    print("[OK] light() 截断 body 到 WebSocket 阈值内")

    print("\n全部冒烟测试通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
