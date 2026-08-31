# -*- coding: utf-8 -*-
"""请求记录的存储、统计与导出（HAR / JSON）。

每条记录由 browser_manager 解析 DrissionPage 的 DataPacket 后写入，结构见 _packet_to_record。
"""
import copy
import json
import os
import threading
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qsl

import tldextract

from .config import MAX_REQUESTS, MAX_BODY_STORE, MAX_BODY_WS

# 关闭 tldextract 的网络更新，仅用内置 PSL 快照（与 browser_manager 保持一致）
_EXTRACTOR = tldextract.TLDExtract(suffix_list_urls=())


def _norm(p):
    return p if p.startswith("/") else "/" + p


def _body_norm(b):
    """请求/返回体归一化为可比较对象：JSON 解析成 dict/list（键序无关），否则原字符串；空/None 归一为 None。"""
    if b is None:
        return None
    if not isinstance(b, str):
        return b
    s = b.strip()
    if not s:
        return None
    try:
        return json.loads(s)
    except Exception:
        return s


def _same_req(a, b):
    """两条记录是否视为同一条（去重用）：method+path+query+请求体+返回体语义相同。"""
    return (a.get("method") == b.get("method")
            and _norm(a.get("path") or "") == _norm(b.get("path") or "")
            and (a.get("query") or "") == (b.get("query") or "")
            and _body_norm((a.get("request") or {}).get("post_data")) == _body_norm((b.get("request") or {}).get("post_data"))
            and _body_norm((a.get("response") or {}).get("body")) == _body_norm((b.get("response") or {}).get("body")))


def _registered_domain(url):
    try:
        r = _EXTRACTOR(url)
    except Exception:
        return ""
    return r.registered_domain or r.fqdn


def jsonable_body(body):
    """把响应/请求体转成可 JSON 序列化的文本，并返回字节长度。

    返回 (text_or_None, byte_size)。二进制(base64)体返回 (None, size)。
    """
    if body is None:
        return None, 0
    if isinstance(body, (bytes, bytearray)):
        return None, len(body)
    if isinstance(body, (dict, list)):
        try:
            text = json.dumps(body, ensure_ascii=False)
        except Exception:
            text = str(body)
        return text, len(text.encode("utf-8", "replace"))
    text = body if isinstance(body, str) else str(body)
    return text, len(text.encode("utf-8", "replace"))


# 脱敏默认映射：未提供配置时使用。
DEFAULT_MASK = {"cjk": "测", "digit": "1", "alpha": "a"}


def mask_text(text, cfg=None):
    """按配置脱敏文本内容。

    cfg 为 dict，可含键：
      - 'cjk'  ：中日韩汉字的替换串（如 '测'、'*'、'x'）；缺失/None 表示该类别不做替换，原样保留。
      - 'digit'：数字（半角/全角）的替换串；缺失/None 表示保留。
      - 'alpha'：英文字母（半角/全角）的替换串；缺失/None 表示保留。
    其余字符（标点/空格/符号）始终原样保留，以保住结构。
    cfg 为 None 时等同于经典默认（DEFAULT_MASK）。
    """
    if not isinstance(text, str):
        return text
    if cfg is None:
        cfg = DEFAULT_MASK
    cjk_repl = cfg.get("cjk")
    digit_repl = cfg.get("digit")
    alpha_repl = cfg.get("alpha")
    res = []
    for ch in text:
        cp = ord(ch)
        # 中日韩汉字（基本区 + 扩展A + 扩展B）
        if (0x4E00 <= cp <= 0x9FFF) or (0x3400 <= cp <= 0x4DBF) or (0x20000 <= cp <= 0x2A6DF):
            res.append(cjk_repl if cjk_repl is not None else ch)
        elif 0xFF10 <= cp <= 0xFF19:  # 全角数字
            res.append(digit_repl if digit_repl is not None else ch)
        elif "0" <= ch <= "9":
            res.append(digit_repl if digit_repl is not None else ch)
        elif 0xFF41 <= cp <= 0xFF5A or 0xFF21 <= cp <= 0xFF3A:  # 全角字母
            res.append(alpha_repl if alpha_repl is not None else ch)
        elif ("a" <= ch <= "z") or ("A" <= ch <= "Z"):
            res.append(alpha_repl if alpha_repl is not None else ch)
        else:
            res.append(ch)
    return "".join(res)


def _mask_record(rec, cfg=None):
    """返回一份脱敏后的记录副本，不修改原记录。

    仅对「API 请求」(XHR / FETCH) 的请求体和响应体做脱敏。
    静态资源（SCRIPT / STYLESHEET / IMAGE / FONT / MEDIA / DOCUMENT / OTHER 等）
    完全不脱敏——JS/CSS 代码脱敏后变成 aaaaa 既无安全收益又破坏可用性。

    URL / headers / 元数据始终原样保留。
    """
    r = copy.deepcopy(rec)
    rt = ((rec.get("resource_type") or "").upper())
    is_api = rt in ("XHR", "FETCH")
    req = r.get("request") or {}
    if is_api:
        req["post_data"] = mask_text(req.get("post_data"), cfg)
    resp = r.get("response") or {}
    if is_api:
        resp["body"] = mask_text(resp.get("body"), cfg)
    if isinstance(r.get("fail_info"), str):
        r["fail_info"] = mask_text(r["fail_info"], cfg)
    return r


class CaptureStore:
    def __init__(self):
        self._lock = threading.Lock()
        self.persist_path = None      # 持久化 JSON 文件路径；None 表示不落盘
        self._persist_timer = None    # 防抖写盘 Timer
        self._dirty = False           # 数据是否自上次落盘后变更（无变更不写盘）
        self.clear_all()

    # ---------- 持久化（JSON 落盘，重启后恢复录制数据） ----------
    def set_persist(self, path):
        """启用持久化：设置文件路径，若已存在则加载历史录制数据。
        path 为 None 时禁用持久化（测试隔离用）。"""
        if path is None:
            with self._lock:
                self.persist_path = None
                self._dirty = False
                if self._persist_timer is not None:
                    self._persist_timer.cancel()
                    self._persist_timer = None
            return
        self.persist_path = str(path)
        try:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        try:
            with open(self.persist_path, "r", encoding="utf-8") as f:
                obj = json.load(f)
        except Exception:
            return
        reqs = obj.get("requests") or []
        with self._lock:
            self.requests = list(reqs)
            self.by_seq = {}
            max_seq = 0
            for r in reqs:
                s = r.get("seq")
                if isinstance(s, int):
                    self.by_seq[s] = r
                    max_seq = max(max_seq, s)
            self._seq = max_seq
            self._dirty = False

    def persist(self):
        """把当前内存录制数据原子写盘（临时文件 + replace）。可手动/退出时调用。
        仅当数据自上次落盘后有变更才写盘（_dirty 标记）。"""
        path = self.persist_path
        if not path:
            return
        with self._lock:
            if not self._dirty:
                return
            snapshot = [dict(r) for r in self.requests]
            seq = self._seq
            self._dirty = False
        try:
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"seq": seq, "requests": snapshot}, f, ensure_ascii=False)
            os.replace(tmp, path)
        except Exception:
            with self._lock:
                self._dirty = True  # 写盘失败，保留脏标记以便重试

    def _schedule_persist(self):
        """防抖：1 秒内多次变更只写一次盘；Timer 为 daemon，进程退出由 atexit 兜底。"""
        if self.persist_path is None:
            return
        self._dirty = True
        if self._persist_timer is not None:
            self._persist_timer.cancel()
        t = threading.Timer(1.0, self.persist)
        t.daemon = True
        self._persist_timer = t
        t.start()

    # ---------- 写入 ----------
    def clear_all(self):
        with self._lock:
            self.requests = []
            self.by_seq = {}
            self._seq = 0
            self.started_at = time.time()
            self.ended_at = None
            # 「打开」关联的源文件路径（「保存」时覆盖写回它）
            self.source_path = None
        self._schedule_persist()

    def add(self, record):
        """写入一条完整记录（body 已截断到 MAX_BODY_STORE），返回序号 seq。"""
        with self._lock:
            self._seq += 1
            seq = self._seq
            record["seq"] = seq
            record["captured_at"] = time.time()

            # 存储阶段再次截断，避免极端大 body 撑爆内存
            resp = record.get("response") or {}
            b = resp.get("body")
            if isinstance(b, str):
                n = len(b.encode("utf-8", "replace"))
                if n > MAX_BODY_STORE:
                    resp["body"] = b[:MAX_BODY_STORE] + "\n... [truncated for memory]"
                    resp["truncated"] = True

            self.by_seq[seq] = record
            self.requests.append(record)

            if len(self.requests) > MAX_REQUESTS:
                old = self.requests.pop(0)
                self.by_seq.pop(old["seq"], None)
        self._schedule_persist()
        return seq

    def get(self, seq):
        with self._lock:
            return self.by_seq.get(seq)

    def remove(self, seq):
        """删除指定 seq 的记录，返回是否删除成功。"""
        with self._lock:
            rec = self.by_seq.pop(seq, None)
            if rec is None:
                return False
            try:
                self.requests.remove(rec)
            except ValueError:
                pass
        self._schedule_persist()
        return True

    def mark_stopped(self):
        with self._lock:
            self.ended_at = time.time()
        self._dirty = True
        self.persist()   # 停止录制时立即落盘，避免防抖窗口内数据丢失

    def set_mark(self, seq, note=None, tags=None):
        """更新记录的记录级标记：note（备注文本）、tags（标签列表）。None 表示不改该字段。"""
        with self._lock:
            rec = self.by_seq.get(seq)
            if rec is None:
                return False
            if note is not None:
                rec["note"] = note
            if tags is not None:
                rec["tags"] = tags
        self._schedule_persist()
        return True

    def set_pin(self, seq, pinned):
        """固定/取消固定某条记录作为 Mock 返回。以「同一个 API 请求」= (method, path, query)
        为粒度（精确到 query），因此同一 API 的不同 query 可分别固定、互不干扰。
        返回是否成功（记录存在）。"""
        with self._lock:
            rec = self.by_seq.get(seq)
            if rec is None:
                return False
            key = ((rec.get("method") or "").upper(), _norm(rec.get("path") or ""), (rec.get("query") or ""))
            if pinned:
                for other in self.requests:
                    if ((other.get("method") or "").upper(), _norm(other.get("path") or ""), (other.get("query") or "")) == key:
                        if other is rec:
                            other["mock_pin"] = True
                        else:
                            other.pop("mock_pin", None)
            else:
                rec.pop("mock_pin", None)
        self._schedule_persist()
        return True

    def set_annotation(self, seq, target, path, note):
        """设置/删除某条记录的字段级注释。
        target: "req"（请求体）| "res"（响应体）；path: JSON 字段路径（如 data.items.0.id）。
        note 为空字符串 = 删除该注释。返回是否成功。"""
        with self._lock:
            rec = self.by_seq.get(seq)
            if rec is None:
                return False
            ann = dict(rec.get("annotations") or {})
            tgt = dict(ann.get(target) or {})
            if note:
                tgt[path] = note
            else:
                tgt.pop(path, None)
            if tgt:
                ann[target] = tgt
            else:
                ann.pop(target, None)
            if ann:
                rec["annotations"] = ann
            else:
                rec.pop("annotations", None)
        self._schedule_persist()
        return True

    # ---------- 轻量拷贝（用于 WebSocket 实时推送） ----------
    def light(self, rec):
        """返回一份 body 截断到 MAX_BODY_WS 的副本，减小实时推送体积。"""
        r = dict(rec)
        resp = dict(rec.get("response") or {})
        b = resp.get("body")
        if isinstance(b, str):
            n = len(b.encode("utf-8", "replace"))
            if n > MAX_BODY_WS:
                resp["body"] = b[:MAX_BODY_WS] + "\n... [truncated, open detail for full]"
                resp["truncated"] = True
        r["response"] = resp
        return r

    # ---------- 统计 ----------
    def stats(self):
        with self._lock:
            total = len(self.requests)
            total_size = 0
            domains = set()
            by_type = {}
            by_method = {}
            errors = 0
            for r in self.requests:
                total_size += (r.get("response", {}) or {}).get("size_bytes", 0) or 0
                rd = r.get("registered_domain") or r.get("host") or "unknown"
                domains.add(rd)
                t = (r.get("resource_type") or "Other").upper()
                by_type[t] = by_type.get(t, 0) + 1
                m = (r.get("method") or "?").upper()
                by_method[m] = by_method.get(m, 0) + 1
                if r.get("is_failed") or (r.get("response", {}) or {}).get("status", 0) >= 400:
                    errors += 1
            return {
                "total": total,
                "total_size": total_size,
                "domains": len(domains),
                "by_type": by_type,
                "by_method": by_method,
                "errors": errors,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
        }

    # ---------- Mock 数据源 ----------
    def get_mock_data(self):
        """返回可用于 Mock 的录制记录（仅 XHR/FETCH 类型），结构与 mock 匹配所需一致。

        实时读取当前内存中的录制，录制 / 编辑 / Mock 可并发生效。
        字段：method / path / query / seq / note / tags / mock_pin / url /
        req_body（请求体）/ response{status,headers,body}。
        """
        with self._lock:
            out = []
            for r in self.requests:
                rt = (r.get("resource_type") or "").upper()
                if rt not in ("XHR", "FETCH"):
                    continue
                resp = r.get("response") or {}
                req = r.get("request") or {}
                out.append({
                    "method": r.get("method"),
                    "path": r.get("path") or "",
                    "query": r.get("query") or "",
                    "seq": r.get("seq"),
                    "note": r.get("note") or "",
                    "tags": r.get("tags") or [],
                    "mock_pin": bool(r.get("mock_pin")),
                    "url": r.get("url") or "",
                    "req_body": req.get("post_data"),
                    "response": {
                        "status": resp.get("status", 200),
                        "headers": resp.get("headers") or {},
                        "body": resp.get("body"),
                    },
                })
            return out

    # ---------- 导出 ----------
    def export_json(self, desensitize=False, mask_cfg=None):
        with self._lock:
            if desensitize:
                requests = [_mask_record(r, mask_cfg) for r in self.requests]
            else:
                requests = self.requests
            return {
                "meta": {
                    "generator": "API Recorder",
                    "version": "0.1.0",
                    "exported_at": time.time(),
                    "count": len(self.requests),
                    "desensitized": bool(desensitize),
                },
                "requests": requests,
            }

    def export_har(self, desensitize=False, mask_cfg=None):
        with self._lock:
            entries = []
            for r in self.requests:
                src = _mask_record(r, mask_cfg) if desensitize else r
                entries.append(self._to_har_entry(src))
            return {
                "log": {
                    "version": "1.2",
                    "creator": {"name": "API Recorder", "version": "0.1.0"},
                    "entries": entries,
                }
            }

    @staticmethod
    def _to_har_entry(r):
        req = r.get("request", {}) or {}
        resp = r.get("response", {}) or {}
        parsed = urlparse(r.get("url", ""))

        req_headers = [{"name": k, "value": str(v)} for k, v in (req.get("headers") or {}).items()]
        resp_headers = [{"name": k, "value": str(v)} for k, v in (resp.get("headers") or {}).items()]
        query = [{"name": k, "value": v} for k, v in parse_qsl(parsed.query, keep_blank_values=True)]

        post_text = req.get("post_data")
        if isinstance(post_text, (dict, list)):
            post_text = json.dumps(post_text, ensure_ascii=False)
        post_data = None
        if post_text:
            post_data = {
                "mimeType": (req.get("headers") or {}).get("Content-Type", "application/octet-stream"),
                "text": post_text,
            }

        body_text = resp.get("body")
        if isinstance(body_text, (dict, list)):
            body_text = json.dumps(body_text, ensure_ascii=False)
        content = {
            "size": resp.get("size_bytes", 0) or 0,
            "mimeType": resp.get("mime_type") or "application/octet-stream",
        }
        if body_text:
            content["text"] = body_text

        entry = {
            "startedDateTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r.get("captured_at", time.time()))),
            "time": r.get("duration_ms") or 0,
            "request": {
                "method": r.get("method"),
                "url": r.get("url"),
                "httpVersion": "HTTP/1.1",
                "headers": req_headers,
                "queryString": query,
                "cookies": [],
                "headersSize": -1,
                "bodySize": req.get("post_size") or -1,
                "postData": post_data,
            },
            "response": {
                "status": resp.get("status") or 0,
                "statusText": resp.get("status_text") or "",
                "httpVersion": "HTTP/1.1",
                "headers": resp_headers,
                "cookies": [],
                "content": content,
                "redirectURL": "",
                "headersSize": -1,
                "bodySize": resp.get("size_bytes") or -1,
            },
            "cache": {},
            "timings": r.get("timing") or {},
            "_resourceType": (r.get("resource_type") or "other").lower(),
            "_failed": bool(r.get("is_failed")),
        }
        # 标记信息：本工具自定义字段（_ 前缀），标准 HAR 工具会忽略
        if r.get("note"):
            entry["_note"] = r["note"]
        if r.get("tags"):
            entry["_tags"] = r["tags"]
        if r.get("annotations"):
            entry["_annotations"] = r["annotations"]
        return entry

    # ---------- 导入 ----------
    def import_from_json(self, obj, clear=True, dedup=True):
        """导入本工具导出的 JSON：{'meta':..., 'requests':[record,...]}。
        clear=True 时替换当前记录（先 clear_all），否则追加到现有记录。
        dedup=True 时跳过与库中已有记录完全相同的条目（method+path+query+请求体+返回体语义）。
        返回 (导入条数, 去重条数)。"""
        requests = obj.get("requests")
        if not isinstance(requests, list):
            raise ValueError("JSON 格式缺少 requests 数组")
        if clear:
            self.clear_all()
        n = 0
        dup = 0
        existing = [] if clear else list(self.requests)
        for rec in requests:
            if not isinstance(rec, dict):
                continue
            rec.pop("seq", None)
            rec.pop("captured_at", None)
            if dedup and any(_same_req(rec, e) for e in existing):
                dup += 1
                continue
            self.add(rec)
            existing.append(rec)
            n += 1
        self.mark_stopped()
        return n, dup

    def import_from_har(self, obj, clear=True, dedup=True):
        """导入 HAR 1.2（本工具导出或 Chrome/Fiddler 等标准 HAR 均可）：
        {'log': {'entries':[entry,...]}}。clear=True 时替换当前记录（先 clear_all），
        否则追加到现有记录。dedup=True 时跳过与库中已有记录完全相同的条目。
        返回 (导入条数, 去重条数)。"""
        log = obj.get("log") or {}
        entries = log.get("entries")
        if not isinstance(entries, list):
            raise ValueError("HAR 格式缺少 log.entries 数组")
        if clear:
            self.clear_all()
        n = 0
        dup = 0
        existing = [] if clear else list(self.requests)
        for entry in entries:
            rec = self._from_har_entry(entry)
            if not rec:
                continue
            if dedup and any(_same_req(rec, e) for e in existing):
                dup += 1
                continue
            self.add(rec)
            existing.append(rec)
            n += 1
        self.mark_stopped()
        return n, dup

    @staticmethod
    def _from_har_entry(entry):
        """把一条 HAR entry 还原成本工具记录。无法解析（缺 url）时返回 None。"""
        if not isinstance(entry, dict):
            return None
        req = entry.get("request", {}) or {}
        resp = entry.get("response", {}) or {}
        url = req.get("url") or ""
        if not url:
            return None
        parsed = urlparse(url)
        host = parsed.netloc
        reg = _registered_domain(url) or host

        req_headers = {
            h.get("name"): h.get("value")
            for h in (req.get("headers") or [])
            if isinstance(h, dict) and h.get("name") is not None
        }
        resp_headers = {
            h.get("name"): h.get("value")
            for h in (resp.get("headers") or [])
            if isinstance(h, dict) and h.get("name") is not None
        }

        post = req.get("postData") or {}
        post_text = post.get("text")
        if isinstance(post_text, (dict, list)):
            post_text = json.dumps(post_text, ensure_ascii=False)
        post_size = req.get("bodySize")
        if not (isinstance(post_size, int) and post_size >= 0):
            post_size = len(post_text.encode("utf-8", "replace")) if isinstance(post_text, str) else 0

        content = resp.get("content") or {}
        body_text = content.get("text")
        if isinstance(body_text, (dict, list)):
            body_text = json.dumps(body_text, ensure_ascii=False)
        mime = content.get("mimeType") or resp_headers.get("Content-Type") or "application/octet-stream"

        size = content.get("size")
        if not (isinstance(size, int) and size >= 0):
            size = resp.get("bodySize")
        if not (isinstance(size, int) and size >= 0):
            size = len(body_text.encode("utf-8", "replace")) if isinstance(body_text, str) else 0
        body_size = len(body_text.encode("utf-8", "replace")) if isinstance(body_text, str) else 0

        timing = entry.get("timings") or {}
        duration = entry.get("time")
        if not isinstance(duration, (int, float)):
            duration = None
        resource_type = (entry.get("_resourceType") or "other").upper()
        is_failed = bool(entry.get("_failed"))

        rec = {
            "url": url,
            "scheme": parsed.scheme,
            "host": host,
            "registered_domain": reg,
            "path": parsed.path,
            "query": parsed.query,
            "method": req.get("method") or "GET",
            "resource_type": resource_type,
            "is_failed": is_failed,
            "fail_info": None,
            "request": {
                "headers": req_headers,
                "post_data": post_text,
                "post_size": post_size,
            },
            "response": {
                "status": resp.get("status"),
                "status_text": resp.get("statusText") or "",
                "headers": resp_headers,
                "mime_type": mime,
                "body": body_text,
                "body_size": body_size,
                "size_bytes": size if isinstance(size, int) else body_size,
            },
            "timing": timing,
            "duration_ms": duration,
        }
        # 读回本工具导出的标记字段（_note/_tags/_annotations）
        if entry.get("_note"):
            rec["note"] = entry["_note"]
        if entry.get("_tags"):
            rec["tags"] = entry["_tags"]
        if entry.get("_annotations"):
            rec["annotations"] = entry["_annotations"]
        return rec
