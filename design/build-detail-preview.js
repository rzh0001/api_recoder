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
  const modals =
    d.getElementById("editReqModal").outerHTML + "\n" +
    d.getElementById("editResModal").outerHTML;

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
  点头部 <b>✏ 编辑请求 / ✏ 编辑响应</b> 可查看两个造数据弹窗（仅视觉预览，保存不落库）。
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
var SAMPLE_REQ = {
  url: "https://api.example.com/v1/login?from=web&t=1",
  headers: { "Content-Type": "application/json", Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9" },
  body: '{"username":"admin","password":"123456"}'
};
var SAMPLE_RES = {
  status: "200",
  status_text: "OK",
  headers: { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": "sid=ab3f91c0; Path=/; HttpOnly" },
  body: '{\n  "code": 0,\n  "data": { "token": "tk_001" },\n  "msg": "ok"\n}'
};
function closeModal(id) { document.getElementById(id).classList.add("hide"); }
function openModal(id) { document.getElementById(id).classList.remove("hide"); }
function fillModal(id, s) {
  if (id === "editReqModal") {
    document.getElementById("editReqUrl").value = s.url;
    document.getElementById("editReqHeaders").value = JSON.stringify(s.headers, null, 2);
    document.getElementById("editReqBody").value = s.body;
  } else {
    document.getElementById("editResStatus").value = s.status;
    document.getElementById("editResStatusText").value = s.status_text;
    document.getElementById("editResHeaders").value = JSON.stringify(s.headers, null, 2);
    document.getElementById("editResBody").value = s.body;
  }
}
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
  if (e.target.closest("#editReqBtn")) { fillModal("editReqModal", SAMPLE_REQ); openModal("editReqModal"); return; }
  if (e.target.closest("#editResBtn")) { fillModal("editResModal", SAMPLE_RES); openModal("editResModal"); return; }
  var b = e.target.closest("[data-copy-block]");
  if (b) {
    var holder = b.closest(".data-block").querySelector("[data-raw]");
    copy(holder.getAttribute("data-raw"), b);
    return;
  }
  var v = e.target.closest("[data-copy-value]");
  if (v) { copy(v.getAttribute("data-copy-value"), v); return; }
  var f = e.target.closest(".json-fold");
  if (f) {
    var viewer = f.closest(".json-viewer");
    var start = Number(f.getAttribute("data-start")), end = Number(f.getAttribute("data-end"));
    var collapsed = f.classList.toggle("collapsed");
    f.textContent = collapsed ? "▶" : "▼";
    for (var i = start + 1; i < end; i++) {
      var line = viewer.querySelector('.json-line[data-line="' + i + '"]');
      if (line) line.classList.toggle("fold-hidden", collapsed);
    }
  }
});
</script>
</body>
</html>`;

  const outPath = path.join(ROOT, "design", "detail-preview.html");
  fs.writeFileSync(outPath, out, "utf8");
  console.log("已生成预览：" + outPath);
  process.exit(0);
}, 400);
