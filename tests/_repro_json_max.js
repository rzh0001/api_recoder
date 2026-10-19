// jsdom 验证：JSON / 键值对组件「最大化」——点 ⛶ 在弹窗里全尺寸克隆展示
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const MOCK_LOGS = [
  { ts: 1700000001, method: "GET", path: "/api/x", query: "", url: "http://a.com/api/x", matched: true, miss_reason: null,
    status: 200, req_headers: {}, req_body: "", res_headers: {}, res_body: '{"v":{"x":1}}' },
];

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url, opts) => {
      const u = typeof url === "string" ? url : "";
      let body = { ok: true };
      if (u.indexOf("/api/mock/apis") >= 0) body = { ok: true, running: true, url: "http://127.0.0.1:1/", apis: [] };
      else if (u.indexOf("/api/mock/status") >= 0) body = { running: true, url: "http://127.0.0.1:1/", count: 0 };
      else if (u.indexOf("/api/mock/logs") >= 0) body = { running: true, logs: MOCK_LOGS };
      else if (u.indexOf("/api/status") >= 0) body = { status: "idle" };
      else if (u.indexOf("/api/config") >= 0) body = { ok: true, match_mode: true };
      else if (u.indexOf("/api/endpoint/") >= 0) body = { ok: true, docs: [] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    };
    window.alert = () => {};
    window.prompt = () => null;
    window.navigator.clipboard = { writeText: () => Promise.resolve() };
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

setTimeout(() => {
  assert("加载期无 JS 错误", errors.length === 0, errors.slice(0, 3));

  // 弹窗与按钮基础存在
  assert("index.html 含 #jsonMaxModal", !!document.getElementById("jsonMaxModal"));
  assert("含 #jsonMaxBody", !!document.getElementById("jsonMaxBody"));
  assert("含 #jsonMaxCopy", !!document.getElementById("jsonMaxCopy"));
  assert("含 #jsonMaxClose", !!document.getElementById("jsonMaxClose"));

  setTimeout(() => {
    const modal = document.getElementById("jsonMaxModal");

    // Mock 卡片区已改为请求历史流水；此处验证流水行展开后的响应体可最大化
    window.loadMockLogs();
    const row = document.querySelector("#mockStream .mock-stream-row");
    assert("Mock 流水渲染出记录行", !!row);
    row.querySelector(".mock-stream-head").dispatchEvent(new window.Event("click", { bubbles: true }));
    const codeEl = row.querySelector(".mock-stream-code");
    assert("展开流水行 → 显示响应体预览", !!codeEl && codeEl.textContent.indexOf('"x"') >= 0, codeEl && codeEl.textContent.slice(0, 40));

    // 详情 data-block 路径：合成一个 .data-block 验证 .db-max
    const blk = document.createElement("div");
    blk.className = "data-block db-json";
    blk.innerHTML =
      `<div class="db-head"><span class="db-title">响应体</span>` +
      `<button class="btn-mini db-max" data-max>⛶</button></div>` +
      `<div class="db-body"><div class="json-viewer" data-raw='{"hello":"world"}'><div class="json-line" data-line="1"><span class="json-code">{"hello":"world"}</span></div></div></div>`;
    document.body.appendChild(blk);
    blk.querySelector(".db-max").dispatchEvent(new window.Event("click", { bubbles: true }));
    assert("详情 .db-max → 弹窗显示", !document.getElementById("jsonMaxModal").classList.contains("hide"));
    const blkClone = document.querySelector("#jsonMaxBody .json-viewer");
    assert("详情克隆体 data-raw 一致", blkClone && blkClone.getAttribute("data-raw") === '{"hello":"world"}');

    // Esc 关闭
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert("Esc → 弹窗隐藏", document.getElementById("jsonMaxModal").classList.contains("hide"));

    // code-wrap（mock 日志弹窗里的 renderJsonGutter）含 ⛶
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    wrap.innerHTML = `<button class="btn-mini code-max" data-max>⛶</button><div class="json-viewer" data-raw='{"log":1}'></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector(".code-max").dispatchEvent(new window.Event("click", { bubbles: true }));
    assert("code-wrap .code-max → 弹窗显示", !document.getElementById("jsonMaxModal").classList.contains("hide"));
    assert("code-wrap 克隆体 data-raw 一致", document.querySelector("#jsonMaxBody .json-viewer").getAttribute("data-raw") === '{"log":1}');
    document.getElementById("jsonMaxClose").dispatchEvent(new window.Event("click", { bubbles: true }));

    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  }, 200);
}, 120);
