# -*- coding: utf-8 -*-
"""配置持久化回归：服务端口 / Mock 端口保存后必须可重启读取；页面加载的空 POST 不能清掉端口。"""
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app.config as cfg
import app.server as srv

tmp = Path(tempfile.mkdtemp())
cfg_file = tmp / "config.json"
cfg.CONFIG_FILE = cfg_file
srv.CONFIG_FILE = cfg_file
srv.USER_CONFIG = cfg._load_user_config()


def _assert(name, cond):
    if not cond:
        print("FAIL:", name)
        raise SystemExit(1)
    print("ok:", name)


def _disk():
    return json.loads(cfg_file.read_text(encoding="utf-8")) if cfg_file.exists() else {}


def _jresp(r):
    # 后端配置接口未强制 application/json 头，手动解析
    return json.loads(r.get_data(as_text=True))


def main():
    c = srv.app.test_client()

    # 1) 保存服务端口 + Mock 端口
    r = c.post("/api/config", json={"port": 9999, "mock_port": 8888})
    _assert("保存端口返回 ok", _jresp(r).get("ok") is True)
    _assert("端口已写入 config.json", _disk().get("port") == 9999)
    _assert("Mock 端口已写入 config.json", _disk().get("mock_port") == 8888)

    # 2) GET /api/config 现在包含 match_mode 字段（前端初始化匹配模式用）
    d = _jresp(c.get("/api/config"))
    _assert("GET /api/config 含 match_mode 字段", "match_mode" in d)
    _assert("GET /api/config 回显已保存端口", d.get("saved_port") == 9999)

    # 2.1) 保存 match_mode=false（前端关掉严格开关 = 模糊匹配）后回显
    c.post("/api/config", json={"match_mode": False})
    _assert("match_mode=false 已写入 config.json", _disk().get("match_mode") is False)
    _assert("GET 回显 match_mode=false", _jresp(c.get("/api/config")).get("match_mode") is False)

    # 3) 关键回归：页面加载时的空 POST（postJSON('/api/config', {})）不能清掉已保存端口
    c.post("/api/config", json={})
    _assert("空 POST 后端口仍在 config.json（修复点）", _disk().get("port") == 9999)
    _assert("空 POST 后 Mock 端口仍在 config.json", _disk().get("mock_port") == 8888)

    # 4) 模拟重启：重新读 config.json，端口应生效
    reloaded = cfg._load_user_config()
    _assert("重启后 config.json 端口可被读到", reloaded.get("port") == 9999)

    # 5) 清空端口（显式传 null，与前端空输入转 null 一致）应移除该键
    c.post("/api/config", json={"port": None, "mock_port": None})
    _assert("显式留空端口后从 config.json 移除", "port" not in _disk())

    print("\nALL PASS: test_config_persist")


if __name__ == "__main__":
    main()
