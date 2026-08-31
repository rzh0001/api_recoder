# -*- coding: utf-8 -*-
"""共享状态：store / browser_manager / WebSocket 客户端集合与广播函数。"""
import atexit
import threading
from pathlib import Path

from .capture_store import CaptureStore
from .browser_manager import BrowserManager
from .mock_manager import MockManager

store = CaptureStore()
store.set_persist(Path(__file__).resolve().parent.parent / "data" / "records.json")
atexit.register(store.persist)
ws_clients = set()
ws_lock = threading.Lock()


def broadcast(message):
    """向所有已连接的 WebSocket 客户端推送一条文本消息。"""
    with ws_lock:
        dead = []
        for ws in list(ws_clients):
            try:
                ws.send(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            ws_clients.discard(ws)


browser_manager = BrowserManager(store, broadcast)
mock_manager = MockManager()
