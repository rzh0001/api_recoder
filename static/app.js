// -*- coding: utf-8 -*-
"use strict";

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);

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
const statusEl = $("sbApiStatus");   // 顶部/底部状态栏的 API 录制状态
const statsEl = $("sbApiStats");

const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const clearBtn = $("clearBtn");
const modeSel = $("mode");
const localPathEl = $("localPath");
const startUrlEl = $("startUrl");

const searchEl = $("search");
const searchClearEl = $("searchClear");
const searchHistoryBtnEl = $("searchHistoryBtn");
const searchHistoryEl = $("searchHistory");
const methodFilterEl = $("methodFilter");
const typeFilterEl = $("typeFilter");
const onlyApiEl = $("onlyApi");
const onlyErrorEl = $("onlyError");
const ignoreHeadersEl = $("ignoreHeaders");

// ---------------- 状态 ----------------
let allRequests = [];
let collapsed = new Set();
let ws = null;
let renderTimer = null;
let activeSeq = null;
let currentDetail = null;
let recordingActive = false;  // 是否正在录制（互斥用）
let mockRunning = false;      // Mock 是否运行中（冻结录制库用）
let sortBy = "default";       // 列表排序方式：default=按时间 / url=按 API 地址

// ---------------- 工具 ----------------
function esc(x) {
  if (x === null || x === undefined) return "";
  return String(x)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 把搜索框内容拆成多个「或」条件：用 | 或换行分隔；空词忽略。
// 仅一个词时与原行为完全一致（仍是整串子串匹配）。
function searchTokens() {
  const raw = (filters.search || "").trim();
  if (!raw) return [];
  return raw.split(/[|\n]+/).map((t) => t.trim()).filter((t) => t !== "");
}

// 把搜索词在当前文本里高亮（仅在有筛选词时生效）。
// 先对文本做 HTML 转义，再对「同样转义后的搜索词」做不区分大小写匹配，
// 这样命中位置的可见字符与用户肉眼看到的一致，且不会破坏 HTML。
let _hlRe = null, _hlQ = null;
function hlRe() {
  const q = (filters.search || "").trim();
  if (q === _hlQ) return _hlRe;
  _hlQ = q;
  const terms = searchTokens();
  if (!terms.length) { _hlRe = null; return null; }
  const parts = terms.map((t) =>
    esc(t.toLowerCase()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  try { _hlRe = new RegExp(parts.join("|"), "gi"); }
  catch (e) { _hlRe = null; }
  return _hlRe;
}
function hl(text) {
  if (text === null || text === undefined) return "";
  const s = esc(text);
  const re = hlRe();
  if (!re) return s;
  re.lastIndex = 0;
  return s.replace(re, (m) => `<mark class="hl">${m}</mark>`);
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

// 请求体/响应体的可复制代码块：右上角「复制」按钮，绕开 WebView2 下
// 选中文本后 Ctrl+C / 右键复制不稳定的问题，保证一键复制原始内容。
function codeBlock(text) {
  return (
    `<div class="code-wrap">` +
    `<button class="btn-mini code-copy" type="button" data-copy>复制</button>` +
    `<pre class="code">${hl(pretty(text))}</pre>` +
    `</div>`
  );
}

function buildHaystack(r, noReqHdr) {
  // 把一条记录里可检索文本拼成一串（小写），用于「按数据过滤」，
  // 覆盖 URL/域名/方法/Query/请求头/请求体/响应头/响应体/备注/标签/字段注释。
  // noReqHdr=true 时排除「请求头」（Authorization/Cookie/Content-Type 等常造成误命中）。
  const parts = [];
  const push = (v) => { if (v != null && v !== "") parts.push(String(v)); };
  push(r.method); push(r.url); push(r.host); push(r.registered_domain);
  push(r.resource_type); push(r.path); push(r.query);
  push(r.note);
  if (r.tags && r.tags.length) push(r.tags.join(" "));
  const req = r.request || {};
  const resp = r.response || {};
  const hdrs = (o) => { if (o) for (const k in o) { push(k); push(o[k]); } };
  if (!noReqHdr) hdrs(req.headers);
  push(req.post_data);
  hdrs(resp.headers);
  push(resp.body);
  const ann = r.annotations || {};
  for (const t in ann) { const m = ann[t] || {}; for (const p in m) push(m[p]); }
  return parts.join("  ").toLowerCase();
}
function recordHaystack(r) {
  // 缓存两种变体：完整 / 忽略请求头；随「忽略请求头」开关切换
  if (filters.ignoreReqHeaders) {
    if (r._hayNoReqHdr == null) r._hayNoReqHdr = buildHaystack(r, true);
    return r._hayNoReqHdr;
  }
  if (r._hay == null) r._hay = buildHaystack(r, false);
  return r._hay;
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
    const terms = searchTokens();
    if (terms.length) {
      const hay = recordHaystack(r);
      if (!terms.some((t) => hay.includes(t.toLowerCase()))) return false;
    }
  }
  return true;
}

const filters = { search: "", method: "all", type: "all", onlyApi: false, onlyError: false, ignoreReqHeaders: false };

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
  } else if (msg.type === "mock_log") {
    loadMockLogs();
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
  const running = info.status === "recording" || info.status === "launching";
  recordingActive = running;
  stopBtn.disabled = !running;
  statusEl.className = "sb-status " + cls;
  if (info.status === "error" && info.error) {
    statusEl.title = info.error;
  }
  applyLocks();
}

// ---------------- 互斥 / 冻结控制 ----------------
// 模型 A（快照 + 互斥）：Mock 运行时冻结录制库（禁用 开始录制/导入/清空），
// 避免启动后的快照与录制库悄悄不一致；录制中禁用 启动 Mock（两者不能共存）。
// 后端 /api/start、/api/mock/start 也有守卫，这里只做前端防手滑 + tooltip 提示。
function applyLocks() {
  const lockStore = mockRunning;
  startBtn.disabled = lockStore || recordingActive;
  importBtn.disabled = lockStore;
  clearBtn.disabled = lockStore;
  startMockBtn.disabled = recordingActive || mockRunning;
  const tip = lockStore ? "Mock 运行中，录制库已锁定；停止 Mock 后可编辑" : "";
  startBtn.title = tip;
  importBtn.title = tip;
  clearBtn.title = tip;
  startMockBtn.title = recordingActive ? "录制进行中，请先停止录制再启动 Mock" : "";
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
const mockSbStatus = $("sbMockStatus");   // 底部状态栏的 Mock 状态
const mockSbStatsEl = $("sbMockStats");   // 底部状态栏的 Mock 统计（接口数）
const mockRefreshBtn = $("mockRefreshBtn");
let mockUrl = "";

function updateMockUI(info) {
  if (!info) return;
  mockRunning = !!info.running;
  if (info.running) {
    stopMockBtn.disabled = false;
    mockRefreshBtn.disabled = false;
    mockUrl = info.url || "";
    // 底部状态栏同步（绿灯 + 端口，方便被测程序对接）
    mockSbStatus.textContent = info.port ? `Mock 运行中 :${info.port}` : "Mock 运行中";
    mockSbStatus.className = "sb-status status-recording";
    mockSbStatsEl.textContent = `接口 ${info.count}`;
    loadMockApis();   // 同步刷新 Mock 列表（在 Mock tab 内联展示）
  } else {
    stopMockBtn.disabled = true;
    mockRefreshBtn.disabled = false;
    mockUrl = "";
    mockSbStatus.textContent = "Mock 未启动";
    mockSbStatus.className = "sb-status status-idle";
    mockSbStatsEl.textContent = "";
    loadMockApis();
  }
  applyLocks();   // 同步冻结/恢复录制库按钮
}

// ---------------- Mock 接口列表（内联在 Mock tab）+ 快速测试 ----------------
const mockApiList = $("mockApiList");
const mockApisUrl = $("mockApisUrl");
const mockApisCount = $("mockApisCount");
const mockApisSummary = $("mockApisSummary");

function loadMockApis() {
  mockApiList.innerHTML = `<div class="mock-api-empty">加载中…</div>`;
  mockApisSummary.textContent = "";
  return postJSON("/api/mock/apis", {}).then((res) => {
    if (!res || !res.data) return;
    const d = res.data;
    mockApisUrl.textContent = d.url || "—";
    mockApisUrl.href = d.url || "#";
    const apis = d.apis || [];
    window.__mockApis = apis;
    mockApisCount.textContent = `(${apis.length})`;
    if (!apis.length) {
      mockApiList.innerHTML = `<div class="mock-api-empty">尚无接口（仅 XHR/FETCH 类型会被模拟）。</div>`;
      return;
    }
    mockApiList.innerHTML = apis.map((a, i) =>
      `<div class="mock-api-row${a.mock_pin ? " pinned" : ""}" data-i="${i}">
        <span class="method-badge m-${String(a.method || "GET").toUpperCase()}">${esc(a.method || "GET")}</span>
        <span class="mock-api-path" title="${esc(a.path)}${a.query ? "?" + esc(a.query) : ""}">${esc(a.path)}${a.query ? "?" + esc(a.query) : ""}</span>
        ${rowMarkHtml(a)}
        <span class="resp-badge">${esc(String(a.status))}</span>
        ${a.mock_pin ? '<span class="pin-badge">已固定</span>' : ""}
        <button class="btn btn-sm mock-pin-one" data-seq="${a.seq}">${a.mock_pin ? "取消固定" : "固定"}</button>
        <button class="btn btn-sm mock-test-one">测试</button>
        <pre class="mock-api-result" style="display:none"></pre>
      </div>`
    ).join("");
    // 绑定每行测试按钮
    mockApiList.querySelectorAll(".mock-test-one").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".mock-api-row");
        const i = parseInt(row.getAttribute("data-i"), 10);
        testMockApi(apis[i], row);
      });
    });
    // 绑定每行固定/取消固定按钮
    mockApiList.querySelectorAll(".mock-pin-one").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".mock-api-row");
        const i = parseInt(row.getAttribute("data-i"), 10);
        pinMockApi(apis[i], btn);
      });
    });
  });
}

async function pinMockApi(api, btn) {
  if (!api) return;
  btn.disabled = true;
  const target = !api.mock_pin;  // 切换固定态
  const res = await postJSON("/api/mock/pin", { seq: api.seq, pinned: target });
  btn.disabled = false;
  if (res && res.data && res.data.ok) {
    loadMockApis();  // 重新拉取，含最新固定状态（运行中已实时生效）
  } else {
    alert("固定失败：" + ((res && res.data && res.data.error) || "未知错误"));
  }
}

async function testMockApi(api, row) {
  const pre = row.querySelector(".mock-api-result");
  const btn = row.querySelector(".mock-test-one");
  btn.disabled = true;
  pre.style.display = "block";
  pre.textContent = "测试中…";
  const res = await postJSON("/api/mock/test", {
    method: api.method, path: api.path, query: api.query,
  });
  btn.disabled = false;
  if (res && res.data) {
    const d = res.data;
    let pretty = d.body || "";
    if (pretty && (pretty.trim().startsWith("{") || pretty.trim().startsWith("["))) {
      try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch (e) {}
    }
    const cls = d.ok ? (d.status < 400 ? "ok" : "err") : "err";
    pre.className = "mock-api-result " + cls;
    pre.textContent = `状态 ${d.status} · ${d.ms}ms\n\n${pretty}`;
  } else {
    pre.className = "mock-api-result err";
    pre.textContent = "测试失败：无响应";
  }
}

async function testAllMockApis() {
  const rows = Array.from(mockApiList.querySelectorAll(".mock-api-row"));
  if (!rows.length) return;
  mockApisSummary.textContent = "测试中…";
  let pass = 0, fail = 0;
  const results = await Promise.all(rows.map(async (row) => {
    const i = parseInt(row.getAttribute("data-i"), 10);
    // apis 顺序与渲染一致，用 index 取对应接口
    const api = window.__mockApis ? window.__mockApis[i] : null;
    if (!api) return null;
    const res = await postJSON("/api/mock/test", {
      method: api.method, path: api.path, query: api.query,
    });
    const pre = row.querySelector(".mock-api-result");
    const btn = row.querySelector(".mock-test-one");
    if (res && res.data) {
      const d = res.data;
      if (d.ok && d.status < 400) pass++; else fail++;
      let pretty = d.body || "";
      if (pretty && (pretty.trim().startsWith("{") || pretty.trim().startsWith("["))) {
        try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch (e) {}
      }
      const cls = d.ok ? (d.status < 400 ? "ok" : "err") : "err";
      pre.className = "mock-api-result " + cls;
      pre.style.display = "block";
      pre.textContent = `状态 ${d.status} · ${d.ms}ms\n\n${pretty}`;
      return d.ok && d.status < 400;
    }
    pre.className = "mock-api-result err";
    pre.style.display = "block";
    pre.textContent = "测试失败：无响应";
    fail++;
    return false;
  }));
  mockApisSummary.textContent = `全部测试完成：通过 ${pass} / 失败 ${fail} / 共 ${rows.length}`;
}

mockRefreshBtn.addEventListener("click", loadMockApis);
$("mockTestAllBtn").addEventListener("click", testAllMockApis);

// ---------------- Mock 处理记录（收到的请求 + 返回数据）----------------
let mockLogs = [];
const mockLogList = $("mockLogList");
const mockLogsCount = $("mockLogsCount");
const mockLogsRefreshBtn = $("mockLogsRefreshBtn");
const mockLogModal = $("mockLogModal");
const mockLogModalBody = $("mockLogModalBody");

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function loadMockLogs() {
  return postJSON("/api/mock/logs", {})
    .then((res) => {
      if (res.data) { mockLogs = res.data.logs || []; renderMockLogs(); }
    })
    .catch(() => {});
}

function renderMockLogs() {
  if (!mockLogList) return;
  mockLogsCount.textContent = mockLogs.length ? `(${mockLogs.length})` : "";
  if (!mockLogs.length) {
    mockLogList.innerHTML = `<div class="mock-api-empty">暂无处理记录（Mock 收到请求后这里会实时显示，点击可查看详情）。</div>`;
    return;
  }
  mockLogList.innerHTML = mockLogs
    .map((l, i) => {
      const sc = l.status >= 400 ? "s-4" : (l.status >= 300 ? "s-3" : (l.matched ? "s-2" : "s-fail"));
      const miss = l.matched ? "" : `<span class="badge miss">未命中</span>`;
      return (
        `<div class="mock-log-row" data-i="${i}">` +
        `<span class="log-ts">${fmtTime(l.ts)}</span>` +
        `<span class="m m-${methodClass(l)}">${esc(l.method)}</span>` +
        `<span class="s ${sc}">${esc(String(l.status))}</span>` +
        `<span class="path-text" title="${esc(l.url || "")}">${esc(l.path || "/")}${l.query ? "?" + esc(l.query) : ""}</span>` +
        miss +
        `</div>`
      );
    })
    .join("");
  mockLogList.querySelectorAll(".mock-log-row").forEach((row) => {
    row.addEventListener("click", () => showMockLogDetail(mockLogs[parseInt(row.getAttribute("data-i"), 10)]));
  });
}

function showMockLogDetail(log) {
  if (!log || !mockLogModal) return;
  const miss = log.matched ? "" : `<span style="color:#A32D2D">未命中（返回 404）</span>`;
  const reqHdr = log.req_headers && Object.keys(log.req_headers).length
    ? kvTable(log.req_headers)
    : `<div class="note">无请求头</div>`;
  const resHdr = log.res_headers && Object.keys(log.res_headers).length
    ? kvTable(log.res_headers)
    : `<div class="note">无响应头</div>`;
  const reqBody = log.req_body ? codeBlock(pretty(log.req_body)) : `<div class="note">无请求体</div>`;
  const resBody = log.res_body ? codeBlock(pretty(log.res_body)) : `<div class="note">空响应体</div>`;
  mockLogModalBody.innerHTML =
    `<div class="mock-log-sec"><div class="mock-log-sec-title">请求</div>` +
    `<div class="mock-log-url">${esc(log.method)} ${esc(log.url || "")}</div>` +
    `<div class="mock-log-sub">请求头</div>${reqHdr}` +
    `<div class="mock-log-sub">请求体</div>${reqBody}</div>` +
    `<div class="mock-log-sec"><div class="mock-log-sec-title">响应 ${esc(String(log.status))} ${miss}</div>` +
    `<div class="mock-log-sub">响应头</div>${resHdr}` +
    `<div class="mock-log-sub">响应体</div>${resBody}</div>`;
  mockLogModal.classList.remove("hide");
}

if (mockLogsRefreshBtn) mockLogsRefreshBtn.addEventListener("click", loadMockLogs);
if (mockLogModal) {
  $("mockLogModalClose").addEventListener("click", () => mockLogModal.classList.add("hide"));
  mockLogModal.addEventListener("click", (e) => { if (e.target === mockLogModal) mockLogModal.classList.add("hide"); });
}
if (mockLogList) loadMockLogs();  // 页面加载时先拉一次（进程内 Mock 不随刷新消失）

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
    `<span class="path-text" title="${esc(r.url)}">${hl(path)}</span>` +
    rowMarkHtml(r) +
    `<span class="req-del" data-del-seq="${r.seq}" title="删除该条录制记录">×</span>` +
    `</div>`
  );
}

function rowMarkHtml(r) {
  const note = r.note || "";
  const tags = r.tags || [];
  if (!note && !tags.length) return "";
  const noteEl = note
    ? `<span class="row-mark-note" title="${esc(note)}">📌 ${hl(truncate(note, 30))}</span>`
    : "";
  const tagsEl = tags.map((t) => `<span class="row-tag">${hl(t)}</span>`).join("");
  return `<span class="row-mark">${noteEl}${tagsEl}</span>`;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function render() {
  const groups = new Map();
  let visible = 0;
  // 按排序方式先整体排序（保持筛选行为不变）
  const src = sortBy === "url"
    ? [...allRequests].sort((a, b) => (a.url || "").localeCompare(b.url || ""))
    : allRequests;
  for (const r of src) {
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
      `<span class="domain-name">${hl(rd)}</span>` +
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
        `<span class="host-name">${hl(host)}</span>` +
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
  const del = e.target.closest("[data-del-seq]");
  if (del) {
    e.stopPropagation();
    deleteRequest(parseInt(del.getAttribute("data-del-seq"), 10));
    return;
  }
  const t = e.target.closest("[data-toggle]");
  if (t) { toggle(t.getAttribute("data-toggle")); return; }
  const req = e.target.closest(".req-row");
  if (req) {
    openDetail(parseInt(req.getAttribute("data-seq"), 10));
    document.querySelectorAll(".req-row.active").forEach((el) => el.classList.remove("active"));
    req.classList.add("active");
  }
});

// ---------------- 删除单条录制 ----------------
function deleteRequest(seq) {
  if (mockRunning) {
    alert("Mock 运行中，录制库已锁定；请先停止 Mock 再删除。");
    return;
  }
  const rec = allRequests.find((r) => r.seq === seq);
  const label = rec
    ? `${rec.method} ${rec.path || "/"}${rec.query ? "?" + rec.query : ""}`
    : "该请求";
  if (!confirm(`删除这条录制记录？\n\n${label}`)) return;
  postJSON("/api/request/delete", { seq })
    .then((res) => {
      if (res.ok && res.data && res.data.ok) {
        if (activeSeq === seq) {
          activeSeq = 0;
          detailEl.innerHTML = `<div class="empty">选择左侧请求查看详情</div>`;
        }
        // 树由后端广播 snapshot 自动刷新
      } else {
        alert("删除失败：" + ((res.data && res.data.error) || "未知错误"));
      }
    })
    .catch((e) => alert("删除失败：" + e));
}

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
    `<div class="detail-title">${esc(rec.method)} ${hl(rec.url)} <button class="btn-mini" data-copy-url title="复制完整请求地址">📋 复制</button>` +
    `<button class="btn-mini" id="editReqBtn" title="编辑请求（URL / 请求头 / 请求体），用于造数据">✏ 编辑请求</button>` +
    (hasBody ? `<button class="btn-mini" id="downloadFileBtn" title="将响应体另存为文件">⬇ 下载文件</button>` : "") +
    `<button class="btn-mini" id="delDetailBtn" title="删除该条录制记录">🗑 删除</button>` +
    `</div>` +
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
  const tagsPanel = `<div class="detail-tags">${tagsEditorHtml(rec)}</div>`;
  detailEl.innerHTML = head + tagsPanel + tabs + `<div class="detail-body" id="detailBody">${renderTab(rec, currentTab)}</div>`;

  detailEl.querySelectorAll(".tab").forEach((el) => {
    el.addEventListener("click", () => {
      currentTab = el.getAttribute("data-tab");
      detailEl.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      el.classList.add("active");
      $("detailBody").innerHTML = renderTab(rec, currentTab);
    });
  });

  const delDetailBtn = $("delDetailBtn");
  if (delDetailBtn) {
    delDetailBtn.addEventListener("click", () => deleteRequest(rec.seq));
  }

  const editReqBtn = $("editReqBtn");
  if (editReqBtn) {
    editReqBtn.addEventListener("click", () => openEditReq(rec));
  }

  const markSaveBtn = $("markSaveBtn");
  if (markSaveBtn) {
    markSaveBtn.addEventListener("click", () => {
      const tagsRaw = ($("markTagsInput") && $("markTagsInput").value) || "";
      const tags = tagsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      markSaveBtn.disabled = true;
      postJSON("/api/request/mark", { seq: rec.seq, tags })
        .then((res) => {
          if (res.ok && res.data && res.data.ok) {
            if (currentDetail) { currentDetail.tags = tags; }
            // 树由后端广播 snapshot 刷新（标记图标）；详情本地已更新
            markSaveBtn.textContent = "已保存 ✓";
            setTimeout(() => { markSaveBtn.textContent = "保存"; }, 1200);
          } else {
            alert("保存标签失败：" + ((res.data && res.data.error) || "未知错误"));
          }
        })
        .catch((e) => alert("保存标签失败：" + e))
        .finally(() => { markSaveBtn.disabled = false; });
    });
  }

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
    h += `<tr><td class="k">${hl(k)}</td><td>${hl(v)}</td></tr>`;
  }
  return h + `</table>`;
}

function renderTab(rec, which) {
  if (which === "overview") {
    const r = rec.response || {};
    return (
      `<table class="kv">` +
      `<tr><td class="k">方法</td><td>${esc(rec.method)}</td></tr>` +
      `<tr><td class="k">URL</td><td class="url-cell">${hl(rec.url)} <button class="btn-mini" data-copy-url title="复制请求地址">复制</button></td></tr>` +
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
    return jsonOrCode(t, rec, "req");
  }
  if (which === "res-headers") return kvTable(rec.response && rec.response.headers);
  if (which === "res-body") {
    const r = rec.response || {};
    const t = r.body;
    if (t == null) {
      if ((r.body_size || 0) > 0) return `<div class="note">二进制响应体（大小 ${fmtSize(r.body_size)}），未捕获原文。</div>`;
      return `<div class="note">无响应体</div>`;
    }
    return jsonOrCode(t, rec, "res") + (r.truncated ? `<div class="note">⚠ 内容已截断，完整内容见导出的 HAR / JSON。</div>` : "");
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

// ---------------- 标记（记录级备注 + 标签）----------------
function tagsEditorHtml(rec) {
  const tags = (rec.tags || []).join(", ");
  return (
    `<div class="tags-bar">` +
    `<span class="tags-label">标签</span>` +
    `<input id="markTagsInput" class="input tags-input" placeholder="登录, 核心" value="${esc(tags)}" />` +
    `<button class="btn-mini" id="markSaveBtn">保存</button>` +
    `</div>`
  );
}

// ---------------- 字段级注释：JSON 树渲染 ----------------
function jsonOrCode(text, rec, target) {
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) { /* 非 JSON，按原样文本渲染 */ }
  if (obj === null || typeof obj !== "object") return codeBlock(text);
  const ann = (rec.annotations && rec.annotations[target]) || {};
  const raw = JSON.stringify(obj, null, 2);
  return (
    `<div class="code-wrap">` +
    `<button class="btn-mini code-copy" data-copy>复制</button>` +
    `<div class="code jtree" data-raw="${esc(raw)}">` +
    jsonTreeHtml(obj, "", ann, target) +
    `</div></div>`
  );
}

function jsonTreeHtml(v, path, ann, target) {
  const note = ann[path];
  const cls = note ? " j-annotated" : "";
  const noteTxt = note ? `<span class="j-note-txt"> // ${esc(note)}</span>` : "";
  const btn = `<span class="j-note-btn" data-ann-path="${esc(path)}" data-ann-target="${target}" title="添加/编辑注释">✎</span>`;

  // 标量 / null：用 span 行内，避免被外层 key 行 div 强制换行
  if (v === null) {
    return `<span class="jline jval-null${cls}"><span class="j-null">null</span>${noteTxt}${btn}</span>`;
  }
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") {
    return `<span class="jline jval-${t}${cls}"><span class="j-${t}">${hl(String(v))}</span>${noteTxt}${btn}</span>`;
  }

  // 数组 / 对象：容器本身用 div 整行
  if (Array.isArray(v)) {
    if (v.length === 0) {
      return `<div class="jline${cls}"><span class="j-punc">[]</span>${noteTxt}${btn}</div>`;
    }
    let h = `<div class="jline${cls}"><span class="j-punc">[</span>${noteTxt}${btn}</div><div class="jind">`;
    v.forEach((item, i) => { h += jsonTreeHtml(item, path ? path + "." + i : String(i), ann, target); });
    h += `</div><div class="jline"><span class="j-punc">]</span></div>`;
    return h;
  }
  // object
  const keys = Object.keys(v);
  if (keys.length === 0) {
    return `<div class="jline${cls}"><span class="j-punc">{}</span>${noteTxt}${btn}</div>`;
  }
  let h = `<div class="jline${cls}"><span class="j-punc">{</span>${noteTxt}${btn}</div><div class="jind">`;
  keys.forEach((k) => {
    const childPath = path ? path + "." + k : k;
    h += `<div class="jline">` +
      `<span class="j-key">${hl(JSON.stringify(k))}</span><span class="j-punc">: </span>` +
      jsonTreeHtml(v[k], childPath, ann, target) +
      `</div>`;
  });
  h += `</div><div class="jline"><span class="j-punc">}</span></div>`;
  return h;
}

function annotateField(rec, path, target) {
  if (mockRunning) { alert("Mock 运行中，录制库已锁定；请先停止 Mock 再编辑注释。"); return; }
  const ann = (rec.annotations && rec.annotations[target]) || {};
  const old = ann[path] || "";
  const note = prompt(old ? "编辑注释（清空后确定 = 删除）：" : "添加注释：", old);
  if (note === null) return;
  postJSON("/api/request/annotate", { seq: rec.seq, target, path, note })
    .then((res) => {
      if (res.ok && res.data && res.data.ok) {
        openDetail(rec.seq);  // 重新拉完整记录，刷新注释展示
      } else {
        alert("保存注释失败：" + ((res.data && res.data.error) || "未知错误"));
      }
    })
    .catch((e) => alert("保存注释失败：" + e));
}

// ---------------- 编辑请求（造数据：改 URL / 请求头 / 请求体）----------------
function openEditReq(rec) {
  if (mockRunning) { alert("Mock 运行中，录制库已锁定；请先停止 Mock 再编辑。"); return; }
  const modal = $("editReqModal");
  if (!modal) return;
  $("editReqUrl").value = rec.url || "";
  const hdr = (rec.request && rec.request.headers) || {};
  $("editReqHeaders").value = Object.keys(hdr).length ? JSON.stringify(hdr, null, 2) : "{}";
  $("editReqBody").value = (rec.request && rec.request.post_data) != null ? rec.request.post_data : "";
  $("editReqErr").textContent = "";
  modal.classList.remove("hide");
  setTimeout(() => $("editReqUrl") && $("editReqUrl").focus(), 50);
}

function wireEditReqModal() {
  const modal = $("editReqModal");
  if (!modal) return;
  $("editReqModalClose").addEventListener("click", () => modal.classList.add("hide"));
  $("editReqCancel").addEventListener("click", () => modal.classList.add("hide"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hide"); });
  $("editReqSave").addEventListener("click", () => {
    if (!currentDetail) return;
    const url = $("editReqUrl").value.trim();
    const headers = $("editReqHeaders").value;
    const body = $("editReqBody").value;
    const errEl = $("editReqErr");
    errEl.textContent = "";
    const saveBtn = $("editReqSave");
    saveBtn.disabled = true;
    postJSON("/api/request/edit", { seq: currentDetail.seq, url, req_headers: headers, req_body: body })
      .then((res) => {
        if (res.ok && res.data && res.data.ok) {
          modal.classList.add("hide");
          openDetail(currentDetail.seq);  // 重新拉取，刷新标题/概览/树
        } else {
          errEl.textContent = "保存失败：" + ((res.data && res.data.error) || "未知错误");
        }
      })
      .catch((e) => { errEl.textContent = "保存失败：" + e; })
      .finally(() => { saveBtn.disabled = false; });
  });
}

// ---------------- 详情内「复制」按钮（请求体 / 响应体）----------------
// 用可靠的剪贴板路径，绕开 WebView2 下「选中后 Ctrl+C / 右键复制」不稳定的问题。
detailEl.addEventListener("click", (e) => {
  const nb = e.target.closest("[data-ann-path]");
  if (nb && currentDetail) {
    e.stopPropagation();
    annotateField(currentDetail, nb.getAttribute("data-ann-path"), nb.getAttribute("data-ann-target"));
    return;
  }
  const copyUrlBtn = e.target.closest("[data-copy-url]");
  if (copyUrlBtn && currentDetail) {
    copyText(currentDetail.url || "", copyUrlBtn);
    return;
  }
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const wrap = btn.closest(".code-wrap");
  const pre = wrap && wrap.querySelector(".code");
  if (!pre) return;
  const raw = pre.getAttribute("data-raw");
  copyText(raw != null ? raw : pre.textContent, btn);
});

function copyText(text, btn) {
  const ok = () => {
    const old = btn.textContent;
    btn.textContent = "已复制 ✓";
    btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(ok).catch(() => fallbackCopy(text, ok));
  } else {
    fallbackCopy(text, ok);
  }
}

function fallbackCopy(text, ok) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(ta);
    if (copied) { ok(); return; }
  } catch (e) {}
  alert("复制失败，请手动选中文本后按 Ctrl+C");
}

// ---------------- 工具栏 ----------------
function postJSON(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json().then((d) => ({ ok: r.ok, data: d })));
}

// 统一的「保存文件」逻辑：浏览器原生下载（WebView2/Chromium 与 IE11 均可靠），
// 不再依赖 pywebview 原生保存对话框（在 js_api 工作线程中静默失败，且 WebView2 后端未实现）。
// 所有导出（HAR / JSON / Mock）与「保存」都走它，避免各写一套。
function saveTextFile(filename, text) {
  const blob = new Blob([text], { type: "application/octet-stream" });
  if (window.navigator.msSaveOrOpenBlob) {
    window.navigator.msSaveOrOpenBlob(blob, filename);
    return Promise.resolve("已下载到默认位置");
  }
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
  return Promise.resolve("已下载到默认位置");
}

// ---------------- 打开 / 保存 ----------------
// 受浏览器安全限制，HTML <input type=file> 拿不到完整本地路径，故不再做「打开即关联源文件、
// 保存覆盖原文件」。导入/打开统一走浏览器原生文件选择，保存/导出走浏览器原生下载。
const openBtn = $("openBtn");
const saveBtn = $("saveBtn");

if (openBtn) {
  // 「打开」与「导入」走同一套浏览器原生文件选择（可靠、跨后端一致）；
  // 受浏览器安全限制，HTML <input type=file> 拿不到完整本地路径，故不再关联源文件做「覆盖保存」。
  openBtn.addEventListener("click", () => {
    try {
      importFile.click();
    } catch (e) {
      alert("无法打开文件选择框：" + e.message);
    }
  });
}

if (saveBtn) {
  saveBtn.addEventListener("click", () => {
    saveBtn.disabled = true;
    const oldText = saveBtn.textContent;
    saveBtn.textContent = "保存中…";
    fetch("/api/export?format=har")
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then((text) => saveTextFile("api-recording.har", text))
      .then(() => alert("已保存（下载到浏览器默认下载目录，文件名 api-recording.har）"))
      .catch((e) => alert("保存失败：" + e.message))
      .finally(() => { saveBtn.disabled = false; saveBtn.textContent = oldText; });
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
const mockPortInputEl = $("mockPortInput");
const mockPortInput2El = $("mockPortInput2");
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
  // 端口 / Mock 端口：写到后端 config.json（服务端口需重启生效；Mock 端口下次启动生效）
  const raw = portInputEl.value.trim();
  const port = raw === "" ? null : raw;
  const mraw = mockPortInputEl.value.trim();
  const mock_port = mraw === "" ? null : mraw;
  postJSON("/api/config", { port, mock_port }).then((res) => {
    if (!res.ok || !res.data || !res.data.ok) {
      alert("配置保存失败：" + ((res.data && res.data.error) || ""));
    } else {
      // 同步回填 Mock 页输入框，避免两处不一致
      if (mock_port) mockPortInput2El.value = mock_port;
      alert("设置已保存。服务端口修改需重启本程序后生效；Mock 端口下次启动生效。");
    }
  }).catch((e) => alert("配置保存失败：" + e));
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
  if (d && d.mock_port) {
    mockPortInputEl.value = d.mock_port;
    mockPortInput2El.value = d.mock_port;
  }
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

wireEditReqModal();

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
// 导入统一走浏览器原生 <input type=file>（WebView2/Chromium 与 IE11 均可靠），
// 不再依赖 pywebview 的 create_file_dialog——它在 js_api 工作线程中调用会静默失败，
// 且在 WebView2/edgechromium 后端根本未实现，表现即「点击导入没反应」。
importBtn.addEventListener("click", () => {
  try {
    importFile.click();
  } catch (e) {
    alert("无法打开文件选择框：" + e.message);
  }
});

importFile.addEventListener("change", () => {
  const files = importFile.files;
  if (!files || !files.length) return;
  const names = Array.from(files).map((f) => f.name);
  const tip =
    files.length === 1
      ? "导入将覆盖当前已录制的全部请求，继续？"
      : `导入将覆盖当前已录制的全部请求，并合并导入 ${files.length} 个文件：\n${names.join("\n")}\n\n继续？`;
  if (!confirm(tip)) {
    importFile.value = "";
    return;
  }
  const fd = new FormData();
  Array.from(files).forEach((f) => fd.append("files", f));
  importBtn.disabled = true;
  fetch("/api/import", { method: "POST", body: fd })
    .then((r) => r.json().then((d) => ({ ok: r.ok, data: d })))
    .then((res) => {
      if (res.ok && res.data && res.data.ok) {
        alert(
          `导入成功：${res.data.kind} 共 ${res.data.count} 条` +
            `（${res.data.files || 1} 个文件，左侧已刷新）`
        );
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
  // 取 Mock 页端口输入框的值（空 = 用配置里的 mock_port，再不行随机）
  const mraw = (mockPortInput2El.value || "").trim();
  const mport = mraw === "" ? null : mraw;
  postJSON("/api/mock/start", { port: mport })
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

// 同样拉一次录制状态：刷新页面时若正在录制，按钮状态/互斥锁能立即正确反映
fetch("/api/status")
  .then((r) => r.json())
  .then(updateStatus)
  .catch(() => {});

// 初始统计：页面加载即显示「显示 0/0 · 域 0 · — · 错误 0」，避免状态栏统计区空白
updateStats(0);

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
  filters.ignoreReqHeaders = ignoreHeadersEl.checked;
  render();
}
[searchEl, methodFilterEl, typeFilterEl].forEach((el) => el.addEventListener("input", onFilter));
[onlyApiEl, onlyErrorEl, ignoreHeadersEl].forEach((el) => el.addEventListener("change", onFilter));

// 搜索框：清空按钮 + 搜索历史
const HISTORY_KEY = "api_recoder_search_history";
const HISTORY_MAX = 12;
function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveHistory(arr) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, HISTORY_MAX))); } catch (e) {}
}
function recordHistory(term) {
  term = (term || "").trim();
  if (!term) return;
  const arr = loadHistory().filter((t) => t !== term);
  arr.unshift(term);
  saveHistory(arr);
}
function renderHistory() {
  const arr = loadHistory();
  if (!arr.length) {
    searchHistoryEl.innerHTML = `<div class="hist-empty">暂无搜索历史</div>`;
    return;
  }
  let html = "";
  for (const t of arr) {
    html += `<div class="hist-item" data-q="${esc(t)}"><span class="hist-text">${esc(t)}</span><span class="hist-del" data-del="${esc(t)}" title="删除">×</span></div>`;
  }
  html += `<div class="hist-clear" id="histClear">清空历史</div>`;
  searchHistoryEl.innerHTML = html;
}
function openHistory() {
  if (searchHistoryEl.classList.contains("hide")) {
    renderHistory();
    searchHistoryEl.classList.remove("hide");
  } else {
    searchHistoryEl.classList.add("hide");
  }
}
function closeHistory() { searchHistoryEl.classList.add("hide"); }
function toggleClear() {
  if (searchEl.value) searchClearEl.classList.remove("hide");
  else searchClearEl.classList.add("hide");
}

searchClearEl.addEventListener("click", () => {
  searchEl.value = "";
  toggleClear();
  onFilter();
  searchEl.focus();
});
searchHistoryBtnEl.addEventListener("click", (e) => { e.stopPropagation(); openHistory(); });
searchEl.addEventListener("focus", () => { if (loadHistory().length) searchHistoryBtnEl.classList.add("has-history"); });
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { recordHistory(searchEl.value); closeHistory(); }
});
searchHistoryEl.addEventListener("click", (e) => {
  const del = e.target.closest(".hist-del");
  if (del) {
    e.stopPropagation();
    const q = del.getAttribute("data-del");
    saveHistory(loadHistory().filter((t) => t !== q));
    renderHistory();
    if (!loadHistory().length) searchHistoryBtnEl.classList.remove("has-history");
    return;
  }
  if (e.target.closest("#histClear")) {
    e.stopPropagation();
    saveHistory([]);
    renderHistory();
    searchHistoryBtnEl.classList.remove("has-history");
    return;
  }
  const item = e.target.closest(".hist-item");
  if (item) {
    const q = item.getAttribute("data-q");
    searchEl.value = q;
    toggleClear();
    onFilter();
    closeHistory();
    searchEl.focus();
  }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) closeHistory();
});
toggleClear();

const sortByEl = $("sortBy");
if (sortByEl) {
  sortBy = sortByEl.value || "default";
  sortByEl.addEventListener("change", () => {
    sortBy = sortByEl.value || "default";
    render();
  });
}

// ---------------- Tab 切换（API 录制 / Mock 服务，互不干扰）----------------
const panelApi = $("panelApi");
const panelMock = $("panelMock");
function switchTab(name) {
  const isApi = name === "api";
  panelApi.classList.toggle("hide", !isApi);
  panelMock.classList.toggle("hide", isApi);
  document.querySelectorAll(".tab-switch").forEach((b) =>
    b.classList.toggle("active", b.getAttribute("data-tab") === name)
  );
  // Mock tab 打开时刷新接口列表（内联展示，无需弹窗）
  if (!isApi) loadMockApis();
}
document.querySelectorAll(".tab-switch").forEach((b) => {
  b.addEventListener("click", () => switchTab(b.getAttribute("data-tab")));
});

// ---------------- 启动 ----------------
connect();
