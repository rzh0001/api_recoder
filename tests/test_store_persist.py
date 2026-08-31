# -*- coding: utf-8 -*-
"""录制数据持久化回归：store 落盘 records.json 后，模拟重启（重新构造 CaptureStore + 相同路径）
必须完整恢复录制数据、seq 续号、note/tags/mock_pin/annotations 等字段。"""
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.capture_store import CaptureStore  # noqa: E402


def _assert(name, cond):
    if not cond:
        print("FAIL:", name)
        raise SystemExit(1)
    print("ok:", name)


def _mk_record(method, path, query="", note=None, tags=None, pinned=False, ann=None):
    rec = {
        "url": "http://example.test" + path + ("?" + query if query else ""),
        "scheme": "http",
        "host": "example.test",
        "registered_domain": "example.test",
        "path": path,
        "query": query,
        "method": method,
        "resource_type": "XHR",
        "is_failed": False,
        "fail_info": None,
        "request": {"headers": {"Content-Type": "application/json"}, "post_data": '{"a":1}', "post_size": 7},
        "response": {"status": 200, "status_text": "OK", "headers": {"Content-Type": "application/json"},
                     "mime_type": "application/json", "body": '{"ok":true}', "body_size": 12, "size_bytes": 12},
        "timing": {}, "duration_ms": 3,
    }
    if note is not None:
        rec["note"] = note
    if tags is not None:
        rec["tags"] = tags
    if pinned:
        rec["mock_pin"] = True
    if ann is not None:
        rec["annotations"] = ann
    return rec


def main():
    tmp = Path(tempfile.mkdtemp())
    rec_path = tmp / "records.json"

    # ---------- 第一次"进程"：录制 3 条，其中带标记字段 ----------
    s1 = CaptureStore()
    s1.set_persist(rec_path)
    s1.add(_mk_record("GET", "/api/user", "id=1", note="用户详情", tags=["用户", "查询"], pinned=True,
                      ann={"res": {"data": "响应注释"}}))
    s1.add(_mk_record("POST", "/api/user", note="创建用户", tags=["用户", "写入"]))
    s1.add(_mk_record("GET", "/static/app.js"))
    _assert("录制 3 条", len(s1.requests) == 3)

    # 非 XHR 记录（OTHER 资源）也要落盘——持久化是整库，不是 Mock 过滤
    s1.add({"url": "http://example.test/img.png", "scheme": "http", "host": "example.test",
            "registered_domain": "example.test", "path": "/img.png", "query": "", "method": "GET",
            "resource_type": "IMAGE", "is_failed": False, "request": {}, "response": {"status": 200}})
    _assert("共 4 条（含静态资源）", len(s1.requests) == 4)

    # 手动 flush（等价于 mark_stopped / 退出时 atexit）
    s1.persist()
    _assert("records.json 已落盘", rec_path.exists())

    # ---------- 第二次"进程"：重启后重建 store，加载同一文件 ----------
    s2 = CaptureStore()
    s2.set_persist(rec_path)
    _assert("重启后恢复 4 条", len(s2.requests) == 4)
    _assert("加载后无脏标记（无变更不写盘）", s2._dirty is False)
    _assert("seq 顺序恢复", [r["seq"] for r in s2.requests] == [1, 2, 3, 4])

    r1 = s2.get(1)
    _assert("note 恢复", r1["note"] == "用户详情")
    _assert("tags 恢复", r1["tags"] == ["用户", "查询"])
    _assert("mock_pin 恢复", r1.get("mock_pin") is True)
    _assert("annotations 恢复", (r1.get("annotations") or {}).get("res", {}).get("data") == "响应注释")
    _assert("响应体恢复", (r1.get("response") or {}).get("body") == '{"ok":true}')

    # seq 续号：重启后新录制不应重复 seq
    s2.add(_mk_record("DELETE", "/api/user/1"))
    _assert("新记录 seq 续号 = 5", s2.get(5) is not None)
    _assert("变更后置脏", s2._dirty is True)
    s2.persist()
    _assert("落盘后清除脏标记", s2._dirty is False)

    # 删除 + 立即 flush 后再"重启"一次，删除应生效
    s2.remove(2)
    s2.persist()
    s3 = CaptureStore()
    s3.set_persist(rec_path)
    _assert("删除后重启恢复 4 条（原 5 删 1）", len(s3.requests) == 4)
    _assert("被删记录不再出现", s3.get(2) is None)

    print("\nALL PASS: test_store_persist")


if __name__ == "__main__":
    main()
