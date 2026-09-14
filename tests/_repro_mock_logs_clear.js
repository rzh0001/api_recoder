// jsdom 验收：Mock「处理记录」清空按钮 —— 有记录可点 → confirm → POST /api/mock/logs/clear → 列表清空、按钮禁用
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

let logs = [
  { ts: 1785050000, method: "GET", path: "/api/x", query: "a=1", matched: true, status: 200, req_headers: {}, req_body: "", res_headers: {}, res_body: '{"ok":true}' },
  { ts: 1785050001, method: "POST", path: "/api/y", query: "", matched: false, status: 404, miss_reason: "库中无此接口（method+path 无匹配记录）", req_headers: {}, req_body: "", res_headers: {}, res_body: "" },
];

const calls = [];
const jsErrors = [];
let confirmCount = 0;

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
      if (u.indexOf("/api/mock/logs/clear") >= 0) { logs = []; data = { ok: true }; }
      else if (u.indexOf("/api/mock/logs") >= 0) data = { ok: true, running: true, logs };
      else if (u.indexOf("/api/mock/apis") >= 0) data = { ok: true, apis: [] };
      else if (u.indexOf("/api/mock/status") >= 0) data = { ok: true, running: false, url: "", count: 0 };
      else if (u.indexOf("/api/status") >= 0) data = { ok: true, running: false };
      else if (u.indexOf("/api/config") >= 0) data = { ok: true, port: 8080, match_mode: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    window.alert = () => {};
    window.confirm = () => { confirmCount++; return true; };
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

setTimeout(() => {
  const btn = d.getElementById("mockLogsClearBtn");
  assert("处理记录存在清空按钮", !!btn);

  // 有记录 -> 按钮可用
  assert("有记录时按钮可用", btn && !btn.disabled, btn && btn.disabled);
  assert("渲染 2 条处理记录", d.querySelectorAll(".mock-log-row").length === 2);

  // 点击清空
  btn.dispatchEvent(new window.Event("click", { bubbles: true }));

  setTimeout(() => {
    assert("点击清空弹了确认框", confirmCount === 1, confirmCount);
    const call = calls.find((c) => c.url.indexOf("/api/mock/logs/clear") >= 0);
    assert("调用 /api/mock/logs/clear", !!call, calls.map((c) => c.url));
    assert("清空后列表为空", d.querySelectorAll(".mock-log-row").length === 0);
    assert("清空后显示空态提示", (d.getElementById("mockLogList").textContent || "").indexOf("暂无处理记录") >= 0);
    assert("清空后按钮禁用", btn.disabled);
    assert("清空后计数归零", (d.getElementById("mockLogsCount").textContent || "") === "");
    assert("运行期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));

    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  }, 120);
}, 400);
