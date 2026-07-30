// -*- coding: utf-8 -*-
"use strict";

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);

// pywebview 就绪 Promise（桌面窗口下 window.pywebview 在 pywebviewready 事件后才注入）
window.pywebviewReady = new Promise((resolve) => {
  if (window.pywebview) return resolve(window.pywebview);
  window.addEventListener("pywebviewready", () => resolve(window.pywebview), { once: true });
});

function base64FromArrayBuffer(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
const treeEl = $("tree");
const detailEl = $("detail");
const statusEl = $("status");
const statsEl = $("stats");

const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const clearBtn = $("clearBtn");
const modeSel = $("mode");
const localPathEl = $("localPath");
const startUrlEl = $("startUrl");

const searchEl = $("search");
const methodFilterEl = $("methodFilter");
const typeFilterEl = $("typeFilter");
const onlyApiEl = $("onlyApi");
const onlyErrorEl = $("onlyError");

// ---------------- 状态 ----------------
let allRequests = [];
let collapsed = new Set();
let ws = null;
let renderTimer = null;
let activeSeq = null;
let currentDetail = null;

// ---------------- 工具 ----------------
function esc(x) {
  if (x === null || x === undefined) return "";
  return String(x)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function statusClass(r) {
  if (r.is_failed) return "s-fail";
  const s = r.response && r.response.status;
  if (!s) return "s-fail";
  return "s-" + String(s)[0];
}

function methodClass(r) {
  const m = (r.method || "OTHER").toUpperCase();
  return ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(m) ? m : "OTHER";
}

function pretty(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) {
    return text;
  }
}

function passFilter(r) {
  const f = filters;
  if (f.method !== "all" && (r.method || "").toUpperCase() !== f.method) return false;
  if (f.type !== "all" && (r.resource_type || "").toUpperCase() !== f.type) return false;
  if (f.onlyApi && !["XHR", "FETCH"].includes((r.resource_type || "").toUpperCase())) return false;
  if (f.onlyError) {
    const s = r.response && r.response.status;
    if (!r.is_failed && !(s >= 400)) return false;
  }
  if (f.search) {
    const q = f.search.toLowerCase();
    const hay = ((r.url || "") + " " + (r.host || "") + " " + (r.registered_domain || "") + " " + (r.method || "")).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

const filters = { search: "", method: "all", type: "all", onlyApi: false, onlyError: false };

// ---------------- WebSocket ----------------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (e2) { return; }
    handleMsg(msg);
  };
  ws.onclose = () => { setTimeout(connect, 1500); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function handleMsg(msg) {
  if (msg.type === "snapshot") {
    allRequests = msg.requests || [];
    if (msg.status) updateStatus(msg.status);
    scheduleRender();
  } else if (msg.type === "request") {
    if (msg.data) allRequests.push(msg.data);
    scheduleRender();
  } else if (msg.type === "status") {
    if (msg.data) updateStatus(msg.data);
  } else if (msg.type === "cleared") {
    allRequests = [];
    scheduleRender();
  } else if (msg.type === "mock") {
    if (msg.status) updateMockUI(msg.status);
  }
}

// ---------------- 状态/统计 ----------------
function updateStatus(info) {
  if (!info) return;
  const map = {
    idle: ["空闲", "status-idle"],
    launching: ["启动中…", "status-launching"],
    recording: ["录制中" + (info.tabs ? " · " + info.tabs + " tab" : ""), "status-recording"],
    stopping: ["停止中…", "status-stopping"],
    error: ["错误", "status-error"],
  };
  const [text, cls] = map[info.status] || ["空闲", "status-idle"];
  statusEl.textContent = text;
  statusEl.className = "status " + cls;
  const running = info.status === "recording" || info.status === "launching";
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  if (info.status === "error" && info.error) {
    statusEl.title = info.error;
  }
}

function updateStats(visible) {
  const total = allRequests.length;
  const domains = new Set(allRequests.map((r) => r.registered_domain || r.host)).size;
  const totalSize = allRequests.reduce((s, r) => s + ((r.response && r.response.size_bytes) || 0), 0);
  const errors = allRequests.filter((r) => r.is_failed || (r.response && r.response.status >= 400)).length;
  statsEl.textContent = `显示 ${visible}/${total} · 域 ${domains} · ${fmtSize(totalSize)} · 错误 ${errors}`;
}

// ---------------- Mock 服务状态 ----------------
const startMockBtn = $("startMock");
const stopMockBtn = $("stopMock");
const mockStatusEl = $("mockStatus");

function updateMockUI(info) {
  if (!info) return;
  if (info.running) {
    startMockBtn.disabled = true;
    stopMockBtn.disabled = false;
    mockStatusEl.innerHTML = `Mock 运行中：<a href="${esc(info.url)}" target="_blank" rel="noopener">${esc(info.url)}</a> · ${info.count} 个接口`;
    mockStatusEl.className = "status status-recording";
  } else {
    startMockBtn.disabled = false;
    stopMockBtn.disabled = true;
    mockStatusEl.textContent = "Mock 未启动";
    mockStatusEl.className = "status status-idle";
  }
}

// ---------------- 渲染树 ----------------
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 200);
}

function reqRowHtml(r) {
  const sc = statusClass(r);
  const mc = methodClass(r);
  const statusTxt = r.is_failed ? "FAIL" : (r.response && r.response.status != null ? r.response.status : "—");
  const path = (r.path || "/") + (r.query ? "?" + r.query : "");
  return (
    `<div class="row req-row${r.seq === activeSeq ? " active" : ""}" data-seq="${r.seq}">` +
    `<span class="caret"></span>` +
    `<span class="m m-${mc}">${esc(r.method)}</span>` +
    `<span class="s ${sc}">${esc(String(statusTxt))}</span>` +
    `<span class="t-type">${esc(r.resource_type)}</span>` +
    `<span class="path-text" title="${esc(r.url)}">${esc(path)}</span>` +
    `<span class="size">${fmtSize(r.response && r.response.size_bytes)}</span>` +
    `<span class="dur">${r.duration_ms != null ? r.duration_ms + "ms" : ""}</span>` +
    `</div>`
  );
}

function render() {
  const groups = new Map();
  let visible = 0;
  for (const r of allRequests) {
    if (!passFilter(r)) continue;
    visible++;
    const rd = r.registered_domain || r.host || "unknown";
    const host = r.host || "unknown";
    if (!groups.has(rd)) groups.set(rd, new Map());
    const hosts = groups.get(rd);
    if (!hosts.has(host)) hosts.set(host, []);
    hosts.get(host).push(r);
  }

  if (groups.size === 0) {
    treeEl.innerHTML = `<div class="empty">${
      allRequests.length ? "没有符合筛选条件的请求" : "点击「开始录制」拉起浏览器，这里会按域名实时组织所有请求。"
    }</div>`;
    updateStats(visible);
    return;
  }

  const domainArr = [...groups.entries()].sort(
    (a, b) => countRecs(b[1]) - countRecs(a[1])
  );

  let html = "";
  for (const [rd, hosts] of domainArr) {
    const rdKey = "d:" + rd;
    const rdCollapsed = collapsed.has(rdKey);
    const rdRecs = flat(hosts);
    const rdSize = rdRecs.reduce((s, r) => s + ((r.response && r.response.size_bytes) || 0), 0);
    html +=
      `<div class="node"><div class="row domain-row" data-toggle="${esc(rdKey)}">` +
      `<span class="caret">${rdCollapsed ? "▸" : "▾"}</span>` +
      `<span class="domain-name">${esc(rd)}</span>` +
      `<span class="badge">${rdRecs.length}</span>` +
      `<span class="size">${fmtSize(rdSize)}</span>` +
      `</div><div class="children${rdCollapsed ? " hidden" : ""}">`;

    const hostArr = [...hosts.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [host, recs] of hostArr) {
      // 当 registered_domain 与 host 相同时（如 localhost:4000、IP 地址等），
      // 跳过重复的 host 中间层，避免出现两个名字一样的节点。
      if (host === rd) {
        for (const r of recs) html += reqRowHtml(r);
        continue;
      }
      const hKey = "h:" + rd + "/" + host;
      const hCollapsed = collapsed.has(hKey);
      const hSize = recs.reduce((s, r) => s + ((r.response && r.response.size_bytes) || 0), 0);
      html +=
        `<div class="node"><div class="row host-row" data-toggle="${esc(hKey)}">` +
        `<span class="caret">${hCollapsed ? "▸" : "▾"}</span>` +
        `<span class="host-name">${esc(host)}</span>` +
        `<span class="badge">${recs.length}</span>` +
        `<span class="size">${fmtSize(hSize)}</span>` +
        `</div><div class="children${hCollapsed ? " hidden" : ""}">`;
      for (const r of recs) html += reqRowHtml(r);
      html += `</div></div>`;
    }
    html += `</div></div>`;
  }
  treeEl.innerHTML = html;
  updateStats(visible);
}

function countRecs(hostsMap) {
  let n = 0;
  for (const arr of hostsMap.values()) n += arr.length;
  return n;
}
function flat(hostsMap) {
  const out = [];
  for (const arr of hostsMap.values()) out.push(...arr);
  return out;
}

function toggle(key) {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  render();
}

treeEl.addEventListener("click", (e) => {
  const t = e.target.closest("[data-toggle]");
  if (t) { toggle(t.getAttribute("data-toggle")); return; }
  const req = e.target.closest(".req-row");
  if (req) {
    openDetail(parseInt(req.getAttribute("data-seq"), 10));
    document.querySelectorAll(".req-row.active").forEach((el) => el.classList.remove("active"));
    req.classList.add("active");
  }
});

// ---------------- 详情 ----------------
function openDetail(seq) {
  activeSeq = seq;
  // 先从本地找（含截断 body），同时拉完整记录
  const local = allRequests.find((r) => r.seq === seq);
  if (local) renderDetail(local);
  fetch(`/api/request/${seq}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((rec) => { if (rec) { currentDetail = rec; renderDetail(rec); } })
    .catch(() => {});
}

let currentTab = "overview";
function renderDetail(rec) {
  currentDetail = rec;
  const sc = statusClass(rec);
  const statusTxt = rec.is_failed ? "失败" : (rec.response && rec.response.status != null ? rec.response.status : "—");
  const hasBody = rec.response && rec.response.body != null;
  const head =
    `<div class="detail-head">` +
    `<div class="detail-title">${esc(rec.method)} ${esc(rec.url)}</div>` +
    (hasBody ? `<button class="btn-mini" id="downloadFileBtn" title="将响应体另存为文件">⬇ 下载文件</button>` : "") +
    `<div class="detail-meta">状态 <span class="${sc}">${esc(String(statusTxt))}</span> · 类型 ${esc(rec.resource_type)} · ` +
    `大小 ${fmtSize(rec.response && rec.response.size_bytes)} · 耗时 ${rec.duration_ms != null ? rec.duration_ms + "ms" : "—"}` +
    `<br>域 ${esc(rec.registered_domain)} · host ${esc(rec.host)}</div>` +
    `</div>`;
  const tabs =
    `<div class="detail-tabs">` +
    tabBtn("overview", "概览") + tabBtn("req-headers", "请求头") + tabBtn("req-body", "请求体") +
    tabBtn("res-headers", "响应头") + tabBtn("res-body", "响应体") + tabBtn("query", "Query") +
    tabBtn("timing", "Timing") +
    `</div>`;
  detailEl.innerHTML = head + tabs + `<div class="detail-body" id="detailBody">${renderTab(rec, currentTab)}</div>`;

  detailEl.querySelectorAll(".tab").forEach((el) => {
    el.addEventListener("click", () => {
      currentTab = el.getAttribute("data-tab");
      detailEl.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      el.classList.add("active");
      $("detailBody").innerHTML = renderTab(rec, currentTab);
    });
  });

  const dlBtn = $("downloadFileBtn");
  if (dlBtn) {
    dlBtn.addEventListener("click", () => {
      if (dlBtn.disabled) return;
      dlBtn.disabled = true;
      const oldText = dlBtn.textContent;
      dlBtn.textContent = "下载中…";

      // 直接用前端已有的完整响应体（currentDetail.response.body），无需再 fetch 后端
      const body = (currentDetail && currentDetail.response && currentDetail.response.body) || rec.response.body;
      if (body == null) {
        alert("该请求无响应体，无法下载。");
        dlBtn.disabled = false; dlBtn.textContent = oldText;
        return;
      }

      // 从 URL 推断文件名
      const url = rec.url || "";
      let seg = url.split("/").pop().split("?")[0] || "";
      const rt = (rec.resource_type || "").toUpperCase();
      const extMap = { SCRIPT:".js", STYLESHEET:".css", XHR:".json", FETCH:".json", IMAGE:".bin", FONT:".woff2", DOCUMENT:".html" };
      if (!seg || !seg.includes(".")) {
        seg = (rec.path || "download").split("/").pop() || "download";
        seg += extMap[rt] || ".txt";
      }
      const filename = seg;

      // 统一走 saveTextFile（原生保存对话框，与导出 HAR/JSON/Mock 一致）
      saveTextFile(filename, body)
        .then((msg) => { if (msg) alert("已保存：" + msg); })
        .catch((e) => alert("下载失败：" + e.message))
        .finally(() => { dlBtn.disabled = false; dlBtn.textContent = oldText; });
    });
  }
}

function tabBtn(key, label) {
  return `<div class="tab${key === currentTab ? " active" : ""}" data-tab="${key}">${label}</div>`;
}

function kvTable(obj) {
  if (!obj || Object.keys(obj).length === 0) return `<div class="note">无</div>`;
  let h = `<table class="kv">`;
  for (const [k, v] of Object.entries(obj)) {
    h += `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`;
  }
  return h + `</table>`;
}

function renderTab(rec, which) {
  if (which === "overview") {
    const r = rec.response || {};
    return (
      `<table class="kv">` +
      `<tr><td class="k">方法</td><td>${esc(rec.method)}</td></tr>` +
      `<tr><td class="k">URL</td><td>${esc(rec.url)}</td></tr>` +
      `<tr><td class="k">状态</td><td>${esc(String(rec.is_failed ? "失败" : (r.status != null ? r.status : "—")))} ${esc(r.status_text || "")}</td></tr>` +
      `<tr><td class="k">资源类型</td><td>${esc(rec.resource_type)}</td></tr>` +
      `<tr><td class="k">MIME</td><td>${esc(r.mime_type || "—")}</td></tr>` +
      `<tr><td class="k">大小</td><td>${fmtSize(r.size_bytes)}</td></tr>` +
      `<tr><td class="k">耗时</td><td>${rec.duration_ms != null ? rec.duration_ms + "ms" : "—"}</td></tr>` +
      `<tr><td class="k">主域名</td><td>${esc(rec.registered_domain)}</td></tr>` +
      `<tr><td class="k">host</td><td>${esc(rec.host)}</td></tr>` +
      `</table>`
    );
  }
  if (which === "req-headers") return kvTable(rec.request && rec.request.headers);
  if (which === "req-body") {
    const t = rec.request && rec.request.post_data;
    if (t == null) return `<div class="note">无请求体</div>`;
    return `<pre class="code">${esc(pretty(t))}</pre>`;
  }
  if (which === "res-headers") return kvTable(rec.response && rec.response.headers);
  if (which === "res-body") {
    const r = rec.response || {};
    const t = r.body;
    if (t == null) {
      if ((r.body_size || 0) > 0) return `<div class="note">二进制响应体（大小 ${fmtSize(r.body_size)}），未捕获原文。</div>`;
      return `<div class="note">无响应体</div>`;
    }
    return `<pre class="code">${esc(pretty(t))}</pre>` + (r.truncated ? `<div class="note">⚠ 内容已截断，完整内容见导出的 HAR / JSON。</div>` : "");
  }
  if (which === "query") {
    if (!rec.query) return `<div class="note">无 Query 参数</div>`;
    const params = new URLSearchParams(rec.query);
    const obj = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return kvTable(obj);
  }
  if (which === "timing") return kvTable(rec.timing);
  return "";
}

// ---------------- 工具栏 ----------------
function postJSON(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json().then((d) => ({ ok: r.ok, data: d })));
}

// 统一的「保存文件」逻辑：内容经 base64 交给 Python 端弹原生保存对话框写盘，
// 与「下载 JS」完全一致；无 pywebview API 时回退到浏览器 blob 下载。
// 所有导出（HAR / JSON / Mock / 单文件）都走它，避免各写一套。
function saveTextFile(filename, text) {
  const b64 = btoa(unescape(encodeURIComponent(text)));
  return window.pywebviewReady.then((pw) => {
    if (pw && pw.api && pw.api.save_file) {
      return pw.api.save_file(filename, b64).then((res) => {
        if (!res || !res.ok) {
          if (res && res.cancelled) return null;
          throw new Error((res && res.error) || "保存失败");
        }
        return res.path;
      });
    }
    const blob = new Blob([text], { type: "application/octet-stream" });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
    return "已下载到默认位置";
  });
}

startBtn.addEventListener("click", () => {
  const mode = modeSel.value;
  const body = {
    mode,
    local_path: mode === "local" ? localPathEl.value.trim() : "",
    browser: mode === "local" ? localBrowserEl.value : "",
    start_url: startUrlEl.value.trim() || "about:blank",
  };
  startBtn.disabled = true;
  postJSON("/api/start", body).then((res) => {
    if (res.ok && res.data.ok) {
      if (res.data.status) updateStatus(res.data.status);
    } else {
      startBtn.disabled = false;
      alert("启动失败：" + ((res.data && res.data.error) || "未知错误"));
    }
  }).catch((e) => { startBtn.disabled = false; alert("启动失败：" + e); });
});

stopBtn.addEventListener("click", () => {
  postJSON("/api/stop", {}).then((res) => {
    if (res.data && res.data.status) updateStatus(res.data.status);
  });
});

clearBtn.addEventListener("click", () => {
  if (!confirm("确认清空当前已录制的全部请求？")) return;
  postJSON("/api/clear", {});
});

const desensitizeEl = $("desensitize");
const localBrowserEl = $("localBrowser");
const localBrowserField = $("localBrowserField");
const maskCjkEl = $("maskCjk");
const maskDigitEl = $("maskDigit");
const maskAlphaEl = $("maskAlpha");
const portInputEl = $("portInput");
const portHintEl = $("portHint");
const MASK_KEY = "api_recorder_mask_cfg";

function loadMaskCfg() {
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(MASK_KEY) || "{}"); } catch (e) { cfg = {}; }
  maskCjkEl.value = cfg.cjk != null ? cfg.cjk : "测";
  maskDigitEl.value = cfg.digit != null ? cfg.digit : "1";
  maskAlphaEl.value = cfg.alpha != null ? cfg.alpha : "a";
}
function savePortCfg() {
  // 端口：写到后端 config.json（需重启生效）
  const raw = portInputEl.value.trim();
  const port = raw === "" ? null : raw;
  postJSON("/api/config", { port }).then((res) => {
    if (!res.ok || !res.data || !res.data.ok) {
      alert("端口保存失败：" + ((res.data && res.data.error) || ""));
    } else {
      alert("设置已保存。端口修改需重启本程序后生效。");
    }
  }).catch((e) => alert("端口保存失败：" + e));
  $("maskPanel").classList.add("hide");
}
// 脱敏规则：输入即存 localStorage（配置面板不放脱敏，导出弹窗里改即持久化）
function persistMaskCfg() {
  const cfg = { cjk: maskCjkEl.value, digit: maskDigitEl.value, alpha: maskAlphaEl.value };
  localStorage.setItem(MASK_KEY, JSON.stringify(cfg));
}
$("maskSettingsBtn").addEventListener("click", () => $("maskPanel").classList.toggle("hide"));
$("maskSave").addEventListener("click", savePortCfg);
[maskCjkEl, maskDigitEl, maskAlphaEl].forEach((el) => el.addEventListener("input", persistMaskCfg));
// 默认预填，保证不改配置时行为与之前一致
loadMaskCfg();
// 读取已保存端口（若有）回填到输入框，并显示当前运行端口
fetch("/api/config").then((r) => r.json()).then((d) => {
  if (d && d.saved_port) portInputEl.value = d.saved_port;
  if (d && d.running_port) portHintEl.textContent = "当前运行端口：" + d.running_port + "；修改后需重启本程序生效。留空 = 自动选择。";
}).catch(() => {});

function exportUrl(fmt) {
  let q = "format=" + fmt;
  if (desensitizeEl.checked) {
    q += "&desensitize=1";
    const cjk = maskCjkEl.value.trim();
    const digit = maskDigitEl.value.trim();
    const alpha = maskAlphaEl.value.trim();
    if (cjk) q += "&cjk=" + encodeURIComponent(cjk);
    if (digit) q += "&digit=" + encodeURIComponent(digit);
    if (alpha) q += "&alpha=" + encodeURIComponent(alpha);
  }
  // 与「下载 JS」统一：fetch 内容后用原生保存对话框写盘，不再依赖浏览器自带下载
  return fetch("/api/export?" + q)
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    })
    .then((text) => saveTextFile(fmt === "har" ? "api-recording.har" : "api-recording.json", text))
    .then((msg) => { if (msg) alert("已导出：" + msg); })
    .catch((e) => { alert("导出失败：" + e.message); throw e; });
}

// 导出 Mock 脚本：拉取生成的 Python 脚本，统一走 saveTextFile
function exportMockScript() {
  return fetch("/api/export_mock")
    .then((r) => {
      if (!r.ok) {
        return r.json().then((e) => { throw new Error(e.error || ("HTTP " + r.status)); })
          .catch(() => { throw new Error("HTTP " + r.status); });
      }
      return r.text();
    })
    .then((text) => saveTextFile("mock_server.py", text))
    .then((msg) => { if (msg) alert("已生成：" + msg + "\n\n运行：pip install flask && python mock_server.py --port 8080"); })
    .catch((e) => { alert("生成失败：" + e.message); throw e; });
}

// 弹窗「导出 / Mock」：开关弹窗 + 按所选格式导出
const exportBtn = $("exportBtn");
const exportModal = $("exportModal");
const doExportBtn = $("doExportBtn");

function closeExportModal() { exportModal.classList.add("hide"); }
exportBtn.addEventListener("click", () => exportModal.classList.remove("hide"));
$("exportModalClose").addEventListener("click", closeExportModal);
exportModal.addEventListener("click", (e) => { if (e.target === exportModal) closeExportModal(); });

doExportBtn.addEventListener("click", () => {
  const sel = document.querySelector('input[name="exportFormat"]:checked');
  const fmt = sel ? sel.value : "har";
  doExportBtn.disabled = true;
  const oldText = doExportBtn.textContent;
  doExportBtn.textContent = "导出中…";
  const task = fmt === "mock" ? exportMockScript() : exportUrl(fmt);
  task
    .catch(() => {})
    .finally(() => { doExportBtn.disabled = false; doExportBtn.textContent = oldText; });
});

const importBtn = $("importBtn");
const importFile = $("importFile");
importBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  const file = importFile.files && importFile.files[0];
  if (!file) return;
  if (!confirm("导入将覆盖当前已录制的全部请求，继续？")) {
    importFile.value = "";
    return;
  }
  const fd = new FormData();
  fd.append("file", file);
  importBtn.disabled = true;
  fetch("/api/import", { method: "POST", body: fd })
    .then((r) => r.json().then((d) => ({ ok: r.ok, data: d })))
    .then((res) => {
      if (res.ok && res.data && res.data.ok) {
        alert(`导入成功：${res.data.kind} 共 ${res.data.count} 条（左侧已刷新）`);
      } else {
        alert("导入失败：" + ((res.data && res.data.error) || "未知错误"));
      }
    })
    .catch((e) => alert("导入失败：" + e))
    .finally(() => {
      importBtn.disabled = false;
      importFile.value = "";
    });
});

// 启动 / 停止 Mock 服务（进程内直接起，无需导出脚本）
startMockBtn.addEventListener("click", () => {
  startMockBtn.disabled = true;
  postJSON("/api/mock/start", {})
    .then((res) => {
      if (res.ok && res.data.ok) {
        updateMockUI(res.data);
      } else {
        startMockBtn.disabled = false;
        alert("启动 Mock 失败：" + ((res.data && res.data.error) || "未知错误"));
      }
    })
    .catch((e) => { startMockBtn.disabled = false; alert("启动 Mock 失败：" + e); });
});

stopMockBtn.addEventListener("click", () => {
  postJSON("/api/mock/stop", {}).then((res) => {
    if (res.data) updateMockUI(res.data);
  });
});

// 页面加载时拉一次状态：进程内的 mock 服务不会因刷新页面而消失
fetch("/api/mock/status")
  .then((r) => r.json())
  .then(updateMockUI)
  .catch(() => {});

modeSel.addEventListener("change", () => {
  const isLocal = modeSel.value === "local";
  localPathEl.classList.toggle("hide", !isLocal);
  localBrowserField.classList.toggle("hide", !isLocal);
});

// 筛选
function onFilter() {
  filters.search = searchEl.value.trim();
  filters.method = methodFilterEl.value;
  filters.type = typeFilterEl.value;
  filters.onlyApi = onlyApiEl.checked;
  filters.onlyError = onlyErrorEl.checked;
  render();
}
[searchEl, methodFilterEl, typeFilterEl].forEach((el) => el.addEventListener("input", onFilter));
[onlyApiEl, onlyErrorEl].forEach((el) => el.addEventListener("change", onFilter));

// ---------------- 启动 ----------------
connect();
