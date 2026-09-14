// jsdom 验收：编辑请求/响应弹窗的 JSON 区改用统一组件（预览 = renderJsonGutter + 编辑原文切换）
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: 0, data: { token: "tk_001", roles: ["a", "b"] }, msg: "ok" }),
    body_size: 40,
    size_bytes: 40,
  },
  timing: {},
};

const calls = [];
const jsErrors = [];

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
      if (!isPost && u.indexOf("/api/request/") >= 0) data = REC;
      else if (isPost && u.indexOf("/api/endpoint/doc") >= 0) data = { ok: true, doc: {} };
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
function box(taId) { return d.getElementById(taId).closest("[data-json-edit]"); }
function clickMode(taId, mode) {
  const b = box(taId).querySelector(`.je-mode[data-je-mode="${mode}"]`);
  b.dispatchEvent(new window.Event("click", { bubbles: true }));
}

setTimeout(() => {
  window.allRequests.length = 0;
  window.allRequests.push(REC);
  window.openDetail(1);

  setTimeout(() => {
    window.openEditRes(REC);

    // ---- 响应体：默认预览 = 统一组件 ----
    const bodyBox = box("editResBody");
    assert("响应体 JSON 区使用统一组件容器", !!bodyBox);
    const bodyPreview = bodyBox.querySelector(".json-edit-preview");
    assert("响应体预览含 .json-viewer", !!bodyPreview.querySelector(".json-viewer"));
    assert("响应体预览含行号", !!bodyPreview.querySelector(".json-lineno"));
    assert("响应体预览含折叠按钮", bodyPreview.querySelectorAll(".json-fold").length > 0);
    assert("响应体预览含字段复制按钮", bodyPreview.querySelectorAll("[data-copy-json-path]").length > 0);
    assert("默认预览态：textarea 隐藏", d.getElementById("editResBody").classList.contains("hide"));
    assert("默认预览态：预览可见", !bodyPreview.classList.contains("hide"));
    assert("默认预览按钮高亮", bodyBox.querySelector('.je-mode[data-je-mode="preview"]').classList.contains("is-active"));
    assert("响应体编辑框打开即格式化（非压缩单行）", d.getElementById("editResBody").value.indexOf("\n") >= 0, d.getElementById("editResBody").value);

    // ---- 响应头：同样统一组件 ----
    const hdrBox = box("editResHeaders");
    assert("响应头 JSON 区使用统一组件", !!hdrBox && !!hdrBox.querySelector(".json-viewer"));

    // ---- 切换到编辑原文 ----
    clickMode("editResBody", "edit");
    assert("编辑态：textarea 可见", !d.getElementById("editResBody").classList.contains("hide"));
    assert("编辑态：预览隐藏", bodyPreview.classList.contains("hide"));
    assert("编辑按钮高亮", bodyBox.querySelector('.je-mode[data-je-mode="edit"]').classList.contains("is-active"));

    // ---- 改内容 -> 切回预览 -> 预览刷新 ----
    const NEWB = JSON.stringify({ code: 403, msg: "forbidden", data: { token: "new" } }, null, 2);
    d.getElementById("editResBody").value = NEWB;
    clickMode("editResBody", "preview");
    const txt = bodyPreview.textContent || "";
    assert("切回预览后展示新内容", txt.indexOf("forbidden") >= 0, txt.slice(0, 60));
    assert("切回预览后不再显示旧内容", txt.indexOf("tk_001") < 0);

    // ---- 保存读取 textarea 真源 ----
    d.getElementById("editResSave").dispatchEvent(new window.Event("click", { bubbles: true }));
    setTimeout(() => {
      const call = calls.find((c) => c.url.indexOf("/api/response/edit") >= 0);
      assert("保存调用 /api/response/edit", !!call);
      if (call) {
        const p = JSON.parse(call.body);
        assert("保存内容 = 编辑后的新体", p.res_body.indexOf("forbidden") >= 0, p.res_body && p.res_body.slice(0, 40));
      }

      // ---- 请求弹窗同样统一 ----
      window.openEditReq(REC);
      const reqBodyBox = box("editReqBody");
      assert("请求体 JSON 区使用统一组件", !!reqBodyBox && !!reqBodyBox.querySelector(".json-viewer"));
      assert("请求体预览含行号", !!reqBodyBox.querySelector(".json-lineno"));
      const reqHdrBox = box("editReqHeaders");
      assert("请求头 JSON 区使用统一组件", !!reqHdrBox && !!reqHdrBox.querySelector(".json-viewer"));
      const reqBodyVal = d.getElementById("editReqBody").value;
      assert("请求体编辑框打开即格式化（非压缩单行）", reqBodyVal.indexOf("\n") >= 0, reqBodyVal);
      assert("请求体编辑框格式化结果正确", reqBodyVal.trim() === '{\n  "u": "a"\n}', reqBodyVal);

      assert("运行期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));
      console.log(`\nRESULT pass=${pass} fail=${fail}`);
      process.exit(fail ? 1 : 0);
    }, 80);
  }, 80);
}, 400);
