# -*- coding: utf-8 -*-
"""浏览器管理：用 DrissionPage 拉起浏览器、对所有 tab 挂网络监听、解析并广播请求。

- builtin 模式：使用 software 自带的 Chromium（首次启动从 Chrome-for-Testing 下载到 runtime/chromium/）。
- local 模式：使用本机已装的 Chrome / Edge（自动探测或显式指定路径）。
"""
import json
import os
import threading
import time
from urllib.parse import urlparse

import tldextract
from DrissionPage import ChromiumOptions, ChromiumPage

from .capture_store import jsonable_body
from .config import (
    BUNDLED_CHROME,
    CHROMIUM_DIR,
    DEFAULT_BROWSER_MODE,
    DEFAULT_LOCAL_BROWSER,
    LOCAL_BROWSER_CANDIDATES,
    USER_DATA_DIR,
)

# 本机浏览器候选路径（按内核分组），用于「本机浏览器」模式下让用户明确选 Chrome / Edge
_CHROME_REG_KEYS = [
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
    r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
]
_EDGE_REG_KEYS = [
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
    r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
]
_CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Users\{}\AppData\Local\Google\Chrome\Application\chrome.exe".format(os.environ.get("USERNAME", "")),
]
_EDGE_CANDIDATES = [
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Users\{}\AppData\Local\Microsoft\Edge\Application\msedge.exe".format(os.environ.get("USERNAME", "")),
]

# 关闭 tldextract 的网络更新，仅用内置 PSL 快照
_EXTRACTOR = tldextract.TLDExtract(suffix_list_urls=())


def registered_domain(url):
    try:
        r = _EXTRACTOR(url)
    except Exception:
        return ""
    return r.registered_domain or r.fqdn


class BrowserManager:
    def __init__(self, store, broadcast):
        self.store = store
        self.broadcast = broadcast
        self.browser = None
        self.mode = DEFAULT_BROWSER_MODE
        self._running = False
        self._tab_objs = {}      # tab_id -> tab 对象(含 .listen)
        self._threads = []
        self._watcher = None
        self._lock = threading.Lock()
        self.status = "idle"     # idle | launching | recording | stopping | error
        self.error = None
        self.started_at = None

    # ---------------- 生命周期 ----------------
    def launch(self, mode=None, local_path=None, start_url="about:blank", browser=None):
        with self._lock:
            if self._running:
                return self.status_info()
            self.mode = mode or self.mode or DEFAULT_BROWSER_MODE
            self.status = "launching"
            self.error = None
        try:
            co = ChromiumOptions()
            if self.mode == "local":
                path = local_path or DEFAULT_LOCAL_BROWSER or self._detect_local_browser(browser)
                if not path or not os.path.exists(path):
                    raise RuntimeError("未找到本机浏览器，请在设置中指定 Chrome/Edge 路径")
                co.set_browser_path(path)
            else:
                path = self._builtin_browser_path()
                if not path:
                    # 自带内核不存在：优先用本机已装的 Chrome/Edge（免下载、稳定），
                    # 只有本机也没有浏览器时才尝试下载内置 Chromium，避免在本来就有
                    # 浏览器的机器上傻等/卡在下载（国内访问下载源经常很慢甚至超时）。
                    local = self._detect_local_browser(browser)
                    if local:
                        path = local
                        self.mode = "local"
                    else:
                        try:
                            path = self._download_chromium()
                        except Exception as e:
                            raise RuntimeError(
                                f"未找到本机浏览器，且内置内核下载失败({e})，请检查网络或手动指定浏览器路径"
                            )
                co.set_browser_path(path)

            co.set_user_data_path(str(USER_DATA_DIR / "default"))
            co.auto_port()
            co.headless(False)
            co.set_argument("--no-first-run")
            co.set_argument("--no-default-browser-check")
            co.set_argument("--start-maximized")
            co.set_argument("--disable-infobars")
            # 随包 Chrome 无 Google Update 服务，显式关掉后台联网与组件更新，
            # 避免无谓的网络尝试与控制台噪音。
            co.set_argument("--disable-background-networking")
            co.set_argument("--disable-component-update")
            co.set_argument("--disable-features=Translate,OptimizationHints,MediaRouter")

            self.browser = ChromiumPage(addr_or_opts=co)
            try:
                self.browser.get(start_url or "about:blank")
            except Exception:
                pass

            self._running = True
            self.status = "recording"
            self.started_at = time.time()
            self.store.started_at = self.started_at
            self._tab_objs = {}
            self._threads = []
            self._start_watcher()
            self._attach_all_tabs()
        except Exception as e:
            self.status = "error"
            self.error = str(e)
            self._running = False
            try:
                if self.browser is not None:
                    self.browser.quit(timeout=3, force=True, del_data=False)
            except Exception:
                pass
            self.browser = None
            raise
        return self.status_info()

    def stop(self):
        with self._lock:
            if not self._running:
                return self.status_info()
            self._running = False
        self.status = "stopping"
        for tid, tab in list(self._tab_objs.items()):
            try:
                tab.listen.pause()
            except Exception:
                pass
        try:
            if self.browser is not None:
                self.browser.quit(timeout=5, force=True, del_data=False)
        except Exception:
            pass
        self.browser = None
        self.store.mark_stopped()
        self.status = "idle"
        try:
            self.broadcast(json.dumps({"type": "status", "data": self.status_info()}, ensure_ascii=False))
        except Exception:
            pass
        return self.status_info()

    def status_info(self):
        return {
            "status": self.status,
            "mode": self.mode,
            "error": self.error,
            "browser_open": self.browser is not None,
            "tabs": len(self._tab_objs),
        }

    # ---------------- 多 tab 监听 ----------------
    def _start_watcher(self):
        self._watcher = threading.Thread(target=self._watch_tabs, daemon=True)
        self._watcher.start()

    def _watch_tabs(self):
        while self._running and self.browser is not None:
            try:
                ids = self.browser.tab_ids
            except Exception:
                break
            for tid in ids:
                if tid not in self._tab_objs:
                    self._attach_tab(tid)
            time.sleep(1.0)

    def _attach_all_tabs(self):
        try:
            ids = self.browser.tab_ids
        except Exception:
            return
        for tid in ids:
            self._attach_tab(tid)

    def _attach_tab(self, tid):
        try:
            tab = self.browser.get_tab(tid)
            tab.listen.start(method=True, res_type=True)
        except Exception:
            return
        self._tab_objs[tid] = tab
        t = threading.Thread(target=self._capture_loop, args=(tab, tid), daemon=True)
        t.start()
        self._threads.append(t)

    def _capture_loop(self, tab, tid):
        try:
            for packet in tab.listen.steps():
                self._on_packet(packet)
        except Exception:
            pass
        finally:
            self._tab_objs.pop(tid, None)

    def _on_packet(self, packet):
        try:
            record = self._packet_to_record(packet)
        except Exception:
            return
        if not record.get("url"):
            return
        seq = self.store.add(record)
        try:
            self.broadcast(
                json.dumps({"type": "request", "data": self.store.light(record)}, ensure_ascii=False)
            )
        except Exception:
            pass

    # ---------------- 解析 ----------------
    def _packet_to_record(self, packet):
        raw_req = getattr(packet, "_raw_request", None) or {}
        req = raw_req.get("request", {}) if isinstance(raw_req, dict) else {}
        url = req.get("url") or getattr(packet, "url", "")
        parsed = urlparse(url)
        host = parsed.netloc
        reg = registered_domain(url) or host
        method = req.get("method") or getattr(packet, "method", "")
        rtype = getattr(packet, "resourceType", None)
        is_failed = bool(getattr(packet, "is_failed", False))

        req_headers = {
            k: (v if isinstance(v, str) else str(v)) for k, v in (req.get("headers") or {}).items()
        }
        try:
            post = packet.request.postData
        except Exception:
            post = False
        req_body_text, req_body_size = jsonable_body(post if post else None)

        raw_resp = getattr(packet, "_raw_response", None)
        status = status_text = mime = timing = None
        resp_headers = {}
        encoded = None
        resp_body_text = None
        resp_body_size = 0
        if raw_resp:
            status = raw_resp.get("status")
            status_text = raw_resp.get("statusText")
            resp_headers = {
                k: (v if isinstance(v, str) else str(v))
                for k, v in (raw_resp.get("headers") or {}).items()
            }
            mime = raw_resp.get("mimeType")
            timing = raw_resp.get("timing")
            encoded = raw_resp.get("encodedDataLength")
            try:
                body = packet.response.body
            except Exception:
                body = None
            resp_body_text, resp_body_size = jsonable_body(body)

        size = encoded if isinstance(encoded, int) else resp_body_size
        duration = None
        if isinstance(timing, dict) and timing.get("receiveHeadersEnd") is not None:
            duration = round(timing["receiveHeadersEnd"] * 1000, 1)

        return {
            "url": url,
            "scheme": parsed.scheme,
            "host": host,
            "registered_domain": reg,
            "path": parsed.path,
            "query": parsed.query,
            "method": method,
            "resource_type": (rtype or "Other").upper(),
            "is_failed": is_failed,
            "fail_info": (
                dict(getattr(packet, "_raw_fail_info", None) or {}) if is_failed else None
            ),
            "request": {
                "headers": req_headers,
                "post_data": req_body_text,
                "post_size": req_body_size,
            },
            "response": {
                "status": status,
                "status_text": status_text,
                "headers": resp_headers,
                "mime_type": mime,
                "body": resp_body_text,
                "body_size": resp_body_size,
                "size_bytes": size if size is not None else resp_body_size,
            },
            "timing": timing,
            "duration_ms": duration,
        }

    # ---------------- 浏览器探测 / 下载 ----------------
    def _detect_local_browser(self, browser=None):
        """探测本机浏览器路径。

        browser: None/"auto" 同时探测 Chrome 与 Edge；"chrome" 仅 Chrome；"edge" 仅 Edge。
        优先级：DEFAULT_LOCAL_BROWSER(env) > 随包捆绑的 Chrome（仅非 edge 时）> 系统注册表/常见路径。
        随包捆绑的 Chrome 优先用于抓包（不存在时回退系统浏览器）。
        """
        if DEFAULT_LOCAL_BROWSER and os.path.exists(DEFAULT_LOCAL_BROWSER):
            return DEFAULT_LOCAL_BROWSER
        # 随包捆绑的 Chrome 109：除非用户显式要求 edge，否则优先使用
        if BUNDLED_CHROME and BUNDLED_CHROME.exists() and browser != "edge":
            return str(BUNDLED_CHROME)
        if browser == "chrome":
            reg_keys, candidates = _CHROME_REG_KEYS, _CHROME_CANDIDATES
        elif browser == "edge":
            reg_keys, candidates = _EDGE_REG_KEYS, _EDGE_CANDIDATES
        else:
            reg_keys = _CHROME_REG_KEYS + _EDGE_REG_KEYS
            candidates = _CHROME_CANDIDATES + _EDGE_CANDIDATES
        try:
            import winreg

            for key_path in reg_keys:
                try:
                    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path) as k:
                        val, _ = winreg.QueryValueEx(k, "")
                        if val and os.path.exists(val):
                            return val
                except Exception:
                    pass
        except Exception:
            pass
        for p in candidates:
            if p and os.path.exists(p):
                return p
        return None

    def _cf_platform(self):
        import platform as _p

        sysn = _p.system().lower()
        mach = _p.machine().lower()
        if sysn == "windows":
            return "win64"
        if sysn == "linux":
            return "linux64"
        if sysn == "darwin":
            return "mac-arm64" if "arm" in mach else "mac-x64"
        return "win64"

    def _builtin_browser_path(self):
        plat = self._cf_platform()
        if plat.startswith("win"):
            exe = CHROMIUM_DIR / "chrome-win64" / "chrome.exe"
        elif plat.startswith("linux"):
            exe = CHROMIUM_DIR / "chrome-linux64" / "chrome"
        elif plat.startswith("mac"):
            exe = CHROMIUM_DIR / "chrome-mac-x64" / "Google Chrome"
        else:
            exe = None
        if exe and exe.exists():
            return str(exe)
        return None

    def _download_chromium(self):
        import requests
        import zipfile

        api = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
        data = requests.get(api, timeout=30).json()
        stable = data["channels"]["Stable"]
        plat = self._cf_platform()
        url = None
        for d in stable["downloads"]["chrome"]:
            if d["platform"] == plat:
                url = d["url"]
                break
        if not url:
            raise RuntimeError(f"无匹配平台({plat})的 Chromium 下载")
        r = requests.get(url, stream=True, timeout=180)
        r.raise_for_status()
        zip_path = CHROMIUM_DIR / f"chrome-{plat}.zip"
        with open(zip_path, "wb") as f:
            for chunk in r.iter_content(1024 * 1024):
                f.write(chunk)
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(CHROMIUM_DIR)
        zip_path.unlink()
        return self._builtin_browser_path()
