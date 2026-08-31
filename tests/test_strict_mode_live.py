# -*- coding: utf-8 -*-
"""验证 match_mode 匹配模式：默认严格，仅显式配置为模糊时才回退匹配；config.json 改动无需重启即可生效。"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app.config as cfg


def _assert(name, cond):
    if not cond:
        print("FAIL:", name)
        raise SystemExit(1)
    print("ok:", name)


def main():
    tmp = Path(tempfile.mkdtemp())
    cfg_file = tmp / "config.json"
    cfg.CONFIG_FILE = cfg_file

    # 1) 无任何配置：默认严格匹配
    if cfg_file.exists():
        cfg_file.unlink()
    _assert("无配置时 get_match_mode() 默认严格(True)", cfg.get_match_mode() is True)

    # 2) config.json 显式 match_mode=false -> 模糊匹配
    cfg_file.write_text(json.dumps({"match_mode": False}, ensure_ascii=False))
    _assert("config.json match_mode=false 时 get_match_mode() 为 False", cfg.get_match_mode() is False)

    # 3) config.json 显式 match_mode="fuzzy" -> 模糊匹配
    cfg_file.write_text(json.dumps({"match_mode": "fuzzy"}, ensure_ascii=False))
    _assert("config.json match_mode='fuzzy' 时 get_match_mode() 为 False", cfg.get_match_mode() is False)

    # 4) config.json 显式 match_mode=true -> 严格匹配
    cfg_file.write_text(json.dumps({"match_mode": True}, ensure_ascii=False))
    _assert("config.json match_mode=true 时 get_match_mode() 为 True", cfg.get_match_mode() is True)

    # 5) 动态改写 config.json，无需重启进程即可生效
    cfg_file.write_text(json.dumps({"match_mode": False}, ensure_ascii=False))
    _assert("改写 config.json 为 false 后 get_match_mode() 为 False", cfg.get_match_mode() is False)
    cfg_file.write_text(json.dumps({}, ensure_ascii=False))
    _assert("删除 match_mode 键后回退默认严格", cfg.get_match_mode() is True)

    # 6) 环境变量优先于 config.json
    os.environ["API_RECORDER_MATCH_MODE"] = "fuzzy"
    _assert("环境变量 API_RECORDER_MATCH_MODE=fuzzy 优先于 config.json", cfg.get_match_mode() is False)
    os.environ["API_RECORDER_MATCH_MODE"] = "strict"
    _assert("环境变量 API_RECORDER_MATCH_MODE=strict 为严格", cfg.get_match_mode() is True)
    os.environ["API_RECORDER_MATCH_MODE"] = "0"
    _assert("环境变量 API_RECORDER_MATCH_MODE=0 为模糊", cfg.get_match_mode() is False)
    del os.environ["API_RECORDER_MATCH_MODE"]

    # 7) 环境变量清空后回退到 config.json（当前为 {} -> 默认严格）
    _assert("环境变量移除后回退默认严格", cfg.get_match_mode() is True)

    print("\nALL PASS: test_strict_mode_live")


if __name__ == "__main__":
    main()
