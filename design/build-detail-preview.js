// 生成「录制详情·统一数据块」视觉预览页：用真实 styles.css + 真实渲染代码产出静态 HTML，
// 便于在浏览器里直接核对改造后的视觉与复制交互（jsdom 无法验证 CSS 布局）。
// 用法：NODE_PATH=<workspace>/node_modules node design/build-detail-preview.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "static/styles.css"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const REC = {
  seq: 1,
  method: "POST",
  url: "https://api.example.com/v1/login?from=web&t=1",
  path: "/v1/login",
  host: "api.example.com",
  registered_domain: "example.com",
  resource_type: "XHR",
  query: "from=web&t=1",
  duration_ms: 123,
  is_failed: false,
  request: {
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjd9",
      "X-Trace-Id": "8f2c1a90b3",
    },
    post_data: JSON.stringify({ username: "admin", password: "123456", remember: true, extra: { device: "pc", ip: "10.0.0.7" } }, null, 2),
  },
  response: {
    status: 200,
    status_text: "OK",
    mime_type: "application/json",
    size_bytes: 256,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "sid=ab3f91c0; Path=/; HttpOnly",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({
      code: 0,
      msg: "ok",
      data: { token: "tk_001", expire: 7200, user: { id: 7, name: "张三", roles: ["admin", "operator"], dept: { id: 3, name: "技术科" } } },
    }, null, 2),
  },
  timing: { dns: 1, connect: 2, ssl: 5, send: 1, wait: 98, receive: 16 },
  annotations: { req: {}, res: {} },
};

const SAMPLE_COMPARE = JSON.stringify({
  username: "admin",
  password: "new-pass",
  extra: { device: "pc" },
  captcha: "9999",
}, null, 2);

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url) => {
      const u = typeof url === "string" ? url : "";
      let data = { ok: true };
      if (u.indexOf("/api/request/") >= 0) data = REC;
      else if (u.indexOf("/api/mock/logs") >= 0) data = { ok: true, logs: [] };
      else if (u.indexOf("/api/mock/apis") >= 0) data = { ok: true, apis: [] };
      else if (u.indexOf("/api/endpoint/doc") >= 0) data = { ok: true, doc: { name: "", note: "", tags: [], req: [], resp: [] } };
      else if (u.indexOf("/api/config") >= 0) data = { ok: true, port: 8080, match_mode: true };
      else if (u.indexOf("/api/status") >= 0) data = { ok: true, running: false };
      else if (u.indexOf("/api/mock/status") >= 0) data = { ok: true, running: false, url: "", count: 0 };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    window.alert = () => {};
    window.prompt = () => null;
    window.WebSocket = function () { this.send = () => {}; this.close = () => {}; };
    window.addEventListener("error", () => {});
  },
});

const { window } = dom;
const d = window.document;

setTimeout(() => {
  window.allRequests.length = 0;
  window.allRequests.push(REC);
  window.renderDetail(REC);

  const head = d.querySelector(".detail-head").outerHTML;
  const capture = (key) => {
    const tab = d.querySelector(`.detail-tabs .tab[data-tab="${key}"]`);
    if (tab) tab.dispatchEvent(new window.Event("click", { bubbles: true }));
    return d.getElementById("detailBody").innerHTML;
  };
  const overview = capture("overview");
  const request = capture("request");
  const response = capture("response");
  // 用真实函数预填并渲染两个造数据弹窗（JSON 区统一组件预览），再收起后截图
  window.openEditReq(REC);
  window.openEditRes(REC);
  d.getElementById("editReqModal").classList.add("hide");
  d.getElementById("editResModal").classList.add("hide");
  const modals =
    d.getElementById("editReqModal").outerHTML + "\n" +
    d.getElementById("editResModal").outerHTML;

  // 请求体最大化 + 右侧对比：填样例并真跑一次 diff，捕获带结果的弹窗
  const reqTab = d.querySelector('.detail-tabs .tab[data-tab="request"]');
  if (reqTab) reqTab.dispatchEvent(new window.Event("click", { bubbles: true }));
  const reqBlock = Array.from(d.querySelectorAll("#detailBody .data-block")).find((b) => {
    const t = b.querySelector(".db-title");
    return t && t.textContent.trim() === "请求体";
  });
  if (reqBlock) {
    const mx = reqBlock.querySelector(".db-max");
    if (mx) mx.dispatchEvent(new window.Event("click", { bubbles: true }));
    // 最大化后对比面板默认收起：点顶部「对比」展开，再粘贴样例跑一次真实 diff
    d.getElementById("jsonMaxCompareBtn").dispatchEvent(new window.Event("click", { bubbles: true }));
    d.getElementById("jsonMaxCompareInput").value = SAMPLE_COMPARE;
    // 同时写进子文本，outerHTML 才能带走内容 —— 否则预览页里切模式无法重算对比
    d.getElementById("jsonMaxCompareInput").textContent = SAMPLE_COMPARE;
    d.getElementById("jsonMaxCompareRun").dispatchEvent(new window.Event("click", { bubbles: true }));
  }
  const maxModal = d.getElementById("jsonMaxModal").outerHTML;
  d.getElementById("jsonMaxModal").classList.add("hide");

  const out = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>录制详情 · 统一数据块预览</title>
<style>
${css}
body { background: var(--bg); margin: 0; padding: 24px; }
.preview-wrap { max-width: 900px; margin: 0 auto; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; box-shadow: var(--sh-2); }
.preview-note { max-width: 900px; margin: 0 auto 14px; color: var(--text-2); font-size: 13px; line-height: 1.7; }
.preview-note b { color: var(--text); }
.pv-tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--border); background: var(--surface-2); }
.pv-tab { padding: 6px 14px; font-size: 13px; cursor: pointer; border-radius: var(--r-sm) var(--r-sm) 0 0; color: var(--text-2); }
.pv-tab.active { background: var(--surface); color: var(--accent-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.pv-pane { display: none; padding: 10px 12px; }
.pv-pane.active { display: block; }
.kv-copy, .db-head .btn-mini { pointer-events: auto; }
</style>
</head>
<body>
<div class="preview-note">
  <b>录制详情 · 统一数据块</b> —— 概览 / 请求 / 响应 三个 Tab。所有结构化数据（基本信息 / Query / 请求头 / 响应头 / Timing / 请求体 / 响应体）
  共用同一个「数据块」外壳：标题栏 + 复制全文 + 行号 + 逐行复制值。把鼠标移到任意一行，右侧会出现「复制」。
  点头部 <b>✏ 编辑请求 / ✏ 编辑响应</b> 可查看两个造数据弹窗：Headers / Body 已改用与详情页同一套 JSON 组件（可折叠、可复制、可最大化），
  点弹窗里的 <b>预览 / 编辑原文</b> 切换（仅视觉预览，保存不落库）。
  最大化请求体后，右侧是<b>同一套 JSON 组件</b>、与左侧等高并排；粘贴另一份 JSON 点「对比」，
  可在 <b>按字段 / 按行</b> 两种模式间切换，差异直接高亮在左右两个 JSON 区里
  （红=仅左侧 · 蓝=仅右侧 · 橙=值不同）。
  <button id="pvShowMax" class="btn btn-sm" style="margin-left:8px">查看：请求体最大化 + 左右对比</button>
</div>
<div class="preview-wrap">
  ${head}
  <div class="pv-tabs">
    <div class="pv-tab active" data-pane="overview">概览</div>
    <div class="pv-tab" data-pane="request">请求</div>
    <div class="pv-tab" data-pane="response">响应</div>
  </div>
  <div class="pv-pane active" id="pane-overview">${overview}</div>
  <div class="pv-pane" id="pane-request">${request}</div>
  <div class="pv-pane" id="pane-response">${response}</div>
</div>
${modals}
${maxModal}
<script>
document.querySelectorAll(".pv-tab").forEach(function (t) {
  t.addEventListener("click", function () {
    document.querySelectorAll(".pv-tab").forEach(function (x) { x.classList.remove("active"); });
    document.querySelectorAll(".pv-pane").forEach(function (x) { x.classList.remove("active"); });
    t.classList.add("active");
    document.getElementById("pane-" + t.getAttribute("data-pane")).classList.add("active");
  });
});
function flash(btn) {
  var old = btn.textContent;
  btn.textContent = "已复制 ✓";
  btn.disabled = true;
  setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1200);
}
function copy(txt, btn) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(function () { flash(btn); });
  } else {
    var ta = document.createElement("textarea");
    ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); flash(btn); } catch (e) { alert("复制失败"); }
    ta.remove();
  }
}
function closeModal(id) { document.getElementById(id).classList.add("hide"); }
function openModal(id) { document.getElementById(id).classList.remove("hide"); }
["editReqModal", "editResModal"].forEach(function (id) {
  var m = document.getElementById(id);
  var close = m.querySelector(".modal-close"), cancel = m.querySelector(".modal-actions .btn:not(.btn-primary)"), save = m.querySelector(".btn-primary");
  if (close) close.addEventListener("click", function () { closeModal(id); });
  if (cancel) cancel.addEventListener("click", function () { closeModal(id); });
  m.addEventListener("click", function (e) { if (e.target === m) closeModal(id); });
  if (save) save.addEventListener("click", function () {
    closeModal(id);
    var old = save.textContent;
    save.textContent = "已保存 ✓";
    setTimeout(function () { save.textContent = old; }, 1200);
  });
});
document.addEventListener("click", function (e) {
  if (e.target.closest("#editReqBtn")) { openModal("editReqModal"); return; }
  if (e.target.closest("#editResBtn")) { openModal("editResModal"); return; }
  var jm = e.target.closest(".je-mode");
  if (jm) {
    var boxEl = jm.closest("[data-json-edit]");
    var mode = jm.getAttribute("data-je-mode");
    boxEl.querySelectorAll(".je-mode").forEach(function (x) { x.classList.toggle("is-active", x === jm); });
    var ta = boxEl.querySelector("textarea"), pv = boxEl.querySelector(".json-edit-preview");
    if (mode === "edit") { pv.classList.add("hide"); ta.classList.remove("hide"); }
    else { pv.classList.remove("hide"); ta.classList.add("hide"); }
    return;
  }
  var b = e.target.closest("[data-copy-block]");
  if (b) {
    var holder = b.closest(".data-block").querySelector("[data-raw]");
    copy(holder.getAttribute("data-raw"), b);
    return;
  }
  var v = e.target.closest("[data-copy-value]");
  if (v) { copy(v.getAttribute("data-copy-value"), v); return; }
  var f = e.target.closest(".json-fold");
  if (f) { setFoldCollapsed(f, !f.classList.contains("collapsed")); return; }
});

// 最大化对比弹窗（静态预览）：显示 / 关闭 / 对比 / 清空
// 对比引擎直接从 app.js 序列化过来（jsonCompareEngineSource），
// 保证预览页行为与真实页面完全一致，不另抄一份逻辑。
${window.jsonCompareEngineSource()}

document.getElementById("pvShowMax").addEventListener("click", function () {
  document.getElementById("jsonMaxModal").classList.remove("hide");
});
document.getElementById("jsonMaxClose").addEventListener("click", function () {
  document.getElementById("jsonMaxModal").classList.add("hide");
});
document.getElementById("jsonMaxModal").addEventListener("click", function (e) {
  if (e.target === this) this.classList.add("hide");
});
document.getElementById("jsonMaxCompareBtn").addEventListener("click", function () {
  toggleCompare();
});
document.getElementById("jsonMaxCompareRun").addEventListener("click", function () {
  if (showCompareJson()) runJsonCompare();
});
document.getElementById("jsonMaxCompareEdit").addEventListener("click", function () {
  setComparePaneMode("edit");
});
document.getElementById("jsonMaxCompareClear").addEventListener("click", function () {
  resetJsonCompare();
});
document.querySelectorAll("#jsonMaxBar .jm-mode").forEach(function (b) {
  b.addEventListener("click", function () {
    setCompareMode(b.getAttribute("data-jm-mode"));
    var ta = document.getElementById("jsonMaxCompareInput");
    if (ta.value.trim() && showCompareJson()) runJsonCompare();
  });
});
linkCompareScroll();
</script>
</body>
</html>`;

  const outPath = path.join(ROOT, "design", "detail-preview.html");
  fs.writeFileSync(outPath, out, "utf8");
  console.log("已生成预览：" + outPath);
  process.exit(0);
}, 400);
