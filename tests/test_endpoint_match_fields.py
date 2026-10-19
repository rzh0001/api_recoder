# -*- coding: utf-8 -*-
"""验证「接口级字段路由」：被标记的字段一旦真实请求有传，就按它精确匹配样本；
命中返回对应 Mock，未命中返回 404（不回落），全没传则回落普通匹配逻辑。

对应需求：请求体支持标记「需要精确匹配的字段」（字段级白名单路由键）。
"""
import json
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import config, state, server

_tmp = Path(tempfile.mkdtemp()) / "config.json"
_tmp.write_text(json.dumps({"match_mode": True}, ensure_ascii=False), encoding="utf-8")
config.CONFIG_FILE = _tmp
# 强制严格模式，使「没传匹配键 → 回落」的结果可预测（字段路由本身不受模式影响）
os.environ["API_RECORDER_MATCH_MODE"] = "strict"


def hit(method, url, body):
    req = urllib.request.Request(url, method=method, data=body.encode("utf-8"))
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    state.store.set_persist(None)
    state.store.clear_all()
    client = server.app.test_client()

    # ===== 接口1：按 user.id 路由 =====
    mk1 = client.post("/api/mock/make", json={
        "method": "POST", "path": "/api/order/make",
        "req_body": '{"user":{"id":7},"type":"A"}', "res_status": 200,
    }).get_json()
    mk2 = client.post("/api/mock/make", json={
        "method": "POST", "path": "/api/order/make",
        "req_body": '{"user":{"id":9},"type":"A"}', "res_status": 201,
    }).get_json()
    assert mk1.get("ok") and mk2.get("ok"), (mk1, mk2)
    # make 会自动固定(pin)，这里取消两者的固定，使「回落普通逻辑」在 strict 下可预测
    # （set_pin 按 method+path+query 单条固定：第二条 make 会把第一条的固定顶掉，
    # 导致回落时命中唯一固定条而非 404，掩盖字段路由跳过的正确性）
    state.store.set_pin(mk1["seq"], False)
    state.store.set_pin(mk2["seq"], False)

    # 标记接口级匹配字段
    doc = client.post("/api/endpoint/doc", json={
        "method": "POST", "path": "/api/order/make", "match_fields": ["user.id"],
    }).get_json()
    assert doc.get("ok") and doc["doc"]["match_fields"] == ["user.id"], doc

    state.mock_manager.start()
    url = state.mock_manager.status()["url"].rstrip("/") + "/api/order/make"

    # 1) 有传 user.id=7 → 命中 rec1（即便 type 不同也忽略）
    st, _ = hit("POST", url, '{"user":{"id":7},"type":"Z"}')
    assert st == 200, ("期望命中 rec1(200)，实际", st)
    # 2) 有传 user.id=9 → 命中 rec2
    st, _ = hit("POST", url, '{"user":{"id":9}}')
    assert st == 201, ("期望命中 rec2(201)，实际", st)
    # 3) 有传 user.id=99 → 无匹配 → 404（字段路由未命中，不回落）
    st, b = hit("POST", url, '{"user":{"id":99}}')
    assert st == 404, ("期望字段路由 404，实际", st)
    # 4) 没传 user.id → 字段路由跳过，回落普通逻辑（strict 下 body 无精确匹配 → 404）
    st, _ = hit("POST", url, '{"type":"A"}')
    assert st == 404, ("期望回落 strict 404，实际", st)

    state.mock_manager.stop()

    # ===== 接口2：嵌套 + 数组索引 a[i].b =====
    state.store.clear_all()
    client.post("/api/mock/make", json={
        "method": "POST", "path": "/api/cart/add",
        "req_body": '{"items":[{"sku":"K1","n":1}]}', "res_status": 200,
    })
    client.post("/api/endpoint/doc", json={
        "method": "POST", "path": "/api/cart/add", "match_fields": ["items[0].sku"],
    })
    state.mock_manager.start()
    url2 = state.mock_manager.status()["url"].rstrip("/") + "/api/cart/add"
    # 5) 数组索引命中
    st, _ = hit("POST", url2, '{"items":[{"sku":"K1","n":99}]}')
    assert st == 200, ("期望数组索引命中 200，实际", st)
    # 6) 数组索引未命中
    st, _ = hit("POST", url2, '{"items":[{"sku":"ZZ"}]}')
    assert st == 404, ("期望数组索引 404，实际", st)

    state.mock_manager.stop()
    print("ALL PASS: test_endpoint_match_fields")


if __name__ == "__main__":
    main()
