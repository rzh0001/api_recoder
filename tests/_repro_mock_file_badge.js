// jsdom 验证：Mock 处理流水的空态与「指定返回 → 找不到对应录制则转造数据」回退
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const v3Js = fs.readFileSync(path.join(ROOT, "static/v3.js"), "utf8");
const htmlWithScript = html.replace(
  "</body>",
  `<script>${appJs}</script><script>${v3Js}</script></body>`
);

const LOGS = { ok: true, running: true, logs: [
  { ts: 1700000001, method: "GET", path: "/api/dl", query: "", url: "/api/dl", matched: true, miss_reason: null, status: 200, req_headers: {}, req_body: "", res_headers: {}, res_body: "{}" },
] };

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url) => {
      const u = typeof url === "string" ? url : "";
      let body = { ok: true };
      if (u.indexOf("/api/mock/logs") >= 0) body = LOGS;
      else if (u.indexOf("/api/mock/apis") >= 0) body = { ok: true, running: true, url: "http://127.0.0.1:1/", apis: [] };
      else if (u.indexOf("/api/mock/status") >= 0) body = { running: true, url: "http://127.0.0.1:1/", count: 0 };
      else if (u.indexOf("/api/status") >= 0) body = { status: "idle" };
      else if (u.indexOf("/api/config") >= 0) body = { ok: true, match_mode: true };
      else if (u.indexOf("/api/endpoint/") >= 0) body = { ok: true, docs: [] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    };
    window.alert = () => {};
    window.prompt = () => null;
    window.confirm = () => true;
    window.WebSocket = function () { this.send = () => {}; this.close = () => {}; };
  },
});
const { window } = dom;
const { document } = window;
const errors = [];
window.addEventListener("error", (e) => errors.push(e.error ? e.error.stack : e.message));
window.addEventListener("unhandledrejection", (e) => errors.push("unhandledrejection: " + (e.reason && e.reason.stack || e.reason)));

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("[OK] " + name); }
  else { fail++; console.log("[FAIL] " + name + (extra ? " :: " + JSON.stringify(extra) : "")); }
}
function click(el) { if (el) el.dispatchEvent(new window.Event("click", { bubbles: true })); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

setTimeout(async () => {
  assert("加载期无 JS 错误", errors.length === 0, errors.slice(0, 3));
  const box = document.getElementById("mockStream");

  window.loadMockLogs();
  await tick(150);
  const rows = box.querySelectorAll(".mock-stream-row");
  assert("流水渲染出 1 条处理记录", rows.length === 1, rows.length);

  // 展开 → 有「指定返回」「造数据」
  click(rows[0].querySelector(".mock-stream-head"));
  assert("展开行有「指定返回」按钮", !!rows[0].querySelector(".ms-pin"));
  assert("展开行有「造数据」按钮", !!rows[0].querySelector(".ms-make"));

  // 无对应录制记录时，点「指定返回」应回退到造数据抽屉（预填 method/path/query）
  click(rows[0].querySelector(".ms-pin"));
  await tick(60);
  assert("无对应录制时「指定返回」回退到造数据抽屉", !document.getElementById("makeDrawer").classList.contains("hide"), document.getElementById("makeDrawer").className);
  assert("造数据预填方法/路径", document.getElementById("makePath").value === "/api/dl", document.getElementById("makePath") && document.getElementById("makePath").value);

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}, 300);
