// jsdom 验收：录制详情「编辑响应」——按钮 → 弹窗预填 → 保存调 /api/response/edit → 详情刷新
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const REC = {
  seq: 1,
  method: "POST",
  url: "https://api.example.com/v1/login",
  path: "/v1/login",
  host: "api.example.com",
  registered_domain: "example.com",
  resource_type: "XHR",
  query: "",
  duration_ms: 123,
  is_failed: false,
  request: { headers: { "Content-Type": "application/json" }, post_data: '{"u":"a"}' },
  response: {
    status: 200,
    status_text: "OK",
    mime_type: "application/json",
    headers: { "Content-Type": "application/json", "Set-Cookie": "sid=abc" },
    body: JSON.stringify({ code: 0, data: { token: "tk_001" }, msg: "ok" }),
    body_size: 20,
    size_bytes: 20,
  },
  timing: {},
};

const NEW_BODY = JSON.stringify({ code: 403, msg: "forbidden" });
const REC2 = JSON.parse(JSON.stringify(REC));
REC2.response = {
  status: 403,
  status_text: "Forbidden",
  mime_type: "application/json",
  headers: { "Content-Type": "application/json", "X-Mock": "1" },
  body: NEW_BODY,
  body_size: NEW_BODY.length,
  size_bytes: NEW_BODY.length,
};

const calls = [];
const jsErrors = [];
let edited = false;

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url, opts) => {
      const u = typeof url === "string" ? url : "";
      const isPost = opts && opts.method === "POST";
      if (isPost) calls.push({ url: u, body: opts.body || "" });
      let data = { ok: true };
      if (isPost && u.indexOf("/api/response/edit") >= 0) { edited = true; data = { ok: true }; }
      else if (!isPost && u.indexOf("/api/request/") >= 0) data = edited ? REC2 : REC;
      else if (isPost && u.indexOf("/api/endpoint/doc") >= 0) data = { ok: true, doc: {} };
      else if (isPost) data = { ok: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    window.alert = () => {};
    window.prompt = () => null;
    window.WebSocket = function () { this.send = () => {}; this.close = () => {}; };
    window.addEventListener("error", (e) => jsErrors.push(e.message));
  },
});

const { window } = dom;
const d = window.document;

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("[OK] " + name); }
  else { fail++; console.log("[FAIL] " + name + (extra ? " :: " + JSON.stringify(extra) : "")); }
}
function clickTab(key) {
  const el = d.querySelector(`.detail-tabs .tab[data-tab="${key}"]`);
  if (el) el.dispatchEvent(new window.Event("click", { bubbles: true }));
}

setTimeout(() => {
  window.allRequests.length = 0;
  window.allRequests.push(REC);
  window.renderDetail(REC);

  // ---- 1) 详情头部有「编辑响应」入口 ----
  clickTab("response");
  const resBtn = d.getElementById("editResBtn");
  assert("详情头部有「编辑响应」按钮", !!resBtn);
  if (!resBtn) { finish(); return; }
  assert("「编辑请求」与「编辑响应」并存", !!d.getElementById("editReqBtn"));

  // ---- 2) 点开弹窗预填当前响应 ----
  resBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  const modal = d.getElementById("editResModal");
  assert("编辑响应弹窗打开", modal && !modal.classList.contains("hide"));
  assert("状态码预填 200", d.getElementById("editResStatus").value === "200", d.getElementById("editResStatus").value);
  assert("状态文本预填 OK", d.getElementById("editResStatusText").value === "OK");
  const hdrText = d.getElementById("editResHeaders").value;
  assert("响应头预填含 Set-Cookie", hdrText.indexOf("Set-Cookie") >= 0);
  assert("响应体预填含 token", d.getElementById("editResBody").value.indexOf("tk_001") >= 0);

  // ---- 3) 修改状态码/头/体并保存 ----
  d.getElementById("editResStatus").value = "403";
  d.getElementById("editResStatusText").value = "Forbidden";
  d.getElementById("editResHeaders").value = JSON.stringify({ "Content-Type": "application/json", "X-Mock": "1" }, null, 2);
  d.getElementById("editResBody").value = NEW_BODY;
  d.getElementById("editResSave").dispatchEvent(new window.Event("click", { bubbles: true }));

  setTimeout(() => {
    const call = calls.find((c) => c.url.indexOf("/api/response/edit") >= 0);
    assert("保存调用 /api/response/edit", !!call, calls);
    if (call) {
      const p = JSON.parse(call.body);
      assert("携带 seq=1", p.seq === 1, p);
      assert("携带新状态码 403", p.res_status === 403, p);
      assert("携带新状态文本", p.res_status_text === "Forbidden", p);
      assert("携带新响应头 X-Mock", p.res_headers.indexOf("X-Mock") >= 0);
      assert("携带新响应体", p.res_body.indexOf("forbidden") >= 0);
    }

    // ---- 4) 保存后弹窗关闭、详情刷新出新值 ----
    assert("保存后弹窗关闭", modal.classList.contains("hide"));
    const meta = d.querySelector(".detail-meta");
    assert("详情状态更新为 403", meta && meta.textContent.indexOf("403") >= 0, meta && meta.textContent);
    clickTab("response");
    const viewerText = d.getElementById("detailBody").textContent || "";
    assert("响应体展示新内容", viewerText.indexOf("forbidden") >= 0);
    assert("响应体不再有旧 token", viewerText.indexOf("tk_001") < 0);
    assert("运行期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));
    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  }, 120);

  function finish() {
    assert("运行期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));
    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  }
}, 400);
