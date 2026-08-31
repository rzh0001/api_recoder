// jsdom 真实加载验证：统一数据模型 + 解除互斥 的前端行为
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
    const fetchCalls = [];
    window.__fetchCalls = fetchCalls;
    window.fetch = (url, opts) => {
      // 与真实后端返回形状一致（postJSON 已包一层 {ok,data}，故此处直接是业务体）
      let body = { ok: true, doc: { tags: [], note: "" } };
      if (typeof url === "string" && url.indexOf("/api/endpoint/docs") >= 0) {
        body = { ok: true, docs: [{ method: "GET", path: "/api/a", tags: ["cache-tag"], note: "cached" }] };
      }
      fetchCalls.push({ url, opts });
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    };
    let wsInstance = null;
    window.__getWs = () => wsInstance;
    window.WebSocket = class {
      constructor(u) { wsInstance = this; this.url = u; if (this.onopen) setTimeout(() => this.onopen(), 0); }
      close() {} send() {}
    };
    window.alert = () => {};
    window.prompt = () => null;
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

function run() {
  const fetchCalls = window.__fetchCalls;
  const ws = window.__getWs();

  assert("无加载期错误", errors.length === 0, errors.slice(0, 3));

  if (ws && ws.onmessage) {
    ws.onmessage({
      data: JSON.stringify({
        type: "snapshot",
        requests: [
          { seq: 1, method: "GET", path: "/api/a", url: "https://h.com/api/a", resource_type: "XHR",
            host: "h.com", registered_domain: "h.com", response: { status: 200, body: "{}", body_size: 2, size_bytes: 2 },
            request: {}, tags: ["old"], annotations: {}, captured_at: 1 },
        ],
        status: {}, stats: {},
      }),
    });
  }
  assert("snapshot 填充后树已渲染", !!document.querySelector(".nav-item"));

  try { window.applyLocks(); assert("applyLocks 可执行且不抛错", true); }
  catch (e) { assert("applyLocks 可执行且不抛错", false, e.message); }

  window.openDetail(1);
  const noteInput = document.getElementById("markNoteInput");
  const tagsInput = document.getElementById("markTagsInput");
  assert("录制详情含接口级备注输入 markNoteInput", !!noteInput);
  assert("录制详情含接口级标签输入 markTagsInput", !!tagsInput);
  const docLoadCall = fetchCalls.find((c) => typeof c.url === "string" && c.url.indexOf("/api/endpoint/doc") >= 0 && c.opts && c.opts.body &&
    JSON.parse(c.opts.body).method === "GET" && JSON.parse(c.opts.body).path === "/api/a" && !("tags" in JSON.parse(c.opts.body)));
  assert("打开详情时按 method+path 拉取接口文档（只读）", !!docLoadCall, fetchCalls.map((c) => c.url));

  if (tagsInput) tagsInput.value = "x, y";
  if (noteInput) noteInput.value = "接口备注ABC";
  const saveBtn = document.getElementById("markSaveBtn");
  if (saveBtn) saveBtn.click();
  const saveCall = fetchCalls.find((c) => {
    if (typeof c.url !== "string" || c.url.indexOf("/api/endpoint/doc") < 0) return false;
    const b = JSON.parse(c.opts.body || "{}");
    return b.method === "GET" && b.path === "/api/a" && Array.isArray(b.tags) && b.note === "接口备注ABC";
  });
  assert("保存走 /api/endpoint/doc 且带 tags+note（接口级，与请求库共享）", !!saveCall, fetchCalls.map((c) => c.url));
  const oldMarkCall = fetchCalls.find((c) => typeof c.url === "string" && c.url.indexOf("/api/request/mark") >= 0);
  assert("不再调用废弃的 /api/request/mark", !oldMarkCall);

  window.renderLibrary();
  const outline = document.getElementById("libOutline");
  assert("请求库目录已渲染", !!outline && outline.children.length > 0);
  const docsCall = fetchCalls.find((c) => typeof c.url === "string" && c.url.indexOf("/api/endpoint/docs") >= 0);
  assert("进入请求库时批量拉取 /api/endpoint/docs", !!docsCall);

  return new Promise((res) => setTimeout(() => {
    const listHtml = (document.getElementById("libraryPad") || {}).innerHTML || "";
    assert("列表渲染了接口文档缓存标签（cache-tag）", listHtml.indexOf("cache-tag") >= 0, listHtml.slice(0, 120));
    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    if (fail) process.exit(1);
    res();
  }, 80));
}

setTimeout(run, 80);
