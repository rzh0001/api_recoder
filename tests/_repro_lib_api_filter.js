// jsdom 验证：请求库「仅 API」过滤（默认排除非 API，toggle 可显示）
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url) => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ ok: true, data: { ok: true, docs: [] } }),
      text: () => Promise.resolve("{}"),
    });
    let ws = null;
    window.__getWs = () => ws;
    window.WebSocket = class { constructor(u) { ws = this; this.url = u; if (this.onopen) setTimeout(() => this.onopen(), 0); } close() {} send() {} };
    window.alert = () => {}; window.prompt = () => null;
  },
});
const { window } = dom;
const { document } = window;
const errors = [];
window.addEventListener("error", (e) => errors.push(e.error ? e.error.stack : e.message));

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("[OK] " + name); }
  else { fail++; console.log("[FAIL] " + name + (extra ? " :: " + JSON.stringify(extra) : "")); }
}

function countRows() {
  return document.querySelectorAll("#libraryPad .lib-ep-row").length;
}

function run() {
  const ws = window.__getWs();
  // 混合类型：1 个 XHR + 1 个 DOCUMENT + 1 个 IMAGE（同域 h.com）
  ws.onmessage({ data: JSON.stringify({
    type: "snapshot",
    requests: [
      { seq: 1, method: "GET", path: "/api/a", url: "https://h.com/api/a", resource_type: "XHR",
        host: "h.com", registered_domain: "h.com", response: { status: 200, body: "{}", body_size: 2, size_bytes: 2 }, request: {}, tags: [], annotations: {}, captured_at: 1 },
      { seq: 2, method: "GET", path: "/page.html", url: "https://h.com/page.html", resource_type: "DOCUMENT",
        host: "h.com", registered_domain: "h.com", response: { status: 200, body: "<html>", body_size: 6, size_bytes: 6 }, request: {}, tags: [], annotations: {}, captured_at: 2 },
      { seq: 3, method: "GET", path: "/x.png", url: "https://h.com/x.png", resource_type: "IMAGE",
        host: "h.com", registered_domain: "h.com", response: { status: 200, body: "PNG", body_size: 3, size_bytes: 3 }, request: {}, tags: [], annotations: {}, captured_at: 3 },
    ],
    status: {}, stats: {},
  }) });

  assert("无加载期错误", errors.length === 0, errors.slice(0, 3));

  window.renderLibrary();
  // 默认 apiOnly=true → 仅 XHR/FETCH 进库（1 条）
  assert("默认仅 API：非 API（DOCUMENT/IMAGE）不进请求库", countRows() === 1, countRows());
  assert("默认仅 API：库里只有 /api/a", !!document.querySelector('.lib-ep-row[data-p="/api/a"]'));

  // 关闭「仅 API」→ 显示全部 3 条
  const apiChip = document.querySelector('[data-t="api"]');
  assert("存在「仅 API」筛选 chip", !!apiChip);
  apiChip.click(); // apiOnly -> false
  window.renderLibrary();
  assert("关闭仅 API 后：非 API 也进入请求库（共 3 条）", countRows() === 3, countRows());

  // 再打开「仅 API」→ 回到 1 条
  apiChip.click(); // apiOnly -> true
  window.renderLibrary();
  assert("再次开启仅 API：回到 1 条", countRows() === 1, countRows());

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  if (fail) process.exit(1);
}
setTimeout(run, 80);
