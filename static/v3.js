// -*- coding: utf-8 -*-
// v3：接口为中心的减法外壳 + 组件层。单一定义套用到每个接口，一致性来自复用。
"use strict";

let _endpoints = [];
let _activeEp = null;
let _activeSample = null;
let _workTab = "samples";
let _inbox = [];
let _docDraft = null;
let _railApiOnly = true;
let _railErrors = false;

const _up = (m) => String(m || "GET").toUpperCase();
const _mlist = () => window.__mockApis || [];
const _loglist = () => (typeof mockLogs !== "undefined" && mockLogs) || [];

function _isMiss(l) {
  const st = Number(l && l.status);
  return st === 404 || (!!(l && l.miss_reason));
}

function _recomputeInbox() {
  const seen = new Set();
  _inbox = [];
  const k0 = (m, p, q) => _up(m) + " " + (p || "") + "?" + (q || "");
  const add = (l) => {
    const k = k0(l.method, l.path, l.query);
    if (seen.has(k)) return;
    seen.add(k);
    _inbox.push(l);
  };
  // 1) Mock 运行时的实时未命中
  _loglist().forEach((l) => {
    if (!_isMiss(l)) return;
    add({ method: l.method, path: l.path, query: l.query, miss_reason: l.miss_reason || "未命中（404）", _src: "miss" });
  });
  // 2) 已录制但返回 4xx/5xx、且还没造数据的请求（让「待造数据」在没开 Mock 时也能用）
  const mocked = new Set();
  const wholeIf = new Set();
  _mlist().forEach((a) => {
    mocked.add(k0(a.method, a.path, a.query));
    if (!a.query) wholeIf.add(k0(a.method, a.path, ""));
  });
  allRequests.forEach((r) => {
    const st = Number(r.response && r.response.status);
    const err = r.is_failed || (st >= 400 && st !== 0);
    if (!err) return;
    const p = r.path || r.url || "/";
    const q = r.query || "";
    if (mocked.has(k0(r.method, p, q)) || wholeIf.has(k0(r.method, p, ""))) return;
    add({
      method: r.method, path: p, query: q, status: st,
      miss_reason: r.is_failed ? "请求失败（可造数据）" : ("响应 " + st + "（可造数据）"),
      _src: "recorded",
    });
  });
}

function _epSamples(ep) {
  return allRequests.filter((r) => _up(r.method) === ep.method && (r.path || r.url || "/") === ep.path);
}

function _mockFor(ep) {
  return _mlist().filter((a) => _up(a.method) === ep.method && a.path === ep.path);
}

function _missFor(ep) {
  return _inbox.filter((x) => _up(x.method) === ep.method && (x.path || "") === ep.path);
}

// ==================== 组件层 ====================

function MethodBadge(m) {
  const mm = _up(m);
  return `<span class="method-badge m-${mm.toLowerCase()}">${esc(mm)}</span>`;
}

function EndpointRow(ep) {
  const mock = _mockFor(ep).length;
  const pinned = _mockFor(ep).filter((a) => a.mock_pin).length;
  const miss = _missFor(ep).length;
  const active = _activeEp && _activeEp.method === ep.method && _activeEp.path === ep.path;
  return `<div class="ep-row${active ? " active" : ""}" data-m="${esc(ep.method)}" data-p="${esc(ep.path)}">
    ${MethodBadge(ep.method)}
    <div class="ep-main">
      <div class="ep-path" title="${esc(ep.path)}">${esc(ep.path)}</div>
      <div class="ep-meta">
        <span class="ep-n">样本 ${ep.samples.length}</span>
        ${mock ? `<span class="ep-mock">Mock ${mock}</span>` : ""}
        ${pinned ? `<span class="ep-pin">默认 ${pinned}</span>` : ""}
        ${miss ? `<span class="ep-miss">未命中 ${miss}</span>` : ""}
      </div>
    </div>
  </div>`;
}

function SampleRow(r) {
  const sc = statusClass(r);
  const statusTxt = r.is_failed ? "FAIL" : (r.response && r.response.status != null ? r.response.status : "—");
  const url = (r.path || "/") + (r.query ? "?" + r.query : "");
  const pinned = _mlist().some((a) => a.seq === r.seq && a.mock_pin);
  return `<div class="sample-row${_activeSample === r.seq ? " active" : ""}" data-seq="${r.seq}">
    <span class="s ${sc}">${esc(String(statusTxt))}</span>
    <span class="t-type">${esc(r.resource_type || "")}</span>
    <span class="sample-url" title="${esc(r.url || "")}">${hl(url)}</span>
    ${pinned ? `<span class="ep-pin">默认</span>` : ""}
  </div>`;
}

function FieldTable(fields, title, matchFields) {
  if (!fields || !fields.length) return `<div class="empty">未从样本推断出字段（可能无 query / 请求体 / 结构化响应）。</div>`;
  const mf = matchFields || [];
  return `<div class="field-block">
    <div class="panel-head">${esc(title)} <span class="muted">${fields.length}</span></div>
    <table class="field-table"><thead><tr><th>字段</th><th>类型</th><th>必填</th><th>说明</th><th class="col-match">匹配</th></tr></thead>
    <tbody>${fields.map((f) => {
      const on = mf.indexOf(f.name) >= 0;
      return `<tr><td class="fname">${esc(f.name)}</td><td>${esc(f.type || "")}</td><td>${f.required ? "是" : "—"}</td><td class="fmuted">${esc(f.desc || "")}</td><td class="col-match"><button class="match-toggle ${on ? "on" : ""}" data-fname="${esc(f.name)}" title="标记为 Mock 精确匹配键：真实请求传该字段就按它路由到对应 Mock，没匹配到返回 404">${on ? "🔑 已设" : "＋ 设匹配"}</button></td></tr>`;
    }).join("")}</tbody></table>
  </div>`;
}

// ==================== 顶栏药丸 ====================

function _setRecChip() {
  const chip = $("recChip"); const txt = $("recChipTxt");
  if (!chip) return;
  chip.classList.toggle("on", !!recordingActive);
  if (txt) txt.textContent = recordingActive ? "录制中" : "录制";
}

function _setMockChip() {
  const chip = $("mockChip"); const txt = $("mockChipTxt");
  if (!chip) return;
  chip.classList.toggle("on", !!mockRunning);
  if (txt) txt.textContent = mockRunning ? ("Mock " + (mockUrl ? mockUrl.replace(/^https?:\/\//, "") : "运行中")) : "Mock";
}

function _setInboxChip() {
  _recomputeInbox();
  const n = _inbox.length;
  const chip = $("inboxChip"); const t = $("inboxChipTxt");
  const mini = $("inboxMini"); const mn = $("inboxMiniN");
  if (chip) chip.classList.toggle("hide", n === 0);
  if (t) t.textContent = "待造 " + n;
  if (mini) mini.classList.toggle("hide", n === 0);
  if (mn) mn.textContent = String(n);
}

function renderHead() {
  _setRecChip();
  _setMockChip();
  _setInboxChip();
}

function updateViewTitle() {
  const el = $("viewTitle");
  if (!el) return;
  el.textContent = _activeEp ? (_activeEp.method + " " + _activeEp.path) : "接口台账";
}

// ==================== 左栏接口台账 ====================

function groupEndpoints(arr) {
  const map = new Map();
  (arr || allRequests).forEach((r) => {
    const method = _up(r.method);
    const path = r.path || r.url || "/";
    const key = method + " " + path;
    if (!map.has(key)) map.set(key, { method, path, samples: [] });
    map.get(key).samples.push(r);
  });
  return Array.from(map.values());
}

function renderList() {
  _recomputeInbox();
  const el = $("epList");
  if (!el) return;
  const q = (($("listSearch") && $("listSearch").value) || "").trim().toLowerCase();
  let arr = allRequests;
  if (_railApiOnly) arr = arr.filter((r) => ["XHR", "FETCH"].includes(_up(r.resource_type)));
  if (_railErrors) arr = arr.filter((r) => r.is_failed || (r.response && r.response.status >= 400));
  let eps = groupEndpoints(arr);
  if (q) eps = eps.filter((e) => (e.method + " " + e.path).toLowerCase().indexOf(q) !== -1);
  _endpoints = eps;
  const clear = $("listSearchClear");
  if (clear) clear.classList.toggle("hide", !q);
  if (!eps.length) {
    el.innerHTML = allRequests.length
      ? `<div class="empty">无匹配接口（可关闭「仅 API / 仅错误」或调整搜索）。</div>`
      : `<div class="empty">尚无接口。点顶栏「录制」拉起浏览器，或从 ⋯ 菜单导入 HAR，这里会按 method+path 汇总成接口台账。</div>`;
    return;
  }
  el.innerHTML = eps.map(EndpointRow).join("");
  el.querySelectorAll(".ep-row").forEach((row) => {
    row.addEventListener("click", () => showEndpoint(row.getAttribute("data-m"), row.getAttribute("data-p")));
  });
}

// ==================== 仪表盘（未选接口） ====================

function renderDash() {
  if (typeof render === "function") render();
}

function showDash(opts) {
  _activeEp = null;
  _activeSample = null;
  const list = $("ledgerList"); const work = $("workView");
  if (list) list.classList.remove("hide");
  if (work) { work.classList.add("hide"); work.innerHTML = ""; }
  renderList();
  renderDash();
  updateViewTitle();
  if (opts && opts.focusSeq) openDetail(opts.focusSeq);
}

// ==================== 工作台（选中接口） ====================

const WORK_TABS = [["samples", "样本"], ["fields", "字段"], ["doc", "文档"]];

function showEndpoint(method, path) {
  method = _up(method);
  _activeEp = { method, path };
  _activeSample = null;
  _workTab = "samples";
  const list = $("ledgerList"); const work = $("workView");
  if (list) list.classList.add("hide");
  if (work) work.classList.remove("hide");
  renderWork();
  renderList();
  updateViewTitle();
}

function _tabBtn(key, label, active) {
  return `<button class="work-tab${active ? " active" : ""}" data-wtab="${key}">${esc(label)}</button>`;
}

function renderWork() {
  if (!_activeEp) return;
  const work = $("workView");
  if (!work) return;
  const ep = _activeEp;
  const samples = _epSamples(ep);
  const mockCount = _mockFor(ep).length;
  work.innerHTML = `
    <div class="work-head">
      ${MethodBadge(ep.method)}
      <span class="work-path" title="${esc(ep.path)}">${esc(ep.path)}</span>
      <span class="work-counts">样本 ${samples.length}${mockCount ? " · Mock " + mockCount : ""}</span>
      <div class="spacer"></div>
      <button class="btn btn-sm" id="workExportBtn">导出此接口</button>
      <button class="btn btn-sm" id="workMakeBtn">➕ 造数据</button>
      <button class="btn btn-sm" id="workCloseBtn">返回总览</button>
    </div>
    <div class="work-tabs">${WORK_TABS.map(([k, l]) => _tabBtn(k, l, _workTab === k)).join("")}</div>
    <div class="work-body" id="workBody"></div>`;
  const close = $("workCloseBtn"); if (close) close.addEventListener("click", () => showDash());
  const exp = $("workExportBtn"); if (exp) exp.addEventListener("click", () => openExportDrawerForEp(ep));
  const mk = $("workMakeBtn"); if (mk) mk.addEventListener("click", () => openMake({ method: ep.method, path: ep.path }));
  work.querySelectorAll(".work-tab").forEach((b) => b.addEventListener("click", () => { _workTab = b.getAttribute("data-wtab"); renderWork(); }));
  renderWorkBody();
}

function renderWorkBody() {
  const body = $("workBody");
  if (!body || !_activeEp) return;
  const ep = _activeEp;
  if (_workTab === "samples") return renderSamplesTab(body, ep);
  if (_workTab === "fields") return renderFieldsTab(body, ep);
  if (_workTab === "doc") return renderDocTab(body, ep);
}

function renderSamplesTab(body, ep) {
  const samples = _epSamples(ep).slice().sort((a, b) => (b.seq || 0) - (a.seq || 0));
  if (!samples.length) { body.innerHTML = `<div class="empty">该接口暂无样本。</div>`; return; }
  body.innerHTML = `<div class="work-split">
    <div class="work-side" id="epSamples">${samples.map(SampleRow).join("")}</div>
    <div class="work-detail" id="epDetail"><div class="empty">选一条样本查看请求 / 响应。</div></div>
  </div>`;
  const list = $("epSamples");
  if (list) list.querySelectorAll(".sample-row").forEach((row) => row.addEventListener("click", () => {
    const seq = Number(row.getAttribute("data-seq"));
    _activeSample = seq;
    list.querySelectorAll(".sample-row").forEach((x) => x.classList.toggle("active", x === row));
    loadSampleDetail(seq);
  }));
  if (samples.length) { _activeSample = samples[0].seq; loadSampleDetail(samples[0].seq); const f = list.querySelector(".sample-row"); if (f) f.classList.add("active"); }
}

function loadSampleDetail(seq) {
  if (!seq) return;
  const local = allRequests.find((r) => r.seq === seq);
  if (local) renderSampleDetail(local);
  fetch(`/api/request/${seq}`).then((r) => (r.ok ? r.json() : null)).then((rec) => {
    if (rec) renderSampleDetail(rec);
  }).catch(() => {});
}

function renderSampleDetail(rec) {
  const el = $("epDetail");
  if (!el) return;
  const st = rec.response && rec.response.status != null ? rec.response.status : (rec.is_failed ? "FAIL" : "—");
  const reqBody = rec.request && rec.request.post_data;
  const reqHdr = (rec.request && rec.request.headers) || {};
  const resHdr = (rec.response && rec.response.headers) || {};
  const resBody = rec.response && rec.response.body;
  el.innerHTML = `
    <div class="sd-head">
      ${MethodBadge(rec.method)}
      <span class="sd-status">${esc(String(st))}</span>
      <span class="sd-url" title="${esc(rec.url || "")}">${esc(rec.url || "")}</span>
      <div class="spacer"></div>
      <button class="btn btn-sm" id="sdMake">造数据</button>
      <button class="btn btn-sm" id="sdPin" title="把这条响应固定为 Mock 默认返回">固定为 Mock</button>
      <button class="btn btn-sm" id="sdEditReq">编辑请求</button>
      <button class="btn btn-sm" id="sdEditRes">编辑响应</button>
      <button class="btn btn-sm" id="sdDel">删除</button>
    </div>
    <div class="sd-scroll">
      ${dataBlock(rec.query ? queryToObj(rec.query) : {}, { mode: "kv", title: "Query", emptyText: "（无 query）" })}
      ${dataBlock(reqHdr, { mode: "kv", title: "请求头", emptyText: "（无请求头）" })}
      ${dataBlock(reqBody, { mode: "json", title: "请求体", emptyText: "（无请求体）" })}
      ${dataBlock(resHdr, { mode: "kv", title: "响应头", emptyText: "（无响应头）" })}
      ${dataBlock(resBody, { mode: "json", title: "响应体", emptyText: "（无响应体）" })}
    </div>`;
  const b0 = $("sdMake"); if (b0) b0.addEventListener("click", () => openMake({ method: rec.method, path: rec.path, query: rec.query, req_body: reqBody }));
  const bp = $("sdPin"); if (bp) bp.addEventListener("click", () => pinSeqToMock(rec.seq, bp));
  const b1 = $("sdEditReq"); if (b1) b1.addEventListener("click", () => openEditReq(rec));
  const b2 = $("sdEditRes"); if (b2) b2.addEventListener("click", () => openEditRes(rec));
  const b3 = $("sdDel"); if (b3) b3.addEventListener("click", () => { deleteRequest(rec.seq); renderSamplesAfterDelete(rec.seq); });
}

function renderSamplesAfterDelete(seq) {
  if (_activeSample === seq) _activeSample = null;
  if (_activeEp) { renderWork(); }
}

function renderFieldsTab(body, ep) {
  const inferred = inferEndpointDoc(ep.method, ep.path, allRequests);
  const doc = window.__epDoc || {};
  const mf = (doc.method === ep.method && doc.path === ep.path && Array.isArray(doc.match_fields)) ? doc.match_fields : [];
  body.innerHTML = `<div class="fields-wrap">
    ${FieldTable(inferred.req, "请求字段（query + 请求体）", mf)}
    ${FieldTable(inferred.resp, "响应字段", mf)}
  </div>`;
  body.querySelectorAll(".match-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fname = btn.getAttribute("data-fname");
      const cur = (window.__epDoc && window.__epDoc.match_fields) ? window.__epDoc.match_fields.slice() : [];
      if (cur.indexOf(fname) >= 0) cur = cur.filter((x) => x !== fname);
      else cur.push(fname);
      if (!window.__epDoc) window.__epDoc = { method: ep.method, path: ep.path, match_fields: [] };
      window.__epDoc.match_fields = cur;
      postJSON("/api/endpoint/doc", { method: ep.method, path: ep.path, match_fields: cur })
        .then(() => renderFieldsTab(body, ep))
        .catch(() => notify("匹配字段保存失败"));
    });
  });
}

function renderDocTab(body, ep) {
  body.innerHTML = `<div class="doc-editor">
    <div class="doc-row"><label>接口名称</label><input id="epName" class="input" placeholder="可选，如「用户登录」" /></div>
    <div class="doc-row"><label>标签</label><div class="ep-tags" id="epTags"></div><input id="epTagInput" class="input input-sm" placeholder="输入后回车添加" /></div>
    <div class="doc-row"><label>备注</label><textarea id="epNote" class="input ep-note" placeholder="用途 / 注意事项，仅本地保存，随接口共享"></textarea></div>
    <div class="doc-actions"><span class="muted" id="epTitle"></span><div class="spacer"></div><button class="btn btn-primary btn-sm" id="epDocSave">保存文档</button></div>
  </div>`;
  const ti = $("epTagInput");
  if (ti) ti.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = ti.value.trim();
    if (!v) return;
    const tc = $("epTags"); if (!tc) return;
    if (Array.from(tc.querySelectorAll(".tag-chip")).some((c) => c.textContent.replace("×", "").trim() === v)) { ti.value = ""; return; }
    const chip = document.createElement("span"); chip.className = "tag-chip"; chip.innerHTML = `${esc(v)} <span class="x">×</span>`;
    chip.querySelector(".x").addEventListener("click", () => chip.remove());
    tc.appendChild(chip); ti.value = "";
  });
  loadEndpointDoc(ep.method, ep.path, _epSamples(ep));
  const sv = $("epDocSave");
  if (sv) sv.addEventListener("click", () => {
    const tc = $("epTags");
    const tags = tc ? Array.from(tc.querySelectorAll(".tag-chip")).map((c) => c.textContent.replace("×", "").trim()).filter(Boolean) : [];
    postJSON("/api/endpoint/doc", { method: ep.method, path: ep.path, name: ($("epName") || {}).value || "", note: ($("epNote") || {}).value || "", tags })
      .then(() => notify("接口文档已保存")).catch(() => notify("保存失败"));
  });
}


// ==================== Mock 数据刷新 ====================

function refreshMockApis(reRender) {
  return postJSON("/api/mock/apis", {}).then((res) => {
    if (!res || !res.data) return;
    const apis = res.data.apis || [];
    window.__mockApis = apis;
    window.__mockApisBySeq = {};
    apis.forEach((a) => { window.__mockApisBySeq[a.seq] = a; });
    const urlEl = $("mockApisUrl");
    if (urlEl) { urlEl.textContent = res.data.url || "—"; urlEl.href = res.data.url || "#"; }
    const paneUrl = $("mockPaneUrl");
    if (paneUrl) { paneUrl.textContent = res.data.url || "—"; paneUrl.href = res.data.url || "#"; }
    if (typeof renderMockStream === "function") renderMockStream();
    renderList();
    renderHead();
  }).catch(() => {});
}

// ==================== 抽屉 / 气泡 ====================

function openDrawer(id) {
  document.querySelectorAll(".drawer-mask").forEach((m) => m.classList.toggle("hide", m.id !== id));
  if (id === "logsDrawer" && typeof loadMockLogs === "function") loadMockLogs();
  if (id === "inboxDrawer") renderInbox();
  if (id === "exportDrawer" && typeof renderExport === "function") renderExport();
  if (id === "settingsDrawer" && typeof renderSettings === "function") renderSettings();
}

function closeDrawers() {
  document.querySelectorAll(".drawer-mask").forEach((m) => m.classList.add("hide"));
}

function closePops() {
  document.querySelectorAll(".pop").forEach((p) => p.classList.remove("show"));
}

function togglePop(id) {
  const el = $(id);
  const willShow = el && !el.classList.contains("show");
  closePops();
  if (el && willShow) el.classList.add("show");
}

// ==================== 待造数据收件箱 ====================

function renderInbox() {
  _recomputeInbox();
  const el = $("inboxList");
  if (!el) return;
  if (!_inbox.length) { el.innerHTML = `<div class="empty">暂无未命中请求。Mock 启动后，未匹配到固定响应的请求会出现在这里，点「造数据」一键建 Mock。</div>`; return; }
  el.innerHTML = _inbox.map((l, i) => `<div class="inbox-row" data-i="${i}">
    <div class="inbox-head">${MethodBadge(l.method)}<span class="inbox-path">${esc(l.path || "")}</span>${l.query ? `<span class="inbox-q muted">?${esc(l.query)}</span>` : ""}</div>
    <div class="inbox-meta muted">${l.miss_reason ? esc(l.miss_reason) : "未命中（404）"}</div>
    <div class="inbox-ops"><button class="btn btn-sm btn-primary inbox-make" data-i="${i}">造数据</button></div>
  </div>`).join("");
  el.querySelectorAll(".inbox-make").forEach((b) => b.addEventListener("click", () => {
    const l = _inbox[Number(b.getAttribute("data-i"))];
    closeDrawers();
    openMake({ method: l.method, path: l.path, query: l.query });
  }));
}

// ==================== 造数据抽屉 ====================

let _makeFile = null;

function renderMakeFileInfo() {
  const el = $("makeFileInfo");
  if (!el) return;
  if (_makeFile) {
    el.innerHTML = `📎 ${esc(_makeFile.filename)}（${fmtSize(_makeFile.size)}）` +
      ` <a href="javascript:;" id="makeFileRemove" title="移除已挂文件">移除</a>`;
  } else {
    el.textContent = "未挂文件";
  }
}

function wireMakeAttach() {
  const btn = $("makeAttach");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const input = _getMockFileInput();
    input.value = "";
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const save = $("makeSave");
      if (save) { save.disabled = true; save.textContent = "读取文件中…"; }
      const done = () => {
        if (save) { save.disabled = false; save.textContent = "保存为 Mock"; }
      };
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = (reader.result || "").split(",").pop();
        _makeFile = { filename: f.name, mime: f.type || "application/octet-stream", b64, size: f.size };
        done();
        renderMakeFileInfo();
      };
      reader.onerror = () => { done(); notify("读取文件失败"); };
      reader.readAsDataURL(f);
    };
    input.click();
  });

  const info = $("makeFileInfo");
  if (info) {
    info.addEventListener("click", (e) => {
      const rm = e.target.closest("#makeFileRemove");
      if (!rm) return;
      e.preventDefault();
      _makeFile = null;
      renderMakeFileInfo();
    });
  }
}

function openMake(prefill) {
  prefill = prefill || {};
  const form = $("makeForm");
  const title = $("makeTitle");
  if (!form) return;
  _makeFile = null;
  if (title) title.textContent = prefill.method ? `造数据 · ${_up(prefill.method)} ${prefill.path || ""}` : "造数据 · 新建 Mock";
  form.innerHTML = `
    <div class="make-row"><label>方法</label>
      <select id="makeMethod" class="select">${["GET", "POST", "PUT", "DELETE", "PATCH"].map((m) => `<option${_up(prefill.method) === m ? " selected" : ""}>${m}</option>`).join("")}</select>
    </div>
    <div class="make-row"><label>路径</label><input id="makePath" class="input" placeholder="/api/xxx" value="${esc(prefill.path || "")}" /></div>
    <div class="make-row"><label>Query</label><input id="makeQuery" class="input" placeholder="a=1&b=2" value="${esc(prefill.query || "")}" /></div>
    <div class="make-row"><label>请求体</label><textarea id="makeReqBody" class="input make-body" placeholder="可选">${esc(prefill.req_body || "")}</textarea></div>
    <div class="make-row"><label>状态码</label><input id="makeStatus" class="input input-sm" maxlength="3" placeholder="200" value="200" /></div>
    <div class="make-row"><label>响应体</label><textarea id="makeResBody" class="input make-body" placeholder='{"ok":true}'>{}</textarea></div>
    <div class="make-attach-row">
      <label>挂文件</label>
      <button type="button" id="makeAttach" class="btn btn-sm">📎 选择文件</button>
      <span id="makeFileInfo" class="mock-attach-info">未挂文件</span>
    </div>
    <div class="make-hint muted">文件下载类接口用「挂文件」：Mock 返回即触发下载（可挂 PDF/Excel/压缩包等），优先级高于上面的文本响应体。</div>
    <div class="make-actions"><span class="muted">保存后立即生效，并固定为默认返回。</span><div class="spacer"></div>
      <button class="btn btn-primary" id="makeSave">保存为 Mock</button>
      <button class="btn" id="makeCancel">取消</button>
    </div>`;
  const cancel = $("makeCancel"); if (cancel) cancel.addEventListener("click", closeDrawers);
  const save = $("makeSave"); if (save) save.addEventListener("click", submitMake);
  wireMakeAttach();
  openDrawer("makeDrawer");
}

function submitMake() {
  const method = ($("makeMethod") || {}).value || "GET";
  const path = (($("makePath") || {}).value || "").trim();
  const query = (($("makeQuery") || {}).value || "").trim();
  const reqBody = (($("makeReqBody") || {}).value || "");
  const status = (($("makeStatus") || {}).value || "200").trim();
  const resBody = (($("makeResBody") || {}).value || "");
  if (!path) { notify("请填写路径"); return; }
  const btn = $("makeSave"); if (btn) btn.disabled = true;
  const mf = _makeFile;
  postJSON("/api/mock/make", { method: _up(method), path, query, req_body: reqBody, res_status: Number(status) || 200, res_body: resBody })
    .then((res) => {
      if (res && res.ok) {
        const seq = res.data && res.data.seq;
        const afterAttach = mf && seq
          ? postJSON("/api/mock/file", { seq, filename: mf.filename, mime: mf.mime, b64: mf.b64 })
              .then((r) => { if (!(r.data && r.data.ok)) notify("Mock 已保存，但挂文件失败：" + ((r.data && r.data.error) || "未知错误")); })
              .catch(() => notify("Mock 已保存，但挂文件失败"))
          : Promise.resolve();
        return afterAttach.then(() => {
          if (btn) btn.disabled = false;
          _makeFile = null;
          notify(mf ? "Mock 已保存并默认，已挂文件" : "Mock 已保存并默认");
          closeDrawers();
          refreshMockApis(true);
          _activeEp = { method: _up(method), path };
          showEndpoint(_up(method), path);
        });
      }
      if (btn) btn.disabled = false;
      notify((res && res.error) || "保存失败");
    })
    .catch(() => { if (btn) btn.disabled = false; notify("保存失败（后端未就绪）"); });
}

function openExportDrawerForEp(ep) {
  window.__exportEpFilter = ep ? { method: ep.method, path: ep.path } : null;
  openDrawer("exportDrawer");
  if (typeof renderExport === "function") renderExport();
}

// ==================== 中栏分 Tab 切换 ====================

function centerTab(name) {
  document.querySelectorAll(".center-pane").forEach((p) => p.classList.toggle("hide", p.id !== "pane" + name.charAt(0).toUpperCase() + name.slice(1)));
  document.querySelectorAll("#centerTabs .tab-switch").forEach((b) => b.classList.toggle("active", b.getAttribute("data-ctab") === name));
  if (name === "mock") {
    if (typeof loadMockLogs === "function") loadMockLogs();
    if (typeof loadMockApis === "function") loadMockApis();
  }
  else if (name === "export") { if (typeof renderExport === "function") renderExport(); }
  else if (name === "ledger") { renderList(); }
  else if (name === "history") { if (typeof renderDash === "function") renderDash(); }
}

// ==================== go() 重定向 ====================

go = function (screen, opts) {
  if (screen === "settings") { openDrawer("settingsDrawer"); return; }
  if (screen === "mock") { centerTab("mock"); return; }
  if (screen === "export") { centerTab("export"); return; }
  if (screen === "library") { centerTab("ledger"); showDash(opts); return; }
  // recording / overview / 默认 → 请求历史
  centerTab("history");
  if (opts && opts.focusSeq) { if (typeof renderDash === "function") renderDash(); openDetail(opts.focusSeq); }
  else if (typeof renderDash === "function") renderDash();
};

gotoLibEndpoint = function (rec) {
  if (!rec) return;
  if (!["XHR", "FETCH"].includes(_up(rec.resource_type))) libState.filters.apiOnly = false;
  libState.view = "detail";
  libState.domain = rec.registered_domain || rec.host || "";
  libState.method = _up(rec.method);
  libState.path = rec.path || "";
  libState.filter = "";
  centerTab("ledger");
  showEndpoint(_up(rec.method), rec.path || "");
};

// ==================== 状态包装（同步顶栏药丸） ====================

const _origUpdateStatus = updateStatus;
updateStatus = function (info) { _origUpdateStatus(info); _setRecChip(); const ps = $("recPopState"); if (ps) ps.textContent = (info && info.status === "recording") ? "录制中" : "空闲"; };

const _origUpdateMockUI = updateMockUI;
updateMockUI = function (info) { _origUpdateMockUI(info); _setMockChip(); };

const _origUpdateStats = updateStats;
updateStats = function (visible) { _origUpdateStats(visible); renderList(); };

// ==================== 初始化 ====================

function initV3() {
  ["recChip", "mockChip", "inboxChip", "menuChip"].forEach((id, i) => {
    const el = $(id); if (!el) return;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePop(["recPop", "mockPop", "", "menuPop"][i]);
      if (id === "inboxChip") { closePops(); openDrawer("inboxDrawer"); }
    });
  });

  const ls = $("listSearch");
  if (ls) ls.addEventListener("input", renderList);
  const lsc = $("listSearchClear");
  if (lsc) lsc.addEventListener("click", () => { if (ls) ls.value = ""; renderList(); });
  const rao = $("railApiOnly");
  if (rao) rao.addEventListener("click", () => { _railApiOnly = !_railApiOnly; rao.classList.toggle("active", _railApiOnly); renderList(); });
  const rel = $("railErrors");
  if (rel) rel.addEventListener("click", () => { _railErrors = !_railErrors; rel.classList.toggle("active", _railErrors); renderList(); });

  const mini = $("inboxMini");
  if (mini) mini.addEventListener("click", () => openDrawer("inboxDrawer"));

  const ctabs = document.querySelectorAll("#centerTabs .tab-switch");
  ctabs.forEach((b) => b.addEventListener("click", () => centerTab(b.getAttribute("data-ctab"))));
  const mpr = $("mockPaneRefresh");
  if (mpr) mpr.addEventListener("click", () => {
    if (typeof renderMockStream === "function") renderMockStream();
    if (typeof loadMockApis === "function") loadMockApis();
  });
  const mpc = $("mockPaneClear");
  if (mpc) mpc.addEventListener("click", () => {
    if (!mockLogs.length) return;
    if (!confirm("清空 Mock 处理记录？（不影响运行状态与命中计数）")) return;
    postJSON("/api/mock/logs/clear", {}).then(() => loadMockLogs());
  });

  const rps = $("recPopStart");
  if (rps) rps.addEventListener("click", () => { closePops(); const b = $("startBtn"); if (b) b.click(); });
  const rpst = $("recPopStop");
  if (rpst) rpst.addEventListener("click", () => { closePops(); const b = $("stopBtn"); if (b) b.click(); });
  const mlo = $("mockLogsOpen");
  if (mlo) mlo.addEventListener("click", () => { closePops(); openDrawer("logsDrawer"); });
  const mrf = $("mockRefreshBtn");
  if (mrf) mrf.addEventListener("click", () => refreshMockApis(true));

  const me = $("menuExport");
  if (me) me.addEventListener("click", () => { closePops(); centerTab("export"); });
  const mi = $("menuImport");
  if (mi) mi.addEventListener("click", () => { closePops(); const f = $("importFile"); if (f) f.click(); });
  const ms = $("menuSettings");
  if (ms) ms.addEventListener("click", () => { closePops(); openDrawer("settingsDrawer"); });
  const mc = $("menuClear");
  if (mc) mc.addEventListener("click", () => { closePops(); const b = $("clearBtn"); if (b) b.click(); });

  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); closeDrawers(); }));
  document.querySelectorAll(".drawer-mask").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) closeDrawers(); }));
  document.addEventListener("click", () => closePops());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePops(); closeDrawers(); } });

  showDash();
  renderHead();
  refreshMockApis(true);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initV3);
else initV3();
