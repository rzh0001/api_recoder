// jsdom 验证：请求库标签/备注兼容旧数据 fallback（endpoint_docs 为空时读 requests.tags/note）
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
    window.alert = () => {};
    window.prompt = () => "";
    window.fetch = (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      // 读取 endpoint_doc 时返回空 tags/note（模拟旧数据未迁移）
      if (url === "/api/endpoint/doc" && opts && opts.method === "POST" && !body.name && !body.tags && !body.req) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, doc: { name: "", note: "", tags: [], req: [], resp: [] } }), text: () => Promise.resolve("{}") });
      }
      if (url === "/api/endpoint/docs") {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, docs: [] }), text: () => Promise.resolve("{}") });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve("{}") });
    };
    window.WebSocket = class WebSocket { constructor() { setTimeout(() => this.onopen && this.onopen(), 0); } send() {} close() {} };
  },
});
const { window } = dom;
const errors = [];
window.addEventListener("error", (e) => errors.push(e.error ? e.error.stack : e.message));

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("[OK] " + name); }
  else { fail++; console.log("[FAIL] " + name + (extra ? " :: " + JSON.stringify(extra).slice(0, 300) : "")); }
}

function run() {
  // 旧数据：requests.tags / requests.note 有值，但 endpoint_docs 为空
  window.allRequests.length = 0;
  window.allRequests.push(
    {
      seq: 1, method: "POST", path: "/api/old", host: "api.example.com", registered_domain: "example.com",
      url: "https://api.example.com/api/old", query: "", resource_type: "XHR",
      request: { headers: {}, post_data: JSON.stringify({ a: 1 }) },
      response: { status: 200, body: JSON.stringify({ b: 2 }) },
      tags: ["旧标签"], note: "旧备注",
    },
    {
      seq: 2, method: "POST", path: "/api/old", host: "api.example.com", registered_domain: "example.com",
      url: "https://api.example.com/api/old", query: "", resource_type: "XHR",
      request: { headers: {}, post_data: JSON.stringify({ a: 1 }) },
      response: { status: 200, body: JSON.stringify({ b: 2 }) },
      tags: ["旧标签", "另一个"], note: "",
    },
  );

  assert("无加载期错误", errors.length === 0, errors.slice(0, 3));

  // 列表视图应显示从 requests 聚合来的 tags
  window.libState.view = "list";
  Object.assign(window.libState, { domain: "", method: "", path: "", filter: "", collapsed: {} });
  window.libState.filters = { methods: new Set(), err: false, apiOnly: true };
  const listPad = window.document.getElementById("libraryPad") || window.document.createElement("div");
  listPad.id = "libraryPad";
  if (!listPad.parentNode) window.document.body.appendChild(listPad);
  window.renderLibrary();
  setTimeout(() => {
    const row = listPad.querySelector('.lib-ep-row[data-p="/api/old"]');
    assert("列表行存在", !!row, listPad.innerHTML.slice(0, 300));
    assert("列表行 fallback 显示旧标签", row && row.textContent.includes("旧标签"), row && row.textContent);
    assert("列表行聚合多个 tags", row && row.textContent.includes("另一个"), row && row.textContent);

    // 详情视图应 fallback 回填 tags / note
    row.click();
    setTimeout(() => {
      const tagChips = Array.from(window.document.getElementById("epTags").querySelectorAll(".tag-chip")).map(c => c.textContent.replace("×", "").trim());
      assert("详情标签 fallback 显示旧标签", tagChips.includes("旧标签"), tagChips);
      assert("详情标签 fallback 显示另一个", tagChips.includes("另一个"), tagChips);
      assert("详情备注 fallback 显示旧备注", window.document.getElementById("epNote").value === "旧备注");

      console.log(`\nRESULT pass=${pass} fail=${fail}`);
      if (fail) process.exit(1);
    }, 120);
  }, 80);
}

setTimeout(run, 80);
