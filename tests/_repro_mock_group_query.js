// jsdom 验证：Mock 页签「Mock 处理流水」
// - 数据源 = /api/mock/logs：Mock 没跑过时列表为空，Mock 收到的请求逐条显示
// - 行：method / 路径+query / 状态 / 未命中徽标；展开可见未命中原因与响应体
// - 行操作：指定返回 / 造数据 / 测试
// - 「清空记录」按钮存在
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const LOGS = { ok: true, running: true, logs: [
  { ts: 1700000003, method: "POST", path: "/api/x", query: "", url: "/api/x", matched: true, miss_reason: null, status: 200, req_headers: {}, req_body: '{"a":1}', res_headers: {}, res_body: '{"v":2}' },
  { ts: 1700000002, method: "GET", path: "/api/x", query: "a=9", url: "/api/x?a=9", matched: false, miss_reason: "无可匹配的固定响应", status: 404, req_headers: {}, req_body: "", res_headers: {}, res_body: '{"err":1}' },
  { ts: 1700000001, method: "GET", path: "/api/y", query: "", url: "/api/y", matched: true, miss_reason: null, status: 200, req_headers: {}, req_body: "", res_headers: {}, res_body: "{}" },
] };

let currentLogs = LOGS;

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url) => {
      const u = typeof url === "string" ? url : "";
      let body = { ok: true };
      if (u.indexOf("/api/mock/logs") >= 0) body = currentLogs;
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

  // 1) Mock 没跑过（空 logs）→ 列表为空提示
  currentLogs = { ok: true, running: false, logs: [] };
  window.loadMockLogs();
  await tick(150);
  assert("无处理记录时流水为空提示", box.querySelectorAll(".mock-stream-row").length === 0 && box.textContent.indexOf("暂无处理记录") >= 0, box.textContent.slice(0, 40));

  // 2) 有处理记录 → 逐条显示
  currentLogs = LOGS;
  window.loadMockLogs();
  await tick(150);
  let rows = box.querySelectorAll(".mock-stream-row");
  assert("有处理记录时逐条显示（3 条）", rows.length === 3, rows.length);

  // 倒序沿用后端 logs_list（最新在前）：首行是 POST /api/x
  assert("首行为最新一条（POST /api/x）", rows[0].querySelector(".method-badge").textContent === "POST", rows[0].textContent);
  assert("行含路径+query", rows[1].textContent.indexOf("/api/x?a=9") >= 0, rows[1].textContent);
  assert("每行含 method 徽标 + 状态", Array.from(rows).every((r) => r.querySelector(".method-badge") && r.querySelector(".mock-stream-status")));

  // 未命中徽标：仅第 2 行（matched=false）
  const missRows = Array.from(rows).filter((r) => r.querySelector(".mock-stream-pin"));
  assert("仅未命中的行带「未命中」徽标", missRows.length === 1 && missRows[0].textContent.indexOf("/api/x?a=9") >= 0, missRows.map((r) => r.textContent));

  // 状态样式：404 行红
  const badRow = Array.from(rows).find((r) => r.textContent.indexOf("404") >= 0);
  assert("404 行状态带 s-err", !!badRow && badRow.querySelector(".mock-stream-status").classList.contains("s-err"));

  // 每行操作按钮
  assert("每行都有「指定返回」「造数据」「测试」", Array.from(rows).every((r) => r.querySelector(".ms-pin") && r.querySelector(".ms-make") && r.querySelector(".ms-test")));

  // 默认折叠 → 展开
  assert("行默认折叠", Array.from(rows).every((r) => !r.classList.contains("expanded")));
  click(rows[1].querySelector(".mock-stream-head"));
  assert("点行头 → 展开", rows[1].classList.contains("expanded"));
  assert("未命中行展开显示未命中原因", rows[1].textContent.indexOf("无可匹配的固定响应") >= 0, rows[1].textContent.slice(0, 80));
  assert("展开显示响应体", rows[1].querySelector(".mock-stream-code") && rows[1].querySelector(".mock-stream-code").textContent.length > 0);

  // 展开态跨重渲染保留
  currentLogs = LOGS;
  window.loadMockLogs();
  await tick(150);
  rows = box.querySelectorAll(".mock-stream-row");
  assert("重渲染后展开态保留", rows[1].classList.contains("expanded"));

  // 清空按钮
  assert("头部有「清空记录」按钮", !!document.getElementById("mockPaneClear"));

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}, 300);
