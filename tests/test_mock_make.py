# -*- coding: utf-8 -*-
"""验证「404 未命中 → 凭空造 Mock」入口 POST /api/mock/make：

- 合成一条 XHR 记录写入录制库并立即固定为默认返回；
- 造出来的 Mock 能被 Mock 引擎实时命中（method+path+query 精确）；
- 缺 path 报 400；path 自动补前导斜杠；默认 GET/200；
- 造完后出现在 /api/mock/apis（供前端接口台账/Mock 页签展示）。
"""
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


def main():
    state.store.set_persist(None)  # 测试隔离：不落盘到真实 data/
    state.store.clear_all()
    client = server.app.test_client()

    # ---- 0) 真实场景：库里空空、Mock 未启动 → 先「凭空造数据」再启动引擎 ----
    assert state.store.get_mock_data() == [], "前置应无任何可模拟记录"

    # ---- 1) 缺 path → 400 ----
    bad = client.post("/api/mock/make", json={"method": "GET"})
    assert bad.status_code == 400, bad.status_code
    assert bad.get_json().get("ok") is False

    # ---- 2) 正常造一条：POST /api/order，带 query/req_body/自定义状态码与响应体 ----
    resp_body = json.dumps({"code": 0, "data": {"id": 9527, "name": "造的数据"}}, ensure_ascii=False)
    mk = client.post("/api/mock/make", json={
        "method": "post",
        "path": "api/order",           # 故意不带前导斜杠
        "query": "id=9527",
        "req_body": {"id": 9527},
        "res_status": 201,
        "res_body": resp_body,
        "res_headers": {"X-From": "make"},
    }).get_json()
    assert mk.get("ok") and isinstance(mk.get("seq"), int), mk
    seq = mk["seq"]

    # ---- 3) 造完才启动 Mock 引擎（真实顺序：造数据 → 启引擎 → 命中）----
    r = state.mock_manager.start()
    assert r.get("ok"), r

    # ---- 3b) 造出来的 Mock 能被实时命中（method 归一为大写、path 补斜杠）----
    hit = client.post("/api/mock/test", json={
        "method": "POST", "path": "/api/order", "query": "id=9527",
    }).get_json()
    assert hit["status"] == 201, hit
    assert "9527" in hit["body"] and "造的数据" in hit["body"], hit["body"]

    # ---- 4) 唯一默认的跨 query 兜底：同接口带动态 query（?t=）也命中造的那条 ----
    dyn = client.post("/api/mock/test", json={
        "method": "POST", "path": "/api/order", "query": "t=1785803600",
    }).get_json()
    assert dyn["status"] == 201, dyn
    assert "造的数据" in dyn["body"], dyn["body"]

    # ---- 5) 默认值：不带 res_status/res_body/method → 200 + 空体 + GET ----
    mk2 = client.post("/api/mock/make", json={"path": "/api/ping"}).get_json()
    assert mk2.get("ok"), mk2
    hit2 = client.post("/api/mock/test", json={"method": "GET", "path": "/api/ping", "query": ""}).get_json()
    assert hit2["status"] == 200, hit2
    assert hit2["body"] == "", repr(hit2["body"])

    # ---- 6) 出现在 /api/mock/apis，且带 mock_pin 标记（供前端台账/Mock 页签）----
    apis = client.get("/api/mock/apis").get_json()["apis"]
    made = [a for a in apis if a.get("seq") in (seq, mk2["seq"])]
    assert len(made) == 2, made
    for a in made:
        assert a.get("mock_pin") is True, a
        assert a.get("method") in ("POST", "GET"), a

    # ---- 7) 造的数据在录制库里也可见（synthetic 记录，自定义头/体落库）----
    # 注：/api/request/<seq> 返回裸 JSON 串（content-type text/html），需手动解析
    raw = client.get("/api/request/%d" % seq).get_data(as_text=True)
    rec = json.loads(raw)
    assert rec.get("path") == "/api/order", rec.get("path")
    assert rec.get("synthetic") is True, rec.get("synthetic")
    rres = rec.get("response") or {}
    assert rres.get("status") == 201, rres
    assert rres.get("headers", {}).get("X-From") == "make", rres.get("headers")
    assert "content-type" in {str(k).lower() for k in rres.get("headers", {})}, rres.get("headers")

    state.mock_manager.stop()
    print("ALL PASS: test_mock_make")


if __name__ == "__main__":
    main()
