// jsdom 验收：造数据（编辑响应）抽屉新增「挂文件」入口与状态展示
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const REC_FILE = {
  seq: 1, method: "GET", url: "https://h.com/api/dl", path: "/api/dl", host: "h.com",
  registered_domain: "h.com", resource_type: "XHR", query: "", duration_ms: 10, is_failed: false,
  request: { headers: {}, post_data: null },
  response: { status: 200, status_text: "OK", headers: {}, body: null, body_size: 0, size_bytes: 0 },
  mock_file: { filename: "manual.pdf", size: 2048 },
  timing: {},
};
const REC_NONE = JSON.parse(JSON.stringify(REC_FILE));
delete REC_NONE.mock_file;

const jsErrors = [];
const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url) => {
      const u = typeof url === "string" ? url : "";
      let data = { ok: true };
      if (u.indexOf("/api/request/") >= 0) data = REC_FILE;
      else if (u.indexOf("/api/endpoint/") >= 0) data = { ok: true, doc: {} };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    window.alert = () => {};
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
function openDrawer(rec) {
  window.allRequests.length = 0;
  window.allRequests.push(rec);
  window.renderDetail(rec);
  const btn = d.getElementById("editResBtn");
  btn.dispatchEvent(new window.Event("click", { bubbles: true }));
}

setTimeout(() => {
  assert("加载期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));

  // 1) 已挂文件：抽屉显示文件名 + 移除链接
  openDrawer(REC_FILE);
  assert("抽屉含「挂文件」按钮", !!d.getElementById("editResAttach"));
  const info = d.getElementById("editResFileInfo");
  assert("已挂文件时展示文件名 manual.pdf", info && info.textContent.indexOf("manual.pdf") >= 0, info && info.textContent);
  assert("已挂文件时含「移除」链接", !!d.getElementById("editResFileRemove"));

  // 2) 未挂文件：显示「未挂文件」，无移除链接
  openDrawer(REC_NONE);
  const info2 = d.getElementById("editResFileInfo");
  assert("未挂文件时显示「未挂文件」", info2 && info2.textContent.trim() === "未挂文件", info2 && info2.textContent);
  assert("未挂文件时无移除链接", !d.getElementById("editResFileRemove"));

  // 3) 点击「挂文件」创建隐藏文件选择器（不抛错）
  let threw = false;
  try { d.getElementById("editResAttach").dispatchEvent(new window.Event("click", { bubbles: true })); }
  catch (e) { threw = true; console.log(e); }
  assert("点击「挂文件」不抛错", !threw);

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}, 400);
