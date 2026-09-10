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
window.allRequests = allRequests;
let collapsed = new Set();
let ws = null;
let renderTimer = null;
let activeSeq = null;
let currentDetail = null;
let recordingActive = false;  // 是否正在录制
let mockRunning = false;      // Mock 是否运行中
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
  if (typeof text !== "string") {
    try { return JSON.stringify(text, null, 2); } catch (e) { return String(text); }
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) {
    return text;
  }
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
    window.allRequests = allRequests;
    if (msg.status) updateStatus(msg.status);
    scheduleRender();
  } else if (msg.type === "request") {
    if (msg.data) allRequests.push(msg.data);
    scheduleRender();
  } else if (msg.type === "status") {
    if (msg.data) updateStatus(msg.data);
  } else if (msg.type === "cleared") {
    allRequests = [];
    window.allRequests = allRequests;
    scheduleRender();
  } else if (msg.type === "mock") {
    if (msg.status) updateMockUI(msg.status);
  } else if (msg.type === "mock_log") {
    loadMockLogs();
    scheduleHitsRefresh();
  }
}

// Mock 命中计数：mock_log 推送后节流重拉 apis（服务端累计），只更新徽标数字不重建列表
let _hitsTimer = null;
function scheduleHitsRefresh() {
  if (_hitsTimer) return;
  _hitsTimer = setTimeout(() => {
    _hitsTimer = null;
    postJSON("/api/mock/apis", {}).then((res) => {
      if (!res || !res.data) return;
      const apis = res.data.apis || [];
      apis.forEach((a) => {
        const card = mockApiList.querySelector(`.mock-api-card[data-seq="${a.seq}"]`);
        if (!card) return;
        const b = card.querySelector(".mock-hit-badge");
        if (b) b.textContent = "命中 " + (Number(a.hits) || 0);
      });
    }).catch(() => {});
  }, 300);
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

// ---------------- 运行状态显示 ----------------
// Mock 实时读库：录制 / 编辑 / 启动 Mock 互不排斥，这里只刷新运行状态显示
function applyLocks() {
  stopBtn.disabled = !recordingActive;
  stopMockBtn.disabled = !mockRunning;
  const dot = $("statusDot"); const txt = $("statusText");
  if (dot) dot.classList.toggle("live", recordingActive || mockRunning);
  if (txt) txt.textContent = recordingActive ? "录制中" : (mockRunning ? "Mock 运行中" : "空闲");
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
const mockStrictToggleEl = $("mockStrictToggle"); // Mock 匹配模式开关（严格/模糊）
let mockStrictMode = true;                     // 默认严格匹配；关掉开关 = 模糊回退

function updateMockUI(info) {
  if (!info) return;
  mockRunning = !!info.running;
  startMockBtn.disabled = mockRunning;   // 运行中禁用「启动」，停止后恢复可点
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
  applyLocks();   // 同步刷新状态显示
}

// 同步匹配模式开关状态到后端（true=严格，false=模糊）
function syncMockStrictMode() {
  postJSON("/api/config", { match_mode: mockStrictMode })
    .then((res) => {
      if (res.ok) {
        mockStrictMode = res.data ? res.data.match_mode !== false : true;
        updateStrictModeUI();
      }
    })
    .catch(() => {});
}

// 根据后端配置更新 UI 状态
function updateStrictModeUI() {
  if (mockStrictToggleEl && mockStrictToggleEl.checked !== mockStrictMode) {
    mockStrictToggleEl.checked = mockStrictMode;
  }
}

// ---------------- Mock 接口列表（内联在 Mock tab）+ 快速测试 ----------------
const mockApiList = $("mockApiList");
const mockApisUrl = $("mockApisUrl");
const mockApisCount = $("mockApisCount");
const mockSearch = $("mockSearch");
const mockSort = $("mockSort");

function loadMockApis() {
  mockApiList.innerHTML = `<div class="mock-api-empty">加载中…</div>`;
  return postJSON("/api/mock/apis", {}).then((res) => {
    if (!res || !res.data) return;
    const d = res.data;
    mockApisUrl.textContent = d.url || "—";
    mockApisUrl.href = d.url || "#";
    const apis = d.apis || [];
    window.__mockApis = apis;
    window.__mockApisBySeq = {};
    apis.forEach((a) => { window.__mockApisBySeq[a.seq] = a; });
    applyMockFilterSort();
  });
}

// 过滤（按方法/路径/备注/标签多词匹配）+ 排序，再渲染
function applyMockFilterSort() {
  const apis = window.__mockApis || [];
  mockApisCount.textContent = `(${apis.length})`;
  const q = ((mockSearch && mockSearch.value) || "").trim().toLowerCase();
  const tokens = q ? q.split(/[\s|]+/).map((t) => t.trim()).filter(Boolean) : [];
  let list = apis;
  if (tokens.length) {
    list = apis.filter((a) => {
      const hay = [a.method, a.path, a.query, a.note, (a.tags || []).join(" "), a.status, a.body_preview, a.req_body_preview].join(" ").toLowerCase();
      return tokens.every((t) => hay.indexOf(t) !== -1);
    });
  }
  const sort = (mockSort && mockSort.value) || "default";
  list = list.slice();
  if (sort === "method") list.sort((a, b) => String(a.method).localeCompare(String(b.method)));
  else if (sort === "path") list.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  else if (sort === "status") list.sort((a, b) => (Number(a.status) || 0) - (Number(b.status) || 0));
  else if (sort === "pin") list.sort((a, b) => (b.mock_pin ? 1 : 0) - (a.mock_pin ? 1 : 0));
  renderMockApis(list);
  return list;
}

// 在「已由 JSON.stringify(obj, null, 2) 标准格式化」的文本行上，
// 基于缩进层级 + 括号匹配计算每一行的 JSON 路径（供字段级注释定位）。
// 只写 line.path / line.kind，绝不参与缩进渲染 —— 缩进由 JSON.stringify 保证，
// 因此即使路径算法有边角问题，也只影响注释、不会再搞坏排版。
// line = { indent, raw, path, kind: 'open'|'close'|'leaf' }
function computeJsonPaths(lines) {
  const stack = []; // { indent, kind: 'obj'|'arr', prefix, idx }
  for (const ln of lines) {
    const trimmed = ln.raw.trim();
    while (stack.length && stack[stack.length - 1].indent >= ln.indent) stack.pop();

    if (trimmed === "}" || trimmed === "]" || trimmed === "}," || trimmed === "],") { ln.kind = "close"; ln.path = null; continue; }

    const km = trimmed.match(/^("(?:[^"\\]|\\.)*")\s*:\s*([\s\S]*)$/);
    if (km) {
      const key = JSON.parse(km[1]);
      const rest = km[2].trim();
      const parentPrefix = stack.length ? stack[stack.length - 1].prefix : "";
      const path = parentPrefix ? parentPrefix + "." + key : key;
      ln.path = path;
      if (rest === "{" || rest === "[") {
        ln.kind = "open";
        stack.push({ indent: ln.indent, kind: rest === "{" ? "obj" : "arr", prefix: path, idx: 0 });
      } else {
        ln.kind = "leaf";
      }
      continue;
    }

    if (stack.length && stack[stack.length - 1].kind === "arr") {
      const arr = stack[stack.length - 1];
      const path = arr.prefix ? arr.prefix + "." + arr.idx : String(arr.idx);
      ln.path = path;
      const isOpen = trimmed[0] === "{" || trimmed[0] === "[";
      ln.kind = isOpen ? "open" : "leaf";
      if (isOpen) {
        stack.push({ indent: ln.indent, kind: trimmed[0] === "{" ? "obj" : "arr", prefix: path, idx: 0 });
      }
      arr.idx++;
      continue;
    }

    ln.kind = "leaf";
    ln.path = null;
  }
}

// 对单行 JSON 文本做语法高亮。保持缩进与标点，返回 HTML。
function highlightJsonLine(line) {
  const tokens = [];
  // 字符串 | 数字 | true/false/null | 标点/空白
  const re = /\s+|"(?:[^"\\]|\\.)*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|[{}[\]:,]/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > lastIndex) tokens.push({ type: "text", value: line.slice(lastIndex, m.index) });
    const v = m[0];
    if (/^\s+$/.test(v)) tokens.push({ type: "text", value: v });
    else if (m[1] !== undefined) tokens.push({ type: "number", value: v });
    else if (m[2] !== undefined) tokens.push({ type: v === "null" ? "null" : "boolean", value: v });
    else if (v[0] === '"') tokens.push({ type: "string", value: v });
    else tokens.push({ type: "punc", value: v });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < line.length) tokens.push({ type: "text", value: line.slice(lastIndex) });

  // 在 key: value 行中，把紧跟 ':' 的字符串标为 key
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type === "string" && tokens[i + 1].type === "punc" && tokens[i + 1].value === ":") {
      tokens[i].type = "key";
    }
  }

  return tokens.map((t) => {
    if (t.type === "text") return esc(t.value);
    return `<span class="j-${t.type}">${esc(t.value)}</span>`;
  }).join("");
}

// 统一的 JSON 展示组件（VS Code 风格：左侧 gutter 行号 + 折叠按钮）。
// opts: { copyRaw, annotations(对象 path->note), annotateTarget("req"|"res"), seq }
// - 折叠：点击 gutter 的 ▼/▶ 折叠整块 {} / []
// - 复制：右上角「复制」按钮（通过全局委托处理，任何容器都生效）
// - 字段注释：传入 annotations 时，每个字段行尾显示 ✎，点击即对该路径加注释
function renderJsonGutter(text, opts) {
  opts = opts || {};
  if (text === null || text === undefined || text === "") return '<div class="json-empty">（空）</div>';
  let obj = null;
  try { obj = JSON.parse(typeof text === "string" ? text : JSON.stringify(text)); } catch (e) { obj = null; }

  // 标准格式化：缩进完全由 JSON.stringify 产出，绝不手搓
  let pretty;
  let hasPaths = false;
  if (obj !== null && typeof obj === "object") {
    pretty = JSON.stringify(obj, null, 2);
    hasPaths = true;
  } else {
    pretty = typeof text === "string" ? text : JSON.stringify(text, null, 2);
  }

  // 逐行：{ indent, raw(含标准缩进), path, kind }
  const lines = pretty.split("\n").map((t) => {
    const m = t.match(/^(\s*)/);
    return { indent: (m ? m[1].length : 0) / 2, raw: t, path: null, kind: "leaf" };
  });

  if (hasPaths) computeJsonPaths(lines);

  // 折叠块：基于括号匹配（open 行 → 对应 close 行），与缩进无关，不依赖手搓层级
  const folds = [];
  const st = [];
  lines.forEach((ln, i) => {
    if (ln.kind === "open") st.push(i);
    else if (ln.kind === "close" && st.length) {
      const open = st.pop();
      folds.push({ start: open + 1, end: i + 1 });
    }
  });
  const foldMap = new Map();
  folds.forEach((f, idx) => foldMap.set(f.start, idx));

  // 折叠预览：开括号行被折叠时，在同一行显示内部摘要，避免只剩孤零零的 "{"
  const openPreviews = new Map();
  folds.forEach((f) => {
    const openIdx = f.start - 1;
    const closeIdx = f.end - 1;
    const inner = [];
    for (let k = openIdx + 1; k < closeIdx; k++) {
      const t = lines[k].raw.trim();
      if (t) inner.push(t);
    }
    const closeRaw = lines[closeIdx].raw.trim();
    if (inner.length) {
      const first = inner[0];
      const truncated = first.slice(0, 40);
      const more = inner.length > 1 || first.length > 40;
      openPreviews.set(f.start, " " + truncated + (more ? "..." : "") + " " + closeRaw);
    } else {
      openPreviews.set(f.start, " " + closeRaw);
    }
  });

  const pad = String(lines.length).length;
  const annMap = (hasPaths && opts.annotations && opts.seq != null && opts.annotateTarget)
    ? opts.annotations : null;

  const body = lines.map((line, idx) => {
    const lineNo = idx + 1;
    let gutter = `<span class="json-lineno">${String(lineNo).padStart(pad, " ")}</span>`;
    const fidx = foldMap.get(lineNo);
    if (fidx !== undefined) {
      gutter = `<span class="json-fold" data-start="${folds[fidx].start}" data-end="${folds[fidx].end}">▼</span>` + gutter;
    }
    let annHtml = "";
    if (annMap && line.path) {
      const note = annMap[line.path];
      annHtml =
        `<span class="j-ann-btn" data-ann-seq="${opts.seq}" data-ann-path="${esc(line.path)}" data-ann-target="${esc(opts.annotateTarget)}" title="添加/编辑注释">✎</span>` +
        (note ? `<span class="j-ann-txt"> // ${esc(note)}</span>` : "");
    }
    const lineCls = "json-line" + ((annMap && line.path && annMap[line.path]) ? " j-annotated" : "");
    const collapsedPreview = openPreviews.get(lineNo);
    const previewSpan = collapsedPreview ? `<span class="json-collapsed-preview">${esc(collapsedPreview)}</span>` : "";
    const code = (line.raw ? highlightJsonLine(line.raw) : "&nbsp;") + previewSpan + annHtml;
    return `<div class="${lineCls}" data-line="${lineNo}"><span class="json-gutter">${gutter}</span><span class="json-code">${code}</span></div>`;
  }).join("");

  const rawForCopy = opts.copyRaw != null ? opts.copyRaw : (typeof text === "string" ? text : JSON.stringify(text, null, 2));
  const viewer = `<div class="json-viewer code" data-raw="${esc(rawForCopy)}">${body}</div>`;
  if (opts.copyRaw != null && !opts.hideCopyBtn) {
    return `<div class="code-wrap">` +
      `<span class="code-tools">` +
      `<button class="btn-mini code-copy" data-copy>复制</button>` +
      `<button class="btn-mini code-max" data-max title="最大化查看">⛶</button>` +
      `</span>` +
      viewer + `</div>`;
  }
  return viewer;
}

// ---------------- 统一数据块（JSON / 键值对同构）----------------
// 请求体 / 响应体 / 请求头 / 响应头 / Query / Timing 全部走同一外壳：
// 标题栏 + 复制全文 + 行号 gutter + 逐行「复制值」。
// 解决同一详情页内多套展示形态割裂、复制入口缺失的问题。
function renderKvViewer(obj, opts) {
  const entries = Object.entries(obj || {});
  const pad = String(entries.length).length;
  const html = opts.html || {};
  const lines = entries.map(([k, v], i) => {
    const val = v == null ? "" : (typeof v === "string" ? v : JSON.stringify(v));
    return (
      `<div class="kv-line" data-line="${i + 1}">` +
      `<span class="kv-gutter"><span class="kv-lineno">${String(i + 1).padStart(pad, " ")}</span></span>` +
      `<span class="kv-key" title="${esc(k)}">${hl(k)}</span>` +
      `<span class="kv-sep">:</span>` +
      `<span class="kv-val">${html[k] != null ? html[k] : hl(val)}</span>` +
      `<button class="btn-mini kv-copy" data-copy-value="${esc(val)}" title="复制该值">复制</button>` +
      `</div>`
    );
  }).join("");
  const raw = opts.copyRaw != null ? opts.copyRaw : JSON.stringify(obj || {}, null, 2);
  return `<div class="kv-viewer" data-raw="${esc(raw)}">${lines}</div>`;
}

function dataBlock(payload, opts) {
  opts = opts || {};
  const mode = opts.mode || "json";
  const empty = payload == null ||
    (mode === "kv" && Object.keys(payload || {}).length === 0) ||
    (mode === "json" && String(payload).trim() === "");
  const body = empty
    ? `<div class="db-empty">${esc(opts.emptyText || "（空）")}</div>`
    : (mode === "kv" ? renderKvViewer(payload, opts) : renderJsonGutter(payload, Object.assign({}, opts, { hideCopyBtn: true })));
  const actions = (opts.actions || [])
    .map((a) => `<button class="btn-mini db-act" data-db-act="${esc(a.id)}"${opts.seq != null ? ` data-db-seq="${esc(String(opts.seq))}"` : ""}>${esc(a.label)}</button>`)
    .join("");
  return (
    `<div class="data-block db-${mode}">` +
    `<div class="db-head">` +
    `<span class="db-title">${esc(opts.title || "")}</span>` +
    `<span class="db-meta">${esc(opts.meta || "")}</span>` +
    `<span class="db-spacer"></span>` +
    (empty ? "" : `<button class="btn-mini db-copy" data-copy-block>复制</button>` + `<button class="btn-mini db-max" data-max title="最大化查看">⛶</button>`) +
    actions +
    `</div>` +
    `<div class="db-body">${body}</div>` +
    `</div>`
  );
}

function renderMockApis(list) {
  if (!list.length) {
    const total = (window.__mockApis || []).length;
    mockApiList.innerHTML = `<div class="mock-api-empty">${total ? "无匹配接口（试试调整过滤词）。" : "尚无接口（仅 XHR/FETCH 类型会被模拟）。"}</div>`;
    return;
  }
  // 三级折叠：接口（method+path） → 请求参数（query） → 记录。
  // 全部默认折叠，点各层头部展开；记录详情默认折叠，限高避免撑爆。
  const groups = [];
  const gmap = new Map();
  list.forEach((a) => {
    const gk = (a.method || "GET").toUpperCase() + " " + a.path;
    let g = gmap.get(gk);
    if (!g) {
      g = { key: gk, method: a.method || "GET", path: a.path || "", queries: [], qmap: new Map() };
      gmap.set(gk, g);
      groups.push(g);
    }
    const qk = a.query || "";
    let q = g.qmap.get(qk);
    if (!q) {
      q = { key: qk, query: qk, items: [] };
      g.qmap.set(qk, q);
      g.queries.push(q);
    }
    q.items.push(a);
  });
  mockApiList.innerHTML = groups.map((g) => {
    const totalCount = g.queries.reduce((s, q) => s + q.items.length, 0);
    const pinTotal = g.queries.reduce((s, q) => s + q.items.filter((x) => x.mock_pin).length, 0);
    const pinTip = pinTotal === 1
      ? "整接口已固定：任何请求（任意 query / 请求体）都返回这条默认"
      : "多条默认（不同 query）并存：各自 query 精确命中，互不干扰";
    return `<div class="mock-group" data-group="${esc(g.key)}">
      <div class="mock-group-head" title="点击展开/折叠接口">
        <span class="method-badge m-${esc(String(g.method || "GET").toUpperCase())}">${esc(g.method || "GET")}</span>
        <span class="mock-group-path" title="${esc(g.path)}">${esc(g.path)}</span>
        <span class="mock-group-count">${totalCount} 条 / ${g.queries.length} 个 query</span>
        ${pinTotal ? `<span class="pin-badge" title="${pinTip}">已默认 ${pinTotal} 条</span>` : ""}
        <span class="expand-icon">▶</span>
      </div>
      <div class="mock-group-body">
        ${g.queries.map((q) => {
          const pinnedItem = q.items.find((x) => x.mock_pin);
          const pinTip = pinnedItem
            ? `<span class="mock-query-pin-tip" title="该 query 一律返回本条（无视请求体差异）">默认 ${pinnedItem.status} · ${esc((pinnedItem.body_preview || "").slice(0, 60))}</span>`
            : `<span class="mock-query-pin-tip muted">未默认</span>`;
          return `<div class="mock-query-item" data-qkey="${esc(q.key)}">
            <div class="mock-query-head" title="点击展开/折叠相同 query 的记录">
              <span class="mock-query-key">query: ${q.key ? `<code>${esc(q.key)}</code>` : `<span class="muted">&lt;无 query&gt;</span>`}</span>
              <span class="mock-query-count">${q.items.length} 条</span>
              ${pinTip}
              <span class="expand-icon">▶</span>
            </div>
            <div class="mock-query-body">
              ${q.items.map((a) =>
                `<div class="mock-api-card${a.mock_pin ? " pinned" : ""}" data-seq="${a.seq}">
                  <div class="mock-api-card-head">
                    <div class="mock-api-card-meta">
                      <span class="method-badge m-${esc(String(a.method || "GET").toUpperCase())}">${esc(a.method || "GET")}</span>
                      <span class="resp-badge">${esc(String(a.status))}</span>
                      <span class="mock-hit-badge">命中 ${Number(a.hits) || 0}</span>
                      <span class="resp-preview" title="${esc(a.body_preview || "")}">${esc(a.body_preview || "")}</span>
                    </div>
                    <div class="mock-api-card-ops">
                      ${rowMarkHtml(a)}
                      <button class="btn btn-sm mock-pin-one" data-seq="${a.seq}" title="${a.mock_pin ? "取消：该 query 不再固定返回本条" : "固定：该 query 一律返回本条（无视请求体差异）"}">${a.mock_pin ? "取消默认" : "默认"}</button>
                      <button class="btn btn-sm mock-test-one">测试</button>
                      <button class="btn btn-sm mock-src-one" data-jump-seq="${a.seq}" title="跳到录制页查看这条原始记录">来源</button>
                      <span class="mock-expand-toggle" title="展开/折叠详情">▼</span>
                    </div>
                  </div>
                  <div class="mock-api-card-body" style="display:none">
                    <div class="mock-api-bodies">
                      <div class="mock-card-section mock-req-section">
                        <div class="mock-card-section-title">请求体 <button class="btn-mini mock-card-max" data-max title="最大化查看">⛶</button></div>
                        <div class="mock-card-summary mock-req-summary" title="点击展开/折叠">${a.req_body_preview ? esc(a.req_body_preview) : '<span class="muted">（无请求体）</span>'}</div>
                        <div class="mock-card-code mock-req-code" style="display:none">${renderJsonGutter(a.req_body_pretty, { copyRaw: a.req_body_pretty })}</div>
                      </div>
                      <div class="mock-card-section mock-res-section">
                        <div class="mock-card-section-title">返回体 <button class="btn-mini mock-card-max" data-max title="最大化查看">⛶</button></div>
                        <div class="mock-card-summary mock-res-summary" title="点击展开/折叠">${a.body_preview ? esc(a.body_preview) : '<span class="muted">（无响应体）</span>'}</div>
                        <div class="mock-card-code mock-res-code" style="display:none">${renderJsonGutter(a.body_pretty, { copyRaw: a.body_pretty })}</div>
                      </div>
                    </div>
                    <pre class="mock-api-result" style="display:none"></pre>
                  </div>
                </div>`
              ).join("")}
            </div>
          </div>`;
        }).join("")}
      </div>
    </div>`;
  }).join("");

  // 组头展开/折叠
  mockApiList.querySelectorAll(".mock-group-head").forEach((head) => {
    head.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      head.closest(".mock-group").classList.toggle("expanded");
    });
  });
  // query 头展开/折叠
  mockApiList.querySelectorAll(".mock-query-head").forEach((head) => {
    head.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      head.closest(".mock-query-item").classList.toggle("expanded");
    });
  });
  // 单条记录头展开/折叠详情
  mockApiList.querySelectorAll(".mock-api-card-head").forEach((head) => {
    head.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const card = head.closest(".mock-api-card");
      const body = card.querySelector(".mock-api-card-body");
      const toggle = head.querySelector(".mock-expand-toggle");
      const hidden = noneOrNone(body.style.display);
      body.style.display = hidden ? "block" : "none";
      toggle.textContent = hidden ? "▲" : "▼";
      card.classList.toggle("expanded", hidden);
    });
  });
  mockApiList.querySelectorAll(".mock-test-one").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = btn.closest(".mock-api-card");
      testMockApi(window.__mockApisBySeq[card.getAttribute("data-seq")], card);
    });
  });
  mockApiList.querySelectorAll(".mock-pin-one").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      pinMockApi(window.__mockApisBySeq[btn.getAttribute("data-seq")], btn);
    });
  });
  mockApiList.querySelectorAll(".mock-src-one").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const seq = Number(btn.getAttribute("data-jump-seq"));
      if (seq) go("recording", { focusSeq: seq });
    });
  });
  mockApiList.querySelectorAll(".mock-req-summary").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const code = el.parentElement.querySelector(".mock-req-code");
      if (!code) return;
      const hidden = noneOrNone(code.style.display);
      code.style.display = hidden ? "block" : "none";
      el.classList.toggle("expanded", hidden);
    });
  });
  mockApiList.querySelectorAll(".mock-res-summary").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const code = el.parentElement.querySelector(".mock-res-code");
      if (!code) return;
      const hidden = noneOrNone(code.style.display);
      code.style.display = hidden ? "block" : "none";
      el.classList.toggle("expanded", hidden);
    });
  });
}

function noneOrNone(v) { return v === "none" || v === ""; }

async function pinMockApi(api, btn) {
  if (!api) return;
  btn.disabled = true;
  const target = !api.mock_pin;  // 切换默认态
  const res = await postJSON("/api/mock/pin", { seq: api.seq, pinned: target });
  btn.disabled = false;
  if (res && res.data && res.data.ok) {
    loadMockApis();  // 重新拉取，含最新默认状态（运行中已实时生效）
  } else {
    alert("设置默认失败：" + ((res && res.data && res.data.error) || "未知错误"));
  }
}

async function testMockApi(api, card) {
  const body = card.querySelector(".mock-api-card-body");
  const pre = card.querySelector(".mock-api-result");
  const btn = card.querySelector(".mock-test-one");
  const toggle = card.querySelector(".mock-expand-toggle");
  btn.disabled = true;
  body.style.display = "block";
  pre.style.display = "block";
  pre.textContent = "测试中…";
  if (toggle) toggle.textContent = "▲";
  card.classList.add("expanded");
  const res = await postJSON("/api/mock/test", { seq: api.seq });
  btn.disabled = false;
  if (res && res.data) {
    const d = res.data;
    let pretty = d.body || "";
    if (pretty && (pretty.trim().startsWith("{") || pretty.trim().startsWith("["))) {
      try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch (e) {}
    }
    const cls = d.ok ? (d.status < 400 ? "ok" : "err") : "err";
    pre.className = "mock-api-result " + cls;
    const reason = d.miss_reason ? `\n\n未命中原因：${d.miss_reason}` : "";
    pre.textContent = `状态 ${d.status} · ${d.ms}ms${reason}\n\n${pretty}`;
  } else {
    pre.className = "mock-api-result err";
    pre.textContent = "测试失败：无响应";
  }
}

mockRefreshBtn.addEventListener("click", loadMockApis);
if (mockSearch) mockSearch.addEventListener("input", applyMockFilterSort);
if (mockSort) mockSort.addEventListener("change", applyMockFilterSort);

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
      const missWhy = l.miss_reason
        ? `<span class="miss-reason" title="${esc(l.miss_reason)}">${esc(l.miss_reason.length > 40 ? l.miss_reason.slice(0, 40) + "…" : l.miss_reason)}</span>`
        : "";
      return (
        `<div class="mock-log-row" data-i="${i}">` +
        `<span class="log-ts">${fmtTime(l.ts)}</span>` +
        `<span class="m m-${methodClass(l)}">${esc(l.method)}</span>` +
        `<span class="s ${sc}">${esc(String(l.status))}</span>` +
        `<span class="path-text" title="${esc(l.url || "")}">${esc(l.path || "/")}${l.query ? "?" + esc(l.query) : ""}</span>` +
        miss +
        missWhy +
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
  const missWhy = log.miss_reason
    ? `<div class="mock-log-miss">未命中原因：${esc(log.miss_reason)}</div>`
    : "";
  const reqHdr = log.req_headers && Object.keys(log.req_headers).length
    ? kvTable(log.req_headers)
    : `<div class="note">无请求头</div>`;
  const resHdr = log.res_headers && Object.keys(log.res_headers).length
    ? kvTable(log.res_headers)
    : `<div class="note">无响应头</div>`;
  const reqBody = log.req_body ? renderJsonGutter(pretty(log.req_body), { copyRaw: log.req_body }) : `<div class="note">无请求体</div>`;
  const resBody = log.res_body ? renderJsonGutter(pretty(log.res_body), { copyRaw: log.res_body }) : `<div class="note">空响应体</div>`;
  mockLogModalBody.innerHTML =
    `<div class="mock-log-sec"><div class="mock-log-sec-title">请求</div>` +
    `<div class="mock-log-url">${esc(log.method)} ${esc(log.url || "")}</div>` +
    missWhy +
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
  mockLogModal.addEventListener("click", (e) => {
    if (e.target === mockLogModal) mockLogModal.classList.add("hide");
  });
}
if (mockLogList) loadMockLogs();  // 页面加载时先拉一次（进程内 Mock 不随刷新消失}

// Sync strict mode on page load
document.addEventListener("DOMContentLoaded", () => {
  // 用 GET 读取当前配置（注意：不能用 POST {}，否则后端会把已保存的端口清空）
  fetch("/api/config").then((r) => r.json()).then((d) => {
    if (d) {
      mockStrictMode = d.match_mode !== false;
      updateStrictModeUI();
    }
  });
  
  // 开关变更事件
  if (mockStrictToggleEl) {
    mockStrictToggleEl.addEventListener("change", () => {
      mockStrictMode = mockStrictToggleEl.checked;
      syncMockStrictMode();
    });
  }
});

// ---------------- Mock 接口列表（内联在 Mock tab）+ 快速测试 ----------------

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
    `<button class="btn-mini" id="editResBtn" title="编辑响应（状态码 / 响应头 / 响应体），用于造数据">✏ 编辑响应</button>` +
    `<button class="btn-mini" id="gotoLibBtn" title="在请求库中查看该接口的完整文档">📚 请求库</button>` +
    `<button class="btn-mini" id="pinMockBtn" title="把这条响应固定为 Mock 默认返回">📌 固定到 Mock</button>` +
    (hasBody ? `<button class="btn-mini" id="downloadFileBtn" title="将响应体另存为文件">⬇ 下载文件</button>` : "") +
    `<button class="btn-mini" id="delDetailBtn" title="删除该条录制记录">🗑 删除</button>` +
    `</div>` +
    `<div class="detail-meta">状态 <span class="${sc}">${esc(String(statusTxt))}</span> · 类型 ${esc(rec.resource_type)} · ` +
    `大小 ${fmtSize(rec.response && rec.response.size_bytes)} · 耗时 ${rec.duration_ms != null ? rec.duration_ms + "ms" : "—"}` +
    `<br>域 ${esc(rec.registered_domain)} · host ${esc(rec.host)}</div>` +
    `</div>`;
  const tabs =
    `<div class="detail-tabs">` +
    tabBtn("overview", "概览") + tabBtn("request", "请求") + tabBtn("response", "响应") +
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

  const editResBtn = $("editResBtn");
  if (editResBtn) {
    editResBtn.addEventListener("click", () => openEditRes(rec));
  }

  const gotoLibBtn = $("gotoLibBtn");
  if (gotoLibBtn) gotoLibBtn.addEventListener("click", () => gotoLibEndpoint(rec));

  const pinMockBtn = $("pinMockBtn");
  if (pinMockBtn) pinMockBtn.addEventListener("click", () => pinSeqToMock(rec.seq, pinMockBtn));

  const markSaveBtn = $("markSaveBtn");
  if (markSaveBtn) {
    markSaveBtn.addEventListener("click", () => {
      const tagsRaw = ($("markTagsInput") && $("markTagsInput").value) || "";
      const tags = tagsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const note = ($("markNoteInput") && $("markNoteInput").value) || "";
      markSaveBtn.disabled = true;
      // 写接口级文档（与请求库共享），按 method+path 定位
      postJSON("/api/endpoint/doc", { method: rec.method, path: rec.path, tags, note })
        .then((res) => {
          if (res.ok && res.data && res.data.ok) {
            if (currentDetail) currentDetail.tags = tags;
            markSaveBtn.textContent = "已保存 ✓";
            setTimeout(() => { markSaveBtn.textContent = "保存"; }, 1200);
            if (window.refreshEndpointDocs) window.refreshEndpointDocs();
          } else {
            alert("保存失败：" + ((res.data && res.data.error) || "未知错误"));
          }
        })
        .catch((e) => alert("保存失败：" + e))
        .finally(() => { markSaveBtn.disabled = false; });
    });
  }
  // 回填接口级标签/备注（与请求库共享）
  postJSON("/api/endpoint/doc", { method: rec.method, path: rec.path }).then((r) => {
    if (r.ok && r.data && r.data.ok && r.data.doc) {
      const d = r.data.doc;
      const ti = $("markTagsInput"); if (ti && d.tags) ti.value = d.tags.join(", ");
      const ni = $("markNoteInput"); if (ni) ni.value = d.note || "";
    }
  }).catch(() => {});

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

      downloadFileSave(filename, body)
        .catch((e) => alert("下载失败：" + e.message))
        .finally(() => { dlBtn.disabled = false; dlBtn.textContent = oldText; });
    });
  }
}

function tabBtn(key, label, activeKey) {
  return `<div class="tab${key === (activeKey || currentTab) ? " active" : ""}" data-tab="${key}">${label}</div>`;
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
    const statusTxt = rec.is_failed ? "失败" : (r.status != null ? r.status : "—");
    const basic = {
      方法: rec.method || "",
      URL: rec.url || "",
      状态: String(statusTxt) + (r.status_text ? " " + r.status_text : ""),
      资源类型: rec.resource_type || "",
      MIME: r.mime_type || "—",
      大小: fmtSize(r.size_bytes),
      耗时: rec.duration_ms != null ? rec.duration_ms + "ms" : "—",
      主域名: rec.registered_domain || "",
      host: rec.host || "",
    };
    return dataBlock(basic, {
      mode: "kv",
      title: "基本信息",
      html: {
        URL: `${hl(rec.url)}`,
        状态: `<span class="${statusClass(rec)}">${esc(String(statusTxt))}</span> ${esc(r.status_text || "")}`,
      },
    }) + renderOverviewSections(rec);
  }
  if (which === "request") {
    const t = rec.request && rec.request.post_data;
    const raw = t == null ? "" : (typeof t === "string" ? t : JSON.stringify(t, null, 2));
    return dataBlock(raw, {
      mode: "json",
      title: "请求体",
      meta: raw ? raw.split("\n").length + " 行" : "",
      emptyText: "无请求体",
      annotations: (rec.annotations && rec.annotations.req) || {},
      annotateTarget: "req",
      seq: rec.seq,
      actions: [{ id: "curl", label: "复制为 cURL" }],
    });
  }
  if (which === "response") {
    const r = rec.response || {};
    const t = r.body;
    const raw = t == null ? "" : (typeof t === "string" ? t : JSON.stringify(t, null, 2));
    const binary = t == null && (r.body_size || 0) > 0;
    const blk = dataBlock(raw, {
      mode: "json",
      title: "响应体",
      meta: raw ? raw.split("\n").length + " 行" : "",
      emptyText: binary ? `二进制响应体（大小 ${fmtSize(r.body_size)}），未捕获原文。` : "无响应体",
      annotations: (rec.annotations && rec.annotations.res) || {},
      annotateTarget: "res",
      seq: rec.seq,
    });
    return blk + (r.truncated ? `<div class="note">⚠ 内容已截断，完整内容见导出的 HAR / JSON。</div>` : "");
  }
  return "";
}

function queryToObj(q) {
  if (!q) return {};
  const obj = {};
  for (const [k, v] of new URLSearchParams(q).entries()) obj[k] = v;
  return obj;
}

function countOf(obj) {
  const n = Object.keys(obj || {}).length;
  return n ? n + " 项" : "";
}

function recBySeq(seq) {
  if (seq == null) return currentDetail;
  const found = allRequests.find((r) => String(r.seq) === String(seq));
  return found || currentDetail;
}

function reqToCurl(rec) {
  const parts = [`curl -X ${(rec.method || "GET").toUpperCase()} '${rec.url || ""}'`];
  const h = (rec.request && rec.request.headers) || {};
  Object.keys(h).forEach((k) => {
    if (/^(host|content-length|connection)$/i.test(k)) return;
    parts.push(`  -H '${k}: ${h[k]}'`);
  });
  const b = rec.request && rec.request.post_data;
  if (b != null) {
    const body = typeof b === "string" ? b : JSON.stringify(b);
    parts.push(`  --data-raw '${body.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(" \\\n");
}

function handleBlockAction(id, btn) {
  const rec = recBySeq(btn.getAttribute("data-db-seq"));
  if (!rec) return;
  if (id === "curl") copyText(reqToCurl(rec), btn);
  else if (id === "json") {
    const b = rec.response && rec.response.body;
    copyText(typeof b === "string" ? b : JSON.stringify(b, null, 2), btn);
  }
}

// ---------------- 接口级联动：三页围绕 method+path 互相跳转 ----------------
function notify(msg) {
  const toast = $("exportToast");
  if (!toast) return;
  toast.innerHTML =
    `<span class="export-toast-msg">${esc(msg)}</span>` +
    `<button class="btn btn-sm" id="exportToastClose">×</button>`;
  toast.classList.remove("hide");
  const close = $("exportToastClose");
  if (close) close.addEventListener("click", () => toast.classList.add("hide"));
  clearTimeout(window.__notifyTimer);
  window.__notifyTimer = setTimeout(() => toast.classList.add("hide"), 2600);
}

// 录制详情 → 请求库：按 method+path 定位到该接口的完整文档
function gotoLibEndpoint(rec) {
  const isApi = ["XHR", "FETCH"].includes((rec.resource_type || "").toUpperCase());
  if (!isApi) libState.filters.apiOnly = false;
  libState.view = "detail";
  libState.domain = rec.registered_domain || rec.host || "";
  libState.method = (rec.method || "GET").toUpperCase();
  libState.path = rec.path || "";
  libState.filter = "";
  go("library");
  renderLibrary();
}

// 请求库 / Mock → 录制页：定位到具体某一条
function gotoRecordingSeq(seq) {
  go("recording");
  setTimeout(() => openDetail(seq), 30);
}

async function pinSeqToMock(seq, btn) {
  if (btn) btn.disabled = true;
  const res = await postJSON("/api/mock/pin", { seq, pinned: true });
  if (btn) btn.disabled = false;
  if (res && res.data && res.data.ok) {
    notify("已把该条固定为 Mock 默认返回");
    loadMockApis();
  } else {
    alert("固定失败：" + ((res && res.data && res.data.error) || "未知错误"));
  }
}

// 概览 = 全部扁平信息分区展示：基本信息 / Query / 请求头 / 响应头 / Timing
function renderOverviewSections(rec) {
  const r = rec.response || {};
  const reqH = (rec.request && rec.request.headers) || {};
  const resH = r.headers || {};
  const q = queryToObj(rec.query);
  return (
    dataBlock(q, { mode: "kv", title: "Query 参数", meta: countOf(q), emptyText: "无 Query 参数" }) +
    dataBlock(reqH, { mode: "kv", title: "请求头", meta: countOf(reqH), emptyText: "无请求头" }) +
    dataBlock(resH, { mode: "kv", title: "响应头", meta: countOf(resH), emptyText: "无响应头" }) +
    dataBlock(rec.timing, { mode: "kv", title: "Timing", meta: countOf(rec.timing), emptyText: "无耗时数据" })
  );
}

// ---------------- 标记（接口级备注 + 标签，与请求库共享同一份）----------------
function tagsEditorHtml(rec) {
  return (
    `<div class="tags-bar">` +
    `<span class="tags-label">接口标签</span>` +
    `<input id="markTagsInput" class="input tags-input" placeholder="登录, 核心" value="">` +
    `<button class="btn-mini" id="markSaveBtn">保存</button>` +
    `</div>` +
    `<div class="tags-bar">` +
    `<span class="tags-label">接口备注</span>` +
    `<input id="markNoteInput" class="input tags-input" placeholder="接口级备注（与请求库共享）" value="">` +
    `</div>` +
    `<div class="note-hint">标签 / 备注为接口级，录制与请求库共享同一份</div>`
  );
}

// ---------------- 字段级注释：保存并刷新 ----------------
// 与 backend /api/request/annotate 对齐：target 用 "req" / "res"
function annotateSeq(seq, target, path) {
  const note = prompt("添加/编辑注释（清空后确定 = 删除）：", "");
  if (note === null) return;
  postJSON("/api/request/annotate", { seq, target, path, note })
    .then((res) => {
      if (res.ok && res.data && res.data.ok) {
        openDetail(seq);  // 重新拉完整记录，刷新注释展示
      } else {
        alert("保存注释失败：" + ((res.data && res.data.error) || "未知错误"));
      }
    })
    .catch((e) => alert("保存注释失败：" + e));
}

// ---------------- 编辑请求（造数据：改 URL / 请求头 / 请求体）----------------
function openEditReq(rec) {
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

// ---------------- 编辑响应（造数据：改状态码 / 响应头 / 响应体）----------------
function openEditRes(rec) {
  const modal = $("editResModal");
  if (!modal) return;
  const r = rec.response || {};
  $("editResStatus").value = r.status != null ? r.status : "";
  $("editResStatusText").value = r.status_text || "";
  const hdr = r.headers || {};
  $("editResHeaders").value = Object.keys(hdr).length ? JSON.stringify(hdr, null, 2) : "{}";
  const b = r.body;
  $("editResBody").value = b == null ? "" : (typeof b === "string" ? b : JSON.stringify(b, null, 2));
  $("editResErr").textContent = "";
  modal.classList.remove("hide");
  setTimeout(() => $("editResStatus") && $("editResStatus").focus(), 50);
}

function wireEditResModal() {
  const modal = $("editResModal");
  if (!modal) return;
  $("editResModalClose").addEventListener("click", () => modal.classList.add("hide"));
  $("editResCancel").addEventListener("click", () => modal.classList.add("hide"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hide"); });
  $("editResSave").addEventListener("click", () => {
    if (!currentDetail) return;
    const errEl = $("editResErr");
    errEl.textContent = "";
    const statusRaw = $("editResStatus").value.trim();
    let res_status = null;
    if (statusRaw !== "") {
      res_status = Number(statusRaw);
      if (!Number.isInteger(res_status) || res_status < 100 || res_status > 599) {
        errEl.textContent = "状态码必须是 100-599 的整数";
        return;
      }
    }
    const saveBtn = $("editResSave");
    saveBtn.disabled = true;
    postJSON("/api/response/edit", {
      seq: currentDetail.seq,
      res_status,
      res_status_text: $("editResStatusText").value,
      res_headers: $("editResHeaders").value,
      res_body: $("editResBody").value,
    })
      .then((res) => {
        if (res.ok && res.data && res.data.ok) {
          modal.classList.add("hide");
          openDetail(currentDetail.seq);  // 重新拉取，刷新概览/响应体/树
        } else {
          errEl.textContent = "保存失败：" + ((res.data && res.data.error) || "未知错误");
        }
      })
      .catch((e) => { errEl.textContent = "保存失败：" + e; })
      .finally(() => { saveBtn.disabled = false; });
  });
}

// ---------------- 详情内「复制请求地址」按钮 ----------------
// 折叠 / 复制 JSON / 字段注释 由全局委托（wireGlobalJsonInteractions）统一处理，
// 这样不论 JSON 渲染在详情页、Mock 卡片还是 Mock 日志弹窗，交互都生效。
detailEl.addEventListener("click", (e) => {
  const copyUrlBtn = e.target.closest("[data-copy-url]");
  if (copyUrlBtn && currentDetail) {
    e.stopPropagation();
    copyText(currentDetail.url || "", copyUrlBtn);
  }
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

// ---------------- 全局 JSON 交互委托 ----------------
// 折叠 / 复制 / 字段注释 统一在 document 上委托，
// 这样无论 JSON 渲染在详情页、Mock 卡片还是 Mock 日志弹窗，交互都生效，
// 不再依赖各容器单独调用 wireJsonFolds。
function wireGlobalJsonInteractions() {
  document.addEventListener("click", (e) => {
    // 1) 折叠：gutter 的 ▼/▶
    const fold = e.target.closest(".json-fold");
    if (fold) {
      e.stopPropagation();
      const end = Number(fold.getAttribute("data-end"));
      const viewer = fold.closest(".json-viewer");
      if (!viewer) return;
      const openLine = fold.closest(".json-line");
      const openLineNo = openLine ? Number(openLine.getAttribute("data-line")) : 0;
      const collapsed = fold.classList.toggle("collapsed");
      fold.textContent = collapsed ? "▶" : "▼";
      if (openLine) openLine.classList.toggle("fold-collapsed", collapsed);
      for (let i = openLineNo + 1; i <= end; i++) {
        const line = viewer.querySelector(`.json-line[data-line="${i}"]`);
        if (line) line.classList.toggle("fold-hidden", collapsed);
      }
      return;
    }
    // 2) 字段级注释：✎
    const ann = e.target.closest("[data-ann-path]");
    if (ann) {
      e.stopPropagation();
      const seq = Number(ann.getAttribute("data-ann-seq"));
      const path = ann.getAttribute("data-ann-path");
      const target = ann.getAttribute("data-ann-target");
      if (seq && target) annotateSeq(seq, target, path);
      return;
    }
    // 3) 数据块：复制整块
    const blkCopy = e.target.closest("[data-copy-block]");
    if (blkCopy) {
      e.stopPropagation();
      const blk = blkCopy.closest(".data-block");
      const holder = blk && blk.querySelector("[data-raw]");
      if (holder) copyText(holder.getAttribute("data-raw"), blkCopy);
      return;
    }
    // 4) 数据块：逐行复制值
    const valCopy = e.target.closest("[data-copy-value]");
    if (valCopy) {
      e.stopPropagation();
      copyText(valCopy.getAttribute("data-copy-value"), valCopy);
      return;
    }
    // 5) 数据块：块级动作（复制为 cURL 等）
    const act = e.target.closest("[data-db-act]");
    if (act) {
      e.stopPropagation();
      handleBlockAction(act.getAttribute("data-db-act"), act);
      return;
    }
    // 6) 联动：跳到录制页定位该条
    const jump = e.target.closest("[data-jump-seq]");
    if (jump) {
      e.stopPropagation();
      gotoRecordingSeq(Number(jump.getAttribute("data-jump-seq")));
      return;
    }
    // 7) 联动：固定为 Mock 默认返回
    const pin = e.target.closest("[data-pin-seq]");
    if (pin) {
      e.stopPropagation();
      pinSeqToMock(Number(pin.getAttribute("data-pin-seq")), pin);
      return;
    }
    // 7.5) 最大化：把 JSON / 键值对组件在弹窗里全尺寸展示
    const max = e.target.closest("[data-max]");
    if (max) {
      e.stopPropagation();
      const scope = max.closest(".data-block, .code-wrap, .mock-card-section, .mock-log-sec");
      if (scope) openJsonMax(scope);
      return;
    }
    // 8) 复制：code-copy 按钮
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      e.stopPropagation();
      const wrap = copy.closest(".code-wrap");
      if (!wrap) return;
      const viewer = wrap.querySelector(".json-viewer");
      if (viewer && viewer.hasAttribute("data-raw")) {
        copyText(viewer.getAttribute("data-raw"), copy);
        return;
      }
      const pre = wrap.querySelector(".code");
      if (pre) {
        const raw = pre.getAttribute("data-raw");
        copyText(raw != null ? raw : pre.textContent, copy);
      }
      return;
    }
  });
}

// ---------------- JSON / 键值对 最大化查看 ----------------
// 直接克隆源 viewer（.json-viewer / .kv-viewer）进弹窗，全尺寸展示：
// 折叠 / 复制 / 字段注释等交互由全局委托（wireGlobalJsonInteractions）自动生效，
// 无需为弹窗重新绑定；bare viewer（无 code-wrap）的复制由弹窗「复制」按钮提供。
function openJsonMax(scopeEl) {
  if (!scopeEl) return;
  const viewer = scopeEl.querySelector(".json-viewer, .kv-viewer");
  if (!viewer) return;
  const clone = viewer.cloneNode(true);
  const body = $("jsonMaxBody");
  if (!body) return;
  body.innerHTML = "";
  body.appendChild(clone);
  const title = $("jsonMaxTitle");
  if (title) {
    const t = scopeEl.querySelector(".db-title, .mock-card-section-title, .mock-log-sub");
    title.textContent = t ? t.textContent.trim() : "最大化查看";
  }
  const modal = $("jsonMaxModal");
  if (modal) modal.classList.remove("hide");
}

function closeJsonMax() {
  const modal = $("jsonMaxModal");
  if (modal) modal.classList.add("hide");
  const body = $("jsonMaxBody");
  if (body) body.innerHTML = "";
}

function wireJsonMaxModal() {
  const modal = $("jsonMaxModal");
  if (!modal) return;
  const close = $("jsonMaxClose");
  if (close) close.addEventListener("click", closeJsonMax);
  const copy = $("jsonMaxCopy");
  if (copy) copy.addEventListener("click", () => {
    const v = $("jsonMaxBody");
    const holder = v && v.querySelector("[data-raw]");
    if (holder) copyText(holder.getAttribute("data-raw") || "", copy);
  });
  modal.addEventListener("click", (e) => { if (e.target === modal) closeJsonMax(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hide")) closeJsonMax();
  });
}

// ---------------- 工具栏 ----------------
function postJSON(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json().then((d) => ({ ok: r.ok, data: d })));
}

// 导出统一改为「后端写盘到 runtime/exports」：可靠、不依赖 WebView2 的 blob 下载
// （那条链路在部分环境下会静默不写盘，且无可见反馈）。后端把文件写到磁盘并返回
// 绝对路径，前端用 toast 提示并提供「打开文件夹」（/api/open 在资源管理器选中文件）
// 与「复制路径」。
function showExportToast(path) {
  const toast = $("exportToast");
  if (!toast) return;
  toast.innerHTML =
    `<span class="export-toast-msg">已导出：<code>${esc(path)}</code></span>` +
    `<button class="btn btn-sm" id="exportOpenBtn">打开文件夹</button>` +
    `<button class="btn btn-sm" id="exportCopyBtn">复制路径</button>` +
    `<button class="btn btn-sm" id="exportToastClose">×</button>`;
  toast.classList.remove("hide");
  $("exportToastClose").addEventListener("click", () => toast.classList.add("hide"));
  $("exportOpenBtn").addEventListener("click", () => {
    postJSON("/api/open", { path }).then((r) => {
      if (!r.ok || !r.data.ok) alert("打开失败：" + ((r.data && r.data.error) || "未知错误"));
    }).catch((e) => alert("打开失败：" + e));
  });
  $("exportCopyBtn").addEventListener("click", () => {
    const t = path;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(() => alert("已复制路径")).catch(() => fallbackCopyPath(t));
    } else {
      fallbackCopyPath(t);
    }
  });
}

function fallbackCopyPath(text) {
  const ta = document.createElement("textarea");
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); alert("已复制路径"); }
  catch (e) { alert("复制失败：" + text); }
  ta.remove();
}

// 详情区「下载文件」：把单条响应体落盘到 EXPORT_DIR，与导出走同一套可靠路径
function downloadFileSave(filename, content) {
  return postJSON("/api/file/save", { filename, content }).then((r) => {
    if (r.ok && r.data && r.data.ok) {
      showExportToast(r.data.path);
    } else {
      alert("下载失败：" + ((r.data && r.data.error) || "未知错误"));
    }
  }).catch((e) => alert("下载失败：" + e));
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

let desensitizeEl = $("desensitize");
const localBrowserEl = $("localBrowser");
const localBrowserField = $("localBrowserField");
let maskCjkEl = $("maskCjk");
let maskDigitEl = $("maskDigit");
let maskAlphaEl = $("maskAlpha");
let portInputEl = $("portInput");
let mockPortInputEl = $("mockPortInput");
const mockPortInput2El = $("mockPortInput2");
let portHintEl = $("portHint");
const MASK_KEY = "api_recorder_mask_cfg";

function loadMaskCfg() {
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(MASK_KEY) || "{}"); } catch (e) { cfg = {}; }
  if (maskCjkEl) maskCjkEl.value = cfg.cjk != null ? cfg.cjk : "测";
  if (maskDigitEl) maskDigitEl.value = cfg.digit != null ? cfg.digit : "1";
  if (maskAlphaEl) maskAlphaEl.value = cfg.alpha != null ? cfg.alpha : "a";
}
function savePortCfg() {
  // 端口 / Mock 端口：写到后端 config.json（服务端口需重启生效；Mock 端口下次启动生效）
  // 注意：go('settings') 每次进入都会 renderSettings() 重新渲染设置页，模块级缓存的
  // portInputEl/mockPortInputEl 指向已脱离文档的旧节点（值恒为空），必须实时查询当前 DOM。
  const pi = $("portInput");
  const mi = $("mockPortInput");
  const raw = pi ? pi.value.trim() : "";
  const port = raw === "" ? null : raw;
  const mraw = mi ? mi.value.trim() : "";
  const mock_port = mraw === "" ? null : mraw;
  postJSON("/api/config", { port, mock_port }).then((res) => {
    if (!res.ok || !res.data || !res.data.ok) {
      alert("配置保存失败：" + ((res.data && res.data.error) || ""));
      return;
    }
    // 同步回填 Mock 页输入框，避免两处不一致
    if (mock_port && mockPortInput2El) mockPortInput2El.value = mock_port;
    const btn = $("maskSave");
    if (btn) { const t = btn.textContent; btn.textContent = "已保存 ✓"; btn.disabled = true; setTimeout(() => { btn.textContent = t; btn.disabled = false; }, 1200); }
    const saved = [port ? "服务端口 " + port : null, mock_port ? "Mock 端口 " + mock_port : null].filter(Boolean).join("、");
    alert("设置已保存：" + (saved || "（均留空 = 自动）") + "\n服务端口修改需重启本程序后生效；Mock 端口下次启动 Mock 时生效。");
  }).catch((e) => alert("配置保存失败：" + e));
}
// 脱敏规则：输入即存 localStorage（配置面板不放脱敏，导出弹窗里改即持久化）
function persistMaskCfg() {
  const cfg = { cjk: maskCjkEl.value, digit: maskDigitEl.value, alpha: maskAlphaEl.value };
  localStorage.setItem(MASK_KEY, JSON.stringify(cfg));
}
// 默认预填，保证不改配置时行为与之前一致
loadMaskCfg();
// 端口回填 / 脱敏输入绑定延后到 init（设置屏渲染后）执行，见文件末尾

// 导出按钮 → 跳转「导出」独立模块（统一在导出页完成格式/范围/脱敏/预览）
const exportBtn = $("exportBtn");
if (exportBtn) exportBtn.addEventListener("click", () => go("export"));

wireEditReqModal();
wireEditResModal();
wireGlobalJsonInteractions();
wireJsonMaxModal();

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
      ? "导入将增量合并到当前库（按请求体+返回体自动去重），继续？"
      : `导入将增量合并到当前库（按请求体+返回体自动去重），并合并导入 ${files.length} 个文件：\n${names.join("\n")}\n\n继续？`;
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
        const dup = res.data.duplicates ? `，去重 ${res.data.duplicates} 条` : "";
        alert(
          `导入成功：${res.data.kind} 共 ${res.data.count} 条${dup}` +
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

// 同样拉一次录制状态：刷新页面时若正在录制，按钮状态能立即正确反映
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

// ---------------- 侧边导航 + 多屏切换 ----------------
const SCREENS = ["overview", "recording", "mock", "library", "export", "settings"];
const TITLES = {
  overview: ["概览", "录制 · Mock · 请求库 一体化视图"],
  recording: ["录制", "拉起浏览器，按域名实时组织所有请求"],
  mock: ["Mock 服务", "基于录制库启动进程内 Mock，供被测程序对接"],
  library: ["请求库", "按归属 / 端点组织的 API 清单与可编辑文档"],
  export: ["导出", "将录制库导出为多种格式，支持脱敏与范围筛选"],
  settings: ["设置", "端口 / 脱敏 / 浏览器内核"],
};
const screenEls = {};
SCREENS.forEach((s) => { screenEls[s] = document.querySelector(`.screen[data-screen="${s}"]`); });
const topTitle = $("topTitle");
const topSub = $("topSub");

function go(screen) {
  if (!SCREENS.includes(screen)) screen = "recording";
  SCREENS.forEach((s) => { const el = screenEls[s]; if (el) el.classList.toggle("active", s === screen); });
  document.querySelectorAll(".nav-item").forEach((n) =>
    n.classList.toggle("active", n.getAttribute("data-go") === screen));
  const t = TITLES[screen];
  if (topTitle) topTitle.textContent = t[0];
  if (topSub) topSub.textContent = t[1];
  if (screen === "overview") renderOverview();
  else if (screen === "library") renderLibrary();
  else if (screen === "export") renderExport();
  else if (screen === "settings") renderSettings();
  else if (screen === "mock") loadMockApis();
  if (screen === "recording") render();
  updateNavBadges();
}

function updateNavBadges() {
  const recB = $("navRecBadge"); const mockB = $("navMockBadge");
  if (recB) recB.textContent = String(allRequests.length);
  if (mockB) mockB.textContent = String((window.__mockApis || []).length);
  const dot = $("navRecDot"); const txt = $("navRecText");
  if (dot && txt) {
    dot.classList.toggle("live", recordingActive);
    txt.textContent = recordingActive ? "录制中" : (mockRunning ? "Mock 运行中" : "空闲");
  }
}

document.querySelectorAll(".nav-item").forEach((n) => {
  n.addEventListener("click", () => go(n.getAttribute("data-go")));
});

// ---------------- 概览 ----------------
function renderOverview() {
  const pad = $("overviewPad");
  if (!pad) return;
  const total = allRequests.length;
  const domains = new Set(allRequests.map((r) => r.registered_domain || r.host)).size;
  const apis = allRequests.filter((r) => ["XHR", "FETCH"].includes((r.resource_type || "").toUpperCase())).length;
  const errors = allRequests.filter((r) => r.is_failed || (r.response && r.response.status >= 400)).length;
  const mockCount = (window.__mockApis || []).length;
  const rec = allRequests.slice(-8).reverse();
  pad.innerHTML =
    `<div class="stat-grid">
      <div class="stat-card"><div class="stat-ic">📡</div><div><div class="stat-num">${total}</div><div class="stat-label">录制请求</div></div></div>
      <div class="stat-card"><div class="stat-ic">🌐</div><div><div class="stat-num">${domains}</div><div class="stat-label">归属域</div></div></div>
      <div class="stat-card"><div class="stat-ic">🔌</div><div><div class="stat-num">${apis}</div><div class="stat-label">API 调用</div></div></div>
      <div class="stat-card"><div class="stat-ic">🧪</div><div><div class="stat-num">${mockCount}</div><div class="stat-label">Mock 接口</div></div></div>
      <div class="stat-card"><div class="stat-ic">⚠️</div><div><div class="stat-num">${errors}</div><div class="stat-label">错误响应</div></div></div>
    </div>
    <div class="card">
      <div class="card-title">快捷操作</div>
      <div class="quick-actions">
        <button class="btn btn-primary" id="ovStart">● 开始录制</button>
        <button class="btn" id="ovMock">▶ 启动 Mock</button>
        <button class="btn" id="ovLib">📚 打开请求库</button>
        <button class="btn" id="ovExport">📤 导出</button>
      </div>
    </div>
    <div class="card">
      <div class="card-title">最近活动</div>
      <div class="lib-list" id="ovRecent">${rec.length ? "" : '<div class="empty">暂无录制，去「录制」页开始吧。</div>'}</div>
    </div>`;
  const ovStart = $("ovStart"); if (ovStart) ovStart.addEventListener("click", () => { go("recording"); if (!recordingActive) startBtn.click(); });
  const ovMock = $("ovMock"); if (ovMock) ovMock.addEventListener("click", () => { go("mock"); if (!mockRunning) startMockBtn.click(); });
  const ovLib = $("ovLib"); if (ovLib) ovLib.addEventListener("click", () => go("library"));
  const ovExport = $("ovExport"); if (ovExport) ovExport.addEventListener("click", () => go("export"));
  const rc = $("ovRecent");
  if (rc && rec.length) {
    rc.innerHTML = rec.map((r) => {
      const m = (r.method || "GET").toUpperCase();
      return `<div class="lib-ep-row" data-seq="${r.seq}">
        <span class="method-badge m-${(m || "get").toLowerCase()}">${m}</span>
        <span class="ep-path">${esc(r.path || r.url || "")}</span>
        <span class="ep-cnt">${r.response && r.response.status ? r.response.status : ""}</span>
      </div>`;
    }).join("");
    rc.querySelectorAll(".lib-ep-row").forEach((row) => row.addEventListener("click", () => {
      const seq = Number(row.getAttribute("data-seq"));
      go("recording"); openDetail(seq);
    }));
  }
}

// ---------------- 请求库（清单 + 端点详情 + 可编辑 API 文档）----------------
const libState = { view: "list", domain: "", method: "", path: "", filter: "", collapsed: {}, filters: { methods: new Set(), err: false, apiOnly: true } };
window.libState = libState;
function libMatch(d, m, p, arr) {
  if (libState.filters.methods.size && !libState.filters.methods.has(m)) return false;
  if (libState.filters.err) {
    const hasErr = arr.some((r) => r.is_failed || (r.response && r.response.status && r.response.status >= 400));
    if (!hasErr) return false;
  }
  return true;
}
function groupLib() {
  const byDomain = {};
  allRequests.forEach((r) => {
    // 请求库只收 API（XHR/FETCH）；非 API（DOCUMENT/IMAGE/STYLESHEET…）默认不进库
    if (libState.filters.apiOnly && !["XHR", "FETCH"].includes((r.resource_type || "").toUpperCase())) return;
    const d = r.registered_domain || r.host || "(未知)";
    if (!byDomain[d]) byDomain[d] = {};
    const key = (r.method || "GET").toUpperCase() + " " + (r.path || r.url || "");
    if (!byDomain[d][key]) byDomain[d][key] = [];
    byDomain[d][key].push(r);
  });
  return byDomain;
}
// 左：文档目录（常驻）
function renderLibOutline() {
  const $ot = $("libOutline");
  const $oc = $("libOutlineCount");
  if (!$ot) return;
  const grouped = groupLib();
  const f = (libState.filter || "").trim().toLowerCase();
  const domains = Object.keys(grouped).sort().filter((d) => {
    if (!f) return true;
    if (d.toLowerCase().includes(f)) return true;
    return Object.keys(grouped[d]).some((k) => k.toLowerCase().includes(f));
  });
  if ($oc) $oc.textContent = "(" + domains.length + ")";
  $ot.innerHTML = "";
  if (!domains.length) {
    $ot.innerHTML = '<div class="empty" style="padding:14px">无匹配接口</div>';
    return;
  }
  domains.forEach((d) => {
    const eps = Object.keys(grouped[d]).sort();
    const filtered = eps.filter((k) => {
      const sp = k.split(" "); const m = sp[0]; const p = sp.slice(1).join(" ");
      if (f && !k.toLowerCase().includes(f)) return false;
      return libMatch(d, m, p, grouped[d][k]);
    });
    if (!filtered.length) return;
    const grp = document.createElement("div");
    grp.className = "ol-group";
    const head = document.createElement("div");
    head.className = "ol-ghead" + (libState.collapsed[d] ? " collapsed" : "");
    head.innerHTML = `<span class="tw">▼</span><span class="ic">🌐</span>${esc(d)}<span class="gb">${eps.length}</span>`;
    head.addEventListener("click", () => {
      libState.collapsed[d] = !libState.collapsed[d];
      renderLibOutline();
    });
    grp.appendChild(head);
    if (!libState.collapsed[d]) {
      filtered.forEach((k) => {
        const sp = k.split(" ");
        const m = sp[0]; const p = sp.slice(1).join(" ");
        const isActive = libState.view === "detail" && libState.domain === d && libState.method === m && libState.path === p;
        const it = document.createElement("div");
        it.className = "ol-ep" + (isActive ? " active" : "");
        it.title = k;
        it.innerHTML = `<span class="method-badge m-${m.toLowerCase()}">${m}</span> <span class="ol-ep-path">${esc(p)}</span>`;
        it.addEventListener("click", () => {
          libState.view = "detail";
          libState.domain = d; libState.method = m; libState.path = p;
          renderLibrary();
        });
        grp.appendChild(it);
      });
    }
    $ot.appendChild(grp);
  });
}
// 右：清单 / 端点详情（切换）
// 接口文档缓存：录制详情与请求库共享同一份，列表标签据此渲染
let endpointDocCache = {};
function refreshEndpointDocs() {
  return postJSON("/api/endpoint/docs", {}).then((r) => {
    if (r.ok && r.data && r.data.ok) {
      const c = {};
      (r.data.docs || []).forEach((d) => { c[(d.method || "").toUpperCase() + " " + (d.path || "")] = d; });
      endpointDocCache = c;
    }
  }).catch(() => {});
}
function renderLibrary() {
  renderLibOutline();
  const pad = $("libraryPad");
  if (!pad) return;
  if (libState.view === "detail") renderLibDetail(pad);
  else renderLibList(pad);
  refreshEndpointDocs().then(() => {
    if (libState.view === "list" && pad) renderLibList(pad);
  });
}
function renderLibList(pad) {
  const grouped = groupLib();
  const f = (libState.filter || "").trim().toLowerCase();
  const domains = Object.keys(grouped).sort().filter((d) => {
    if (!f) return true;
    if (d.toLowerCase().includes(f)) return true;
    return Object.keys(grouped[d]).some((k) => k.toLowerCase().includes(f));
  });
  if (!domains.length) {
    pad.innerHTML = `<div class="card"><div class="empty">${f ? "无匹配接口" : "请求库为空。录制或导入接口后，这里会按归属域组织成 API 清单。"}</div></div>`;
    return;
  }
  let html = `<div class="lib-list">`;
  domains.forEach((d) => {
    const eps = Object.keys(grouped[d]).sort().filter((k) => {
      const sp = k.split(" "); const m = sp[0]; const p = sp.slice(1).join(" ");
      if (f && !k.toLowerCase().includes(f)) return false;
      return libMatch(d, m, p, grouped[d][k]);
    });
    if (!eps.length) return;
    const cnt = eps.length;
    html += `<div class="lib-sec">
      <div class="lib-sec-head"><span class="ic">🌐</span> ${esc(d)} <span class="cnt">${cnt} 端点</span></div>`;
    eps.forEach((k) => {
      const arr = grouped[d][k];
      const sp = k.split(" ");
      const m = sp[0]; const p = sp.slice(1).join(" ");
      const first = arr[0];
      const ed = endpointDocCache[m + " " + p];
      // 接口文档缓存没标签时，用该端点下所有录制记录的 tags 做兜底（兼容旧数据）
      const reqTags = !ed || !ed.tags || !ed.tags.length
        ? Array.from(new Set(arr.flatMap((r) => r.tags || []))).sort()
        : [];
      const sum = (ed && ed.tags && ed.tags.length) ? ed.tags.join(" ") : reqTags.join(" ");
      html += `<div class="lib-ep-row" data-d="${esc(d)}" data-m="${esc(m)}" data-p="${esc(p)}">
        <span class="method-badge m-${m.toLowerCase()}">${m}</span>
        <span class="ep-path">${esc(p)}</span>
        ${sum ? `<span class="ep-sum">${esc(sum)}</span>` : ""}
        <span class="ep-cnt">${arr.length} 次</span>
        <span class="chev">›</span>
      </div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;
  pad.innerHTML = html;
  pad.querySelectorAll(".lib-ep-row").forEach((row) => row.addEventListener("click", () => {
    libState.view = "detail";
    libState.domain = row.getAttribute("data-d");
    libState.method = row.getAttribute("data-m");
    libState.path = row.getAttribute("data-p");
    renderLibrary();
  }));
}
const _libSearch = $("libOutlineSearch");
if (_libSearch) _libSearch.addEventListener("input", (e) => {
  libState.filter = e.target.value;
  libState.collapsed = {};
  if (libState.view === "detail") { libState.view = "list"; libState.domain = ""; libState.method = ""; libState.path = ""; }
  renderLibrary();
});
// 筛选条件：method chips + 仅错误（与文本搜索叠加）
const _libFilters = $("libFilters");
if (_libFilters) {
  _libFilters.querySelectorAll(".fchip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const m = chip.getAttribute("data-m");
      const t = chip.getAttribute("data-t");
      if (m) {
        if (libState.filters.methods.has(m)) { libState.filters.methods.delete(m); chip.classList.remove("active"); }
        else { libState.filters.methods.add(m); chip.classList.add("active"); }
      } else if (t === "err") {
        libState.filters.err = !libState.filters.err;
        chip.classList.toggle("active", libState.filters.err);
      } else if (t === "api") {
        libState.filters.apiOnly = !libState.filters.apiOnly;
        chip.classList.toggle("active", libState.filters.apiOnly);
      }
      libState.collapsed = {};
      if (libState.view === "detail") { libState.view = "list"; libState.domain = ""; libState.method = ""; libState.path = ""; }
      renderLibrary();
    });
  });
}
// 可拖拽分隔条：调节目录宽度（持久化到 localStorage）
(function () {
  const sp = $("libSplitter");
  if (!sp) return;
  let startX = 0, startW = 236;
  const onMove = (e) => {
    const w = Math.max(160, Math.min(560, startW + (e.clientX - startX)));
    document.documentElement.style.setProperty("--lib-outline-w", w + "px");
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = ""; document.body.style.userSelect = "";
    sp.classList.remove("dragging");
    try { localStorage.setItem("libOutlineW", document.documentElement.style.getPropertyValue("--lib-outline-w")); } catch (e) {}
  };
  sp.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lib-outline-w")) || 236;
    startW = cur;
    sp.classList.add("dragging");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
  });
  try { const w = localStorage.getItem("libOutlineW"); if (w) document.documentElement.style.setProperty("--lib-outline-w", w); } catch (e) {}
})();
function renderLibDetail(pad) {
  const grouped = groupLib();
  const arr = (grouped[libState.domain] || {})[libState.method + " " + libState.path] || [];
  const m = libState.method, p = libState.path;
  // 顶部区域：面包屑 + API 标题卡片
  const displayName = (window.__epDoc && window.__epDoc.name) || "";
  const titleText = displayName || p;
  let html = `<div class="breadcrumb"><a data-go="library">请求库</a> <span class="bc-sep">›</span> ${esc(libState.domain)} <span class="bc-sep">›</span> <span class="method-badge m-${m.toLowerCase()}">${m}</span> ${esc(p)}</div>`;
  html += `<div class="doc-head">
    <div class="doc-title-row">
      <span class="method-badge m-${m.toLowerCase()} doc-method">${m}</span>
      <h2 class="doc-title" id="epTitle">${esc(titleText)}</h2>
      <span class="doc-title-path" id="epTitlePath" style="${displayName ? "" : "display:none"}">${esc(p)}</span>
    </div>
    <div class="doc-meta"><span class="dot"></span> ${esc(libState.domain)} · ${arr.length} 次捕获</div>
  </div>`;
  // 案例表
  html += `<div class="card" style="margin-top:4px"><div class="card-title">案例情况</div>
    <table class="case-table"><thead><tr><th>#</th><th>时间</th><th>状态</th><th>大小</th><th>耗时</th><th>请求体</th></tr></thead><tbody>`;
  arr.slice().reverse().forEach((r, i) => {
    const resp = r.response || {};
    const t = r.time || r.timestamp || "";
    const st = resp.status || "";
    const ms = (resp && resp.time_ms != null) ? resp.time_ms : "";
    const sz = resp.size_bytes != null ? fmtSize(resp.size_bytes) : "—";
    const hasBody = (r.request && r.request.post_data) ? "有" : "—";
    html += `<tr class="case-row" data-seq="${r.seq}"><td>${arr.length - i}</td><td>${esc(String(t).slice(0, 19))}</td><td>${st}</td><td>${sz}</td><td>${ms}</td><td>${hasBody}</td></tr>
      <tr class="case-detail" id="cd-${r.seq}" style="display:none"><td colspan="6"></td></tr>`;
  });
  html += `</tbody></table></div>`;
  // 可编辑 API 信息：用户要求只保留 名称 / 标签 / 备注
  html += `<div class="card"><div class="card-title">API 信息（可编辑）</div>
    <div class="set-row"><span class="lbl">名称</span><input type="text" class="input ep-input" id="epName" placeholder="输入 API 名称"></div>
    <div class="set-row"><span class="lbl">标签</span><span id="epTags"></span> <span class="tag-add" id="epTagAdd">+ 标签</span></div>
    <div class="set-row"><span class="lbl">备注</span><input type="text" class="input ep-input" id="epNote" placeholder="输入接口备注"></div>
    <div class="set-row"><span class="lbl">保存</span><button class="btn btn-sm btn-primary" id="epSave">保存文档</button></div>
  </div>`;
  html += `<div class="card"><div class="card-title">请求参数</div><div id="epReqFields"></div><button class="btn btn-sm" id="epReqAdd">+ 添加字段</button></div>`;
  html += `<div class="card"><div class="card-title">响应字段</div><div id="epRespFields"></div><button class="btn btn-sm" id="epRespAdd">+ 添加字段</button></div>`;
  pad.innerHTML = html;
  // 案例展开：用录制界面同款 tab 视图（概览 / 请求头 / 请求体 / 响应头 / 响应体 / Query）
  pad.querySelectorAll(".case-row").forEach((row) => row.addEventListener("click", () => {
    const seq = row.getAttribute("data-seq");
    const det = $("cd-" + seq);
    if (!det) return;
    const td = det.querySelector("td");
    if (det.style.display === "none") {
      const r = allRequests.find((x) => String(x.seq) === seq);
      if (!r) { td.innerHTML = ""; det.style.display = ""; return; }
      const tabs = [
        { key: "overview", label: "概览" },
        { key: "request", label: "请求" },
        { key: "response", label: "响应" },
      ];
      let active = "overview";
      const render = () => {
        const tabBar = `<div class="detail-tabs" id="cdtabs-${seq}">${tabs.map((t) => tabBtn(t.key, t.label, active)).join("")}</div>`;
        const jumpBar =
          `<div class="cd-jump">` +
          `<button class="btn-mini" data-jump-seq="${r.seq}" title="跳到录制页定位这条">↗ 在录制中定位</button>` +
          `<button class="btn-mini" data-pin-seq="${r.seq}" title="把这条固定为 Mock 默认返回">📌 固定为 Mock 返回</button>` +
          `</div>`;
        const body = `<div class="detail-body" id="cdbody-${seq}">${renderTab(r, active)}</div>`;
        td.innerHTML = `<div class="case-detail-inner">${jumpBar}${tabBar}${body}</div>`;
        td.querySelectorAll(".tab").forEach((el) => el.addEventListener("click", () => {
          active = el.getAttribute("data-tab");
          render();
        }));
      };
      render();
      det.style.display = "";
    } else det.style.display = "none";
  }));
  // 加载文档
  loadEndpointDoc(m, p, arr);
  // 返回
  const bc = pad.querySelector('.breadcrumb a[data-go="library"]');
  if (bc) bc.addEventListener("click", (e) => { e.preventDefault(); libState.view = "list"; renderLibrary(); });
  // 标签新增
  const tagAdd = $("epTagAdd");
  if (tagAdd) tagAdd.addEventListener("click", () => {
    const v = prompt("输入标签："); if (!v) return;
    const chip = document.createElement("span");
    chip.className = "tag-chip"; chip.innerHTML = `${esc(v.trim())} <span class="x">×</span>`;
    chip.querySelector(".x").addEventListener("click", () => chip.remove());
    $("epTags").appendChild(chip);
  });
  // 字段增删（数据源挂 window.__epDoc，异步加载后会重渲染）
  window.__epDoc = { name: "", note: "", tags: [], req: [], resp: [] };
  const wireFields = (containerId, key) => {
    const c = $(containerId);
    if (!c) return;
    const renderF = () => {
      const store = (window.__epDoc && window.__epDoc[key]) || [];
      c.innerHTML = `<table class="field-table"><thead><tr><th>字段</th><th>类型</th><th>必填</th><th>说明</th><th></th></tr></thead><tbody id="${containerId}B"></tbody></table>`;
      const tb = $(containerId + "B");
      store.forEach((f, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td><input class="field-input" data-k="name" value="${esc(f.name || "")}" placeholder="字段名"></td>
          <td><input class="field-input" data-k="type" value="${esc(f.type || "")}" placeholder="string"></td>
          <td><input type="checkbox" data-k="required" ${f.required ? "checked" : ""}></td>
          <td><input class="field-input" data-k="desc" value="${esc(f.desc || "")}" placeholder="说明"></td>
          <td><button class="mini-btn" data-del="1">×</button></td>`;
        tr.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => {
          const k = inp.getAttribute("data-k");
          if (k === "required") f.required = inp.checked; else f[k] = inp.value;
        }));
        tr.querySelector("[data-del]").addEventListener("click", () => { store.splice(idx, 1); renderF(); });
        tb.appendChild(tr);
      });
    };
    renderF();
  };
  window.__libRerender = () => {
    wireFields("epReqFields", "req");
    wireFields("epRespFields", "resp");
  };
  wireFields("epReqFields", "req");
  wireFields("epRespFields", "resp");
  const ra = $("epReqAdd"); if (ra) ra.addEventListener("click", () => { window.__epDoc.req.push({ name: "", type: "", required: false, desc: "" }); window.__libRerender(); });
  const sa = $("epRespAdd"); if (sa) sa.addEventListener("click", () => { window.__epDoc.resp.push({ name: "", type: "", required: false, desc: "" }); window.__libRerender(); });
  // 保存
  const save = $("epSave");
  if (save) save.addEventListener("click", () => {
    const tags = Array.from($("epTags").querySelectorAll(".tag-chip")).map((c) => c.textContent.replace("×", "").trim()).filter(Boolean);
    const doc = {
      method: m, path: p,
      name: ($("epName") || {}).value || "",
      note: ($("epNote") || {}).value || "",
      tags, req: window.__epDoc.req, resp: window.__epDoc.resp,
    };
    postJSON("/api/endpoint/doc", doc).then((r) => {
      if (r.ok && r.data && r.data.ok) alert("已保存 API 文档");
      else alert("保存失败：" + ((r.data && r.data.error) || "未知错误"));
    }).catch((e) => alert("保存失败：" + e));
  });
}
// 从实际捕获样本推断接口文档字段（请求参数 / 响应字段）
function _tryParseJson(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }
function _typeOf(v) {
  if (v === null || v === undefined) return "string";
  const t = typeof v;
  if (t === "boolean") return "boolean";
  if (t === "number") return Number.isInteger(v) ? "integer" : "number";
  if (Array.isArray(v)) return "array";
  if (t === "object") return "object";
  return "string";
}
// 同一端点的多次捕获可能格式不一致（类型不同 / 字段时有时无 / JSON 与 form 混用）。
// 统计结构统一为 { samples: Set<样本下标>, values: [] }：出现率按「样本数」去重计算，
// 避免数组内多元素把出现次数放大；类型则收集全部取值类型，冲突时以 "|" 联合展示。
function _hit(out, key, si, value) {
  if (!key) return;
  if (!out[key]) out[key] = { samples: new Set(), values: [] };
  out[key].samples.add(si);
  if (value !== undefined) out[key].values.push(value);
}
function _collectQueryFields(samples, out) {
  samples.forEach((r, si) => {
    const q = (r.query || "").trim();
    if (!q) return;
    q.split("&").forEach((part) => {
      const i = part.indexOf("=");
      const k = i >= 0 ? decodeURIComponent(part.slice(0, i)) : decodeURIComponent(part);
      if (!k) return;
      _hit(out, k, si, i >= 0 ? decodeURIComponent(part.slice(i + 1)) : "");
    });
  });
}
// 递归 flatten JSON：对象用 "." 连接，数组用 "[*]" 表示元素，把所有层级字段都展开
function _walkJson(value, prefix, out, depth, si) {
  if (depth > 6) return;
  if (value === null || value === undefined) return;
  const key = prefix || "";
  if (Array.isArray(value)) {
    _hit(out, key, si, value);
    value.forEach((item) => _walkJson(item, key ? key + "[*]" : "[*]", out, depth + 1, si));
  } else if (typeof value === "object") {
    _hit(out, key, si, value);
    Object.keys(value).forEach((k) => {
      const childKey = key ? key + "." + k : k;
      _walkJson(value[k], childKey, out, depth + 1, si);
    });
  } else {
    _hit(out, key, si, value);
  }
}
function _collectBodyFields(samples, out) {
  samples.forEach((r, si) => {
    const body = r.request && r.request.post_data;
    if (body == null || body === "") return;
    // JSON body：递归展开所有层级
    const json = _tryParseJson(body);
    if (json !== undefined) {
      _walkJson(json, "", out, 0, si);
      return;
    }
    // form body（仍只取一层 key）
    const ct = (r.request && r.request.headers && r.request.headers["Content-Type"]) || "";
    if (ct.indexOf("application/x-www-form-urlencoded") >= 0 || body.indexOf("=") >= 0) {
      body.split("&").forEach((part) => {
        const i = part.indexOf("=");
        const k = i >= 0 ? decodeURIComponent(part.slice(0, i)) : decodeURIComponent(part);
        if (!k) return;
        _hit(out, k, si, undefined);
      });
    }
  });
}
function _collectRespFields(samples, out) {
  samples.forEach((r, si) => {
    const body = r.response && r.response.body;
    if (body == null || body === "") return;
    const json = _tryParseJson(body);
    if (json !== undefined) {
      _walkJson(json, "", out, 0, si);
    }
  });
}
function _fieldsFromStats(stats, total) {
  return Object.keys(stats).sort().map((k) => {
    const s = stats[k];
    const hit = s.samples.size;
    // 类型冲突（同一字段在不同样本里类型不同）→ 用 "|" 列出全部出现过的类型
    const types = new Set();
    (s.values || []).forEach((x) => { if (x !== null && x !== undefined) types.add(_typeOf(x)); });
    const type = types.size ? Array.from(types).sort().join("|") : "string";
    // 字段时有时无 → 在说明里标注出现率，提醒这不是稳定字段
    const desc = (total > 0 && hit < total) ? `出现 ${hit}/${total} 次` : "";
    return { name: k, type, required: total > 0 && hit >= total, desc };
  });
}
function inferEndpointDoc(method, path, samples) {
  const matched = (samples || []).filter((r) =>
    (r.method || "GET").toUpperCase() === (method || "GET").toUpperCase() &&
    (r.path || "") === (path || ""));
  const total = matched.length;
  const reqStats = {};
  _collectQueryFields(matched, reqStats);
  _collectBodyFields(matched, reqStats);
  const respStats = {};
  _collectRespFields(matched, respStats);
  return {
    name: "", note: "", tags: [],
    req: _fieldsFromStats(reqStats, total),
    resp: _fieldsFromStats(respStats, total),
  };
}
function loadEndpointDoc(method, path, samples) {
  const inferred = inferEndpointDoc(method, path, samples);
  // 兜底：该端点下录制记录里的 tags/note（兼容旧数据，统一模型前标签存在 requests 表）
  const recTags = Array.from(new Set((samples || []).flatMap((r) => r.tags || []))).sort();
  const recNote = (samples || []).map((r) => r.note).filter(Boolean)[0] || "";
  const applyDoc = (d) => {
    const tags = (d.tags && d.tags.length) ? d.tags : recTags;
    const note = d.note || recNote;
    window.__epDoc = {
      name: d.name || "",
      note,
      tags,
      req: (d.req && d.req.length) ? d.req : inferred.req,
      resp: (d.resp && d.resp.length) ? d.resp : inferred.resp,
    };
    const nm = $("epName"); if (nm) nm.value = window.__epDoc.name;
    const n = $("epNote"); if (n) n.value = window.__epDoc.note;
    const title = $("epTitle");
    const titlePath = $("epTitlePath");
    if (title) title.textContent = window.__epDoc.name || path;
    if (titlePath) titlePath.style.display = window.__epDoc.name ? "" : "none";
    const tc = $("epTags");
    if (tc) {
      tc.innerHTML = "";
      (window.__epDoc.tags || []).forEach((t) => {
        const chip = document.createElement("span");
        chip.className = "tag-chip"; chip.innerHTML = `${esc(t)} <span class="x">×</span>`;
        chip.querySelector(".x").addEventListener("click", () => chip.remove());
        tc.appendChild(chip);
      });
    }
    if (window.__libRerender) window.__libRerender();
  };
  postJSON("/api/endpoint/doc", { method, path }).then((r) => {
    if (r.ok && r.data && r.data.ok) applyDoc(r.data.doc || {});
    else applyDoc(inferred);
  }).catch(() => applyDoc(inferred));
}

// ---------------- 导出（独立大功能）----------------
const exportState = { fmt: "json", scope: "all", scopeValue: "", sel: new Set(), previewOpen: false };
const FMTS = [
  { id: "har", ic: "🗂️", t: "HAR", d: "完整抓包归档，含请求头/体/响应，Charles、Fiddler 可直接打开" },
  { id: "json", ic: "🧾", t: "JSON", d: "结构化接口清单，含字段定义与案例摘要，便于二次处理" },
  { id: "mock", ic: "🧪", t: "Mock 脚本", d: "基于录制库生成进程内 Mock 服务源码（Flask），开箱即用" },
  { id: "openapi", ic: "📘", t: "OpenAPI 3", d: "生成 OpenAPI 3（JSON），可直接导入 Swagger / Apifox" },
];
function exportStats(seqs) {
  const list = seqs == null ? allRequests : allRequests.filter((r) => seqs.includes(r.seq));
  return { e: list.length, c: list.reduce((s, r) => s + 1, 0) };
}
function exportScopeSeqs() {
  const s = exportState.scope;
  if (s === "all") return null;
  if (s === "domain") return allRequests.filter((r) => (r.registered_domain || r.host) === exportState.scopeValue).map((r) => r.seq);
  if (s === "tag") return allRequests.filter((r) => (r.tags || []).includes(exportState.scopeValue)).map((r) => r.seq);
  if (s === "manual") return Array.from(exportState.sel);
  return null;
}
function renderExport() {
  const pad = $("exportPad");
  if (!pad) return;
  const domains = Array.from(new Set(allRequests.map((r) => r.registered_domain || r.host || "(未知)"))).sort();
  const tags = Array.from(new Set(allRequests.flatMap((r) => r.tags || []))).sort();
  const seqs = exportScopeSeqs();
  const st = exportStats(seqs);
  let cond = "";
  if (exportState.scope === "domain") cond = `<select class="exp-select" id="expDomain">${domains.map((d) => `<option ${d === exportState.scopeValue ? "selected" : ""}>${esc(d)}</option>`).join("")}</select>`;
  else if (exportState.scope === "tag") cond = `<select class="exp-select" id="expTag">${tags.map((t) => `<option ${t === exportState.scopeValue ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  else if (exportState.scope === "manual") {
    cond = `<div class="chk-list">${allRequests.map((r) => {
      const k = (r.method || "GET").toUpperCase() + " " + (r.path || r.url || "");
      return `<label class="chk-item"><input type="checkbox" data-seq="${r.seq}" ${exportState.sel.has(r.seq) ? "checked" : ""}><span class="cp">${esc(k)}</span></label>`;
    }).join("")}</div>`;
  }
  pad.innerHTML = `
    <div class="exp-wrap">
      <div class="exp-head">
        <div><div class="top-title">导出</div></div>
        <div class="exp-stats">
          <div class="exp-stat"><span class="n">${st.e}</span><span class="l">接口/请求</span></div>
          <div class="exp-stat"><span class="n">${st.c}</span><span class="l">捕获案例</span></div>
          <div class="exp-stat"><span class="n">${FMTS.find((f) => f.id === exportState.fmt).t}</span><span class="l">当前格式</span></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">导出格式</div>
        <div class="fmt-grid">${FMTS.map((f) => `<div class="fmt-card ${f.id === exportState.fmt ? "sel" : ""}" data-fmt="${f.id}"><div class="fmt-ic">${f.ic}</div><div class="fmt-t">${f.t}</div><div class="fmt-d">${esc(f.d)}</div></div>`).join("")}</div>
      </div>
      <div class="card">
        <div class="card-title">导出范围</div>
        <div class="seg" id="expScope">
          <button class="seg-btn ${exportState.scope === "all" ? "on" : ""}" data-s="all">全部录制</button>
          <button class="seg-btn ${exportState.scope === "domain" ? "on" : ""}" data-s="domain">按归属</button>
          <button class="seg-btn ${exportState.scope === "tag" ? "on" : ""}" data-s="tag">按标签</button>
          <button class="seg-btn ${exportState.scope === "manual" ? "on" : ""}" data-s="manual">手动勾选</button>
        </div>
        <div class="exp-cond" id="expCond" style="margin-top:12px">${cond}</div>
      </div>
      <div class="card">
        <div class="card-title">脱敏（导出时生效）</div>
        <label class="check"><input type="checkbox" id="desensitize" ${desensitizeEl && desensitizeEl.checked ? "checked" : ""}/> 脱敏导出</label>
        <div class="mask-map" style="margin-top:8px">
          <div class="mask-row">中文 → <input id="maskCjk" class="input input-sm" maxlength="8" value="${maskCjkEl ? esc(maskCjkEl.value) : "测"}" /></div>
          <div class="mask-row">数字 → <input id="maskDigit" class="input input-sm" maxlength="8" value="${maskDigitEl ? esc(maskDigitEl.value) : "1"}" /></div>
          <div class="mask-row">英文 → <input id="maskAlpha" class="input input-sm" maxlength="8" value="${maskAlphaEl ? esc(maskAlphaEl.value) : "a"}" /></div>
        </div>
        <div class="set-hint">留空 = 不脱敏该类；可填多个字符。默认 测 / 1 / a。</div>
      </div>
      <div class="exp-bar">
        <span class="est">预计导出 <b>${st.e}</b> 接口 / <b>${st.c}</b> 案例 · ${FMTS.find((f) => f.id === exportState.fmt).t}${(desensitizeEl && desensitizeEl.checked) ? " · 已脱敏" : ""}</span>
        <div class="spacer"></div>
        <button class="btn" id="expPreview">预览</button>
        <button class="btn btn-primary" id="expDo">导出到下载文件夹</button>
      </div>
    </div>
    <div class="modal-mask hide" id="expPreviewModal">
      <div class="modal modal-lg">
        <div class="modal-head"><span class="modal-title">导出预览 · ${FMTS.find((f) => f.id === exportState.fmt).t}</span><button class="modal-close" id="expPreviewClose">×</button></div>
        <div class="modal-body"><pre id="expPreviewBody" class="code" style="max-height:60vh;overflow:auto"></pre></div>
      </div>
    </div>`;
  // 格式选择
  pad.querySelectorAll(".fmt-card").forEach((c) => c.addEventListener("click", () => { exportState.fmt = c.getAttribute("data-fmt"); renderExport(); }));
  // 范围切换
  pad.querySelectorAll("#expScope .seg-btn").forEach((b) => b.addEventListener("click", () => { exportState.scope = b.getAttribute("data-s"); if (exportState.scope === "domain" && !exportState.scopeValue) exportState.scopeValue = domains[0] || ""; if (exportState.scope === "tag" && !exportState.scopeValue) exportState.scopeValue = tags[0] || ""; if (exportState.scope === "manual") allRequests.forEach((r) => exportState.sel.add(r.seq)); renderExport(); }));
  const expDomain = $("expDomain"); if (expDomain) expDomain.addEventListener("change", () => { exportState.scopeValue = expDomain.value; renderExport(); });
  const expTag = $("expTag"); if (expTag) expTag.addEventListener("change", () => { exportState.scopeValue = expTag.value; renderExport(); });
  pad.querySelectorAll(".chk-item input").forEach((cb) => cb.addEventListener("change", () => { const s = Number(cb.getAttribute("data-seq")); if (cb.checked) exportState.sel.add(s); else exportState.sel.delete(s); const ns = exportStats(exportScopeSeqs()); const est = pad.querySelector(".est"); if (est) est.innerHTML = `预计导出 <b>${ns.e}</b> 接口 / <b>${ns.c}</b> 案例 · ${FMTS.find((f) => f.id === exportState.fmt).t}`; }));
  // 脱敏
  const de = $("desensitize"); if (de) de.addEventListener("change", () => { if (desensitizeEl) desensitizeEl.checked = de.checked; renderExport(); });
  const mc = $("maskCjk"); if (mc) mc.addEventListener("input", () => { if (maskCjkEl) maskCjkEl.value = mc.value; persistMaskCfg(); });
  const md = $("maskDigit"); if (md) md.addEventListener("input", () => { if (maskDigitEl) maskDigitEl.value = md.value; persistMaskCfg(); });
  const ma = $("maskAlpha"); if (ma) ma.addEventListener("input", () => { if (maskAlphaEl) maskAlphaEl.value = ma.value; persistMaskCfg(); });
  // 预览 / 导出
  const pv = $("expPreview"); if (pv) pv.addEventListener("click", showExportPreview);
  const ed = $("expDo"); if (ed) ed.addEventListener("click", doExport);
  const pvc = $("expPreviewClose"); if (pvc) pvc.addEventListener("click", () => $("expPreviewModal").classList.add("hide"));
}
function showExportPreview() {
  const modal = $("expPreviewModal"); if (!modal) return;
  const body = $("expPreviewBody"); if (!body) return;
  const seqs = exportScopeSeqs();
  const list = seqs == null ? allRequests : allRequests.filter((r) => seqs.includes(r.seq));
  const fmt = exportState.fmt;
  let txt = "";
  if (fmt === "openapi") {
    const paths = {};
    list.forEach((r) => { const p = r.path || r.url || ""; const m = (r.method || "GET").toUpperCase(); (paths[p] = paths[p] || new Set()).add(m); });
    txt = `openapi: 3.0.3\ninfo:\n  title: API Recorder 导出\npaths: ${Object.keys(paths).length}\n` +
      Object.keys(paths).map((p) => `  ${p}: ${Array.from(paths[p]).join(", ")}`).join("\n");
  } else if (fmt === "mock") {
    const eps = {};
    list.forEach((r) => { const k = (r.method || "GET").toUpperCase() + " " + (r.path || r.url || ""); eps[k] = (eps[k] || 0) + 1; });
    txt = `Mock 接口数：${Object.keys(eps).length}\n` + Object.keys(eps).map((k) => `  ${k}  (${eps[k]} 次捕获)`).join("\n");
  } else {
    txt = `{ "requests": ${list.length}, "endpoints": ${new Set(list.map((r) => (r.method || "GET").toUpperCase() + " " + (r.path || r.url || ""))).size } }\n# 字段定义与案例摘要将随录制库导出`;
  }
  body.textContent = txt;
  modal.classList.remove("hide");
}
function doExport() {
  const fmt = exportState.fmt;
  const seqs = exportScopeSeqs();
  const body = { format: fmt, seqs: seqs || [] };
  if (desensitizeEl && desensitizeEl.checked) {
    body.desensitize = 1;
    if (maskCjkEl && maskCjkEl.value.trim()) body.cjk = maskCjkEl.value.trim();
    if (maskDigitEl && maskDigitEl.value.trim()) body.digit = maskDigitEl.value.trim();
    if (maskAlphaEl && maskAlphaEl.value.trim()) body.alpha = maskAlphaEl.value.trim();
  }
  const url = fmt === "mock" ? "/api/export_mock/save" : "/api/export/save";
  const btn = $("expDo"); if (btn) { btn.disabled = true; btn.textContent = "导出中…"; }
  postJSON(url, body).then((r) => {
    if (r.ok && r.data && r.data.ok) showExportToast(r.data.path);
    else alert("导出失败：" + ((r.data && r.data.error) || "未知错误"));
  }).catch((e) => alert("导出失败：" + e))
    .finally(() => { if (btn) { btn.disabled = false; btn.textContent = "导出到下载文件夹"; } });
}

// ---------------- 设置 ----------------
function renderSettings() {
  const pad = $("settingsPad");
  if (!pad) return;
  pad.innerHTML = `
    <div class="set-wrap">
      <div class="set-card">
        <div class="card-title">端口</div>
        <div class="set-row"><span class="lbl">服务端口</span><input id="portInput" class="input input-sm" maxlength="6" placeholder="自动" /></div>
        <div class="set-row"><span class="lbl">Mock 端口</span><input id="mockPortInput" class="input input-sm" maxlength="6" placeholder="自动" /></div>
        <div class="set-hint" id="portHint">服务端口修改需重启本程序生效；Mock 端口下次启动 Mock 时生效（运行中可在 Mock 面板输入框临时指定端口，无需重启）。</div>
        <div style="margin-top:10px"><button class="btn btn-primary" id="maskSave">保存</button></div>
      </div>
      <div class="set-card">
        <div class="card-title">脱敏映射（默认值，导出时引用）</div>
        <div class="mask-map">
          <div class="mask-row">中文 → <input id="setMaskCjk" class="input input-sm" maxlength="8" value="${maskCjkEl ? esc(maskCjkEl.value) : "测"}" /></div>
          <div class="mask-row">数字 → <input id="setMaskDigit" class="input input-sm" maxlength="8" value="${maskDigitEl ? esc(maskDigitEl.value) : "1"}" /></div>
          <div class="mask-row">英文 → <input id="setMaskAlpha" class="input input-sm" maxlength="8" value="${maskAlphaEl ? esc(maskAlphaEl.value) : "a"}" /></div>
        </div>
        <div class="set-hint">在「导出」页的脱敏开关开启时生效；此处为默认映射，修改即时保存。</div>
      </div>
    </div>`;
  const sc = $("setMaskCjk"); if (sc) sc.addEventListener("input", () => { if (maskCjkEl) maskCjkEl.value = sc.value; persistMaskCfg(); });
  const sd = $("setMaskDigit"); if (sd) sd.addEventListener("input", () => { if (maskDigitEl) maskDigitEl.value = sd.value; persistMaskCfg(); });
  const sa = $("setMaskAlpha"); if (sa) sa.addEventListener("input", () => { if (maskAlphaEl) maskAlphaEl.value = sa.value; persistMaskCfg(); });
  const ms = $("maskSave"); if (ms) ms.addEventListener("click", savePortCfg);
  // 回填已保存端口
  fetch("/api/config").then((r) => r.json()).then((d) => {
    const pi = $("portInput"); if (pi && d && d.saved_port) pi.value = d.saved_port;
    const mi = $("mockPortInput"); if (mi && d && d.mock_port) mi.value = d.mock_port;
    const ph = $("portHint"); if (ph && d && d.running_port) ph.textContent = "当前运行端口：" + d.running_port + "；修改后需重启本程序生效。留空 = 自动选择。";
  }).catch(() => {});
}

// ---------------- 命令面板（Ctrl K）----------------
const COMMANDS = [
  { g: "导航", i: "🏠", t: "概览", act: () => go("overview") },
  { g: "导航", i: "📡", t: "录制", act: () => go("recording") },
  { g: "导航", i: "🧪", t: "Mock 服务", act: () => go("mock") },
  { g: "导航", i: "📚", t: "请求库", act: () => go("library") },
  { g: "导航", i: "📤", t: "导出", act: () => go("export") },
  { g: "导航", i: "⚙", t: "设置", act: () => go("settings") },
  { g: "操作", i: "●", t: "开始录制", act: () => { go("recording"); if (!recordingActive) startBtn.click(); } },
  { g: "操作", i: "■", t: "停止录制", act: () => { if (recordingActive) stopBtn.click(); } },
  { g: "操作", i: "▶", t: "启动 Mock", act: () => { go("mock"); if (!mockRunning) startMockBtn.click(); } },
  { g: "操作", i: "■", t: "停止 Mock", act: () => { if (mockRunning) stopMockBtn.click(); } },
  { g: "操作", i: "📤", t: "导出到文件", act: () => go("export") },
  { g: "操作", i: "🗑", t: "清空录制", act: () => clearBtn.click() },
];
let _cmdkItems = [];
function openCommandPalette() { const c = $("cmdk"); if (c) { c.classList.add("open"); const i = $("cmdkInput"); if (i) { i.value = ""; i.focus(); } renderCommandPalette(""); } }
function closeCommandPalette() { const c = $("cmdk"); if (c) c.classList.remove("open"); }
function renderCommandPalette(q) {
  const list = $("cmdkList"); if (!list) return;
  q = (q || "").trim().toLowerCase();
  _cmdkItems = COMMANDS.filter((c) => !q || c.t.toLowerCase().includes(q) || (c.g || "").toLowerCase().includes(q));
  if (!_cmdkItems.length) { list.innerHTML = `<div class="cmdk-empty">无匹配命令</div>`; return; }
  const groups = {};
  _cmdkItems.forEach((c, idx) => { (groups[c.g] = groups[c.g] || []).push({ c, idx }); });
  let html = "";
  Object.keys(groups).forEach((g) => {
    html += `<div class="cmdk-group">${g}</div>`;
    groups[g].forEach(({ c, idx }) => {
      html += `<div class="cmdk-item ${idx === 0 ? "active" : ""}" data-idx="${idx}"><span class="ci-ic">${c.i}</span><span class="ci-t">${esc(c.t)}</span></div>`;
    });
  });
  list.innerHTML = html;
  list.querySelectorAll(".cmdk-item").forEach((el) => el.addEventListener("click", () => { const idx = Number(el.getAttribute("data-idx")); runCommand(idx); }));
}
function runCommand(idx) {
  const c = _cmdkItems[idx]; if (!c) return;
  closeCommandPalette(); c.act();
}
const cmdkTrigger = $("cmdkTrigger");
if (cmdkTrigger) cmdkTrigger.addEventListener("click", openCommandPalette);
const cmdkInput = $("cmdkInput");
if (cmdkInput) cmdkInput.addEventListener("input", () => renderCommandPalette(cmdkInput.value));
const cmdkEl = $("cmdk");
if (cmdkEl) cmdkEl.addEventListener("click", (e) => { if (e.target === cmdkEl) closeCommandPalette(); });
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); cmdkEl && cmdkEl.classList.contains("open") ? closeCommandPalette() : openCommandPalette(); return; }
  if (!cmdkEl || !cmdkEl.classList.contains("open")) return;
  if (e.key === "Escape") { closeCommandPalette(); return; }
  if (e.key === "ArrowDown") { e.preventDefault(); moveCmdk(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveCmdk(-1); }
  else if (e.key === "Enter") { e.preventDefault(); const a = cmdkEl.querySelector(".cmdk-item.active"); if (a) runCommand(Number(a.getAttribute("data-idx"))); }
});
function moveCmdk(dir) {
  if (!_cmdkItems.length) return;
  let cur = _cmdkItems.findIndex((_, i) => { const el = document.querySelector(`.cmdk-item[data-idx="${i}"]`); return el && el.classList.contains("active"); });
  if (cur < 0) cur = 0; else cur = (cur + dir + _cmdkItems.length) % _cmdkItems.length;
  document.querySelectorAll(".cmdk-item").forEach((el) => el.classList.remove("active"));
  const el = document.querySelector(`.cmdk-item[data-idx="${cur}"]`);
  if (el) { el.classList.add("active"); el.scrollIntoView({ block: "nearest" }); }
}

// ---------------- 初始化 ----------------
renderOverview();
renderLibrary();
renderSettings();
renderExport();
// 延迟渲染屏（导出 / 设置）中的元素在加载时为 null，此处统一重新查询并补绑定
desensitizeEl = $("desensitize");
maskCjkEl = $("maskCjk"); maskDigitEl = $("maskDigit"); maskAlphaEl = $("maskAlpha");
portInputEl = $("portInput"); mockPortInputEl = $("mockPortInput"); portHintEl = $("portHint");
loadMaskCfg();
[maskCjkEl, maskDigitEl, maskAlphaEl].forEach((el) => { if (el) el.addEventListener("input", persistMaskCfg); });
renderExport(); // 重新渲染以反映已加载的脱敏默认值
// 读取已保存端口（若有）回填到输入框，并显示当前运行端口
fetch("/api/config").then((r) => r.json()).then((d) => {
  if (d && d.saved_port && portInputEl) portInputEl.value = d.saved_port;
  if (d && d.mock_port && mockPortInputEl) mockPortInputEl.value = d.mock_port;
  if (d && d.mock_port && mockPortInput2El) mockPortInput2El.value = d.mock_port;
  if (d && d.running_port && portHintEl) portHintEl.textContent = "当前运行端口：" + d.running_port + "；修改后需重启本程序生效。留空 = 自动选择。";
}).catch(() => {});
updateNavBadges();
connect();
