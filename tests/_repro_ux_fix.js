// jsdom 验收：统一数据块（JSON / 键值对同构）+ 全量复制 + 三页接口级联动
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
  url: "https://api.example.com/v1/login?from=web&t=1",
  path: "/v1/login",
  host: "api.example.com",
  registered_domain: "example.com",
  resource_type: "XHR",
  query: "from=web&t=1",
  duration_ms: 123,
  is_failed: false,
  request: {
    headers: { "Content-Type": "application/json", Authorization: "Bearer x.y.z" },
    post_data: JSON.stringify({ username: "admin", password: "123456", remember: true }),
  },
  response: {
    status: 200,
    status_text: "OK",
    mime_type: "application/json",
    size_bytes: 256,
    headers: { "Content-Type": "application/json", "Set-Cookie": "sid=abc" },
    body: JSON.stringify({ code: 0, data: { token: "tk_001", user: { id: 7, name: "张三" } }, msg: "ok" }),
  },
  timing: { dns: 1, connect: 2, ttfb: 30 },
  annotations: { req: {}, res: {} },
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
      if (opts && opts.method === "POST") calls.push({ url: u, body: opts.body || "" });
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
function body() { return d.getElementById("detailBody"); }

setTimeout(() => {
  window.allRequests.length = 0;
  window.allRequests.push(REC);
  window.renderDetail(REC);

  // ---- 1) Tab 精简 ----
  const tabs = d.querySelectorAll(".detail-tabs .tab");
  assert("详情 Tab 精简为 3 个", tabs.length === 3, Array.from(tabs).map((t) => t.getAttribute("data-tab")));

  // ---- 2) 概览：扁平信息统一为数据块 ----
  clickTab("overview");
  const blocks = body().querySelectorAll(".data-block");
  assert("概览含 5 个分区数据块（基本信息/Query/请求头/响应头/Timing）", blocks.length === 5, blocks.length);

  const blockCopies = body().querySelectorAll("[data-copy-block]");
  assert("每个数据块都有「复制全文」", blockCopies.length === blocks.length, { copies: blockCopies.length, blocks: blocks.length });

  const kvViewers = body().querySelectorAll(".kv-viewer");
  assert("5 个键值对块都走统一 kv-viewer", kvViewers.length === 5, kvViewers.length);

  const rowCopies = body().querySelectorAll("[data-copy-value]");
  assert("键值对逐行都有「复制该值」", rowCopies.length >= 7, rowCopies.length);

  // 请求头里的 Authorization 必须可单独复制
  const authBtn = Array.from(rowCopies).find((b) => b.getAttribute("data-copy-value") === "Bearer x.y.z");
  assert("请求头 Authorization 值可单独复制", !!authBtn);
  const cookieBtn = Array.from(rowCopies).find((b) => b.getAttribute("data-copy-value") === "sid=abc");
  assert("响应头 Set-Cookie 值可单独复制", !!cookieBtn);

  const oldKvTable = body().querySelectorAll("table.kv").length;
  assert("概览不再使用割裂的 kvTable 表", oldKvTable === 0, oldKvTable);

  // ---- 3) 请求页：body 数据块 + cURL ----
  clickTab("request");
  const reqViewer = body().querySelector(".json-viewer");
  assert("请求体走统一 json-viewer", !!reqViewer);
  assert("请求体块有「复制全文」", !!body().querySelector("[data-copy-block]"));
  const curlBtn = body().querySelector('[data-db-act="curl"]');
  assert("请求体块有「复制为 cURL」", !!curlBtn);
  if (curlBtn) {
    window.__copied = null;
    const origClip = window.navigator.clipboard;
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } },
      configurable: true,
    });
    curlBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    setTimeout(() => {
      const c = window.__copied || "";
      assert("cURL 含方法与 URL", c.indexOf("curl -X POST") === 0 && c.indexOf("/v1/login") > 0, c.slice(0, 60));
      assert("cURL 带上了请求体", c.indexOf("--data-raw") > 0);
      Object.defineProperty(window.navigator, "clipboard", { value: origClip, configurable: true });

      // ---- 4) 响应页 ----
      clickTab("response");
      assert("响应体走统一 json-viewer", !!body().querySelector(".json-viewer"));
      assert("响应体块有「复制全文」", !!body().querySelector("[data-copy-block]"));

      // ---- 5) 联动：录制 → 请求库 ----
      window.renderDetail(REC);
      const gotoLib = d.getElementById("gotoLibBtn");
      assert("录制详情有「请求库」入口", !!gotoLib);
      if (gotoLib) {
        gotoLib.dispatchEvent(new window.Event("click", { bubbles: true }));
        setTimeout(() => {
          const libActive = d.querySelector('.screen[data-screen="library"]').classList.contains("active");
          assert("点「请求库」跳到请求库页", libActive);
          assert("请求库定位到该接口", window.libState.path === "/v1/login" && window.libState.method === "POST",
            { path: window.libState.path, method: window.libState.method });

          // ---- 6) 联动：请求库案例 → 录制页定位 ----
          window.renderLibrary();
          const caseRow = d.querySelector(".case-row");
          if (caseRow) {
            caseRow.dispatchEvent(new window.Event("click", { bubbles: true }));
            setTimeout(() => {
              const jump = d.querySelector("[data-jump-seq]");
              assert("案例展开有「在录制中定位」", !!jump);
              const pin = d.querySelector("[data-pin-seq]");
              assert("案例展开有「固定为 Mock 返回」", !!pin);

              // ---- 7) 联动：固定到 Mock ----
              if (pin) {
                calls.length = 0;
                pin.dispatchEvent(new window.Event("click", { bubbles: true }));
                setTimeout(() => {
                  const pinCall = calls.find((c) => c.url.indexOf("/api/mock/pin") >= 0 && c.body.indexOf('"pinned":true') >= 0);
                  assert("固定动作发送 /api/mock/pin", !!pinCall, calls);
                  assert("运行期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));
                  console.log(`\nRESULT pass=${pass} fail=${fail}`);
                  process.exit(fail ? 1 : 0);
                }, 60);
              } else { finish(); }
            }, 60);
          } else { console.log("  （无案例行）"); finish(); }
        }, 60);
      } else { finish(); }
    }, 30);
  } else { finish(); }

  function finish() {
    assert("运行期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));
    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  }
}, 400);
