// jsdom 验收：v3 接口为中心外壳
// - 接口台账页签按 method+path 汇总；点接口进工作台（样本/字段/文档 三页签）
// - 中栏页签：请求历史 | 接口台账 | Mock | 导出；Mock 为中栏页签，不再在工作台内
// - 顶栏药丸：录制/Mock/待造；抽屉：处理记录/收件箱/造数据/导出/设置
// - 复用 app.js 既有能力（DataBlock/inferEndpointDoc/loadEndpointDoc/renderMockApis）
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const v3 = fs.readFileSync(path.join(ROOT, "static/v3.js"), "utf8");
const htmlWithScripts = html.replace("</body>", `<script>${app}</script><script>${v3}</script></body>`);

const RECS = [
  { seq: 1, method: "POST", url: "https://a.example.com/api/login", path: "/api/login", host: "a.example.com", registered_domain: "example.com", resource_type: "XHR", query: "", is_failed: false,
    request: { headers: { "Content-Type": "application/json" }, post_data: '{"username":"admin","password":"1"}' },
    response: { status: 200, status_text: "OK", headers: { "Content-Type": "application/json" }, body: '{"code":0,"token":"abc"}' } },
  { seq: 2, method: "POST", url: "https://a.example.com/api/login", path: "/api/login", host: "a.example.com", registered_domain: "example.com", resource_type: "XHR", query: "", is_failed: false,
    request: { headers: {}, post_data: '{"username":"bob","password":"2"}' },
    response: { status: 200, status_text: "OK", headers: {}, body: '{"code":0,"token":"xyz"}' } },
  { seq: 3, method: "GET", url: "https://a.example.com/api/user/list", path: "/api/user/list", host: "a.example.com", registered_domain: "example.com", resource_type: "XHR", query: "page=1",
    is_failed: false, request: { headers: {}, post_data: null }, response: { status: 200, status_text: "OK", headers: {}, body: '{"list":[{"id":1}]}' } },
];

const MOCK_APIS = { ok: true, data: { url: "http://127.0.0.1:9000", apis: [{ seq: 1, method: "POST", path: "/api/login", query: "", status: 200, mock_pin: true, hits: 3, body_preview: '{"code":0}', req_body_preview: '{"username":"admin"}' }] } };
const LOGS = { ok: true, running: true, logs: [
  { ts: Date.now() / 1000, method: "GET", path: "/api/missing", query: "id=9", url: "/api/missing?id=9", matched: false, miss_reason: "无可匹配的固定响应", status: 404, req_headers: {}, req_body: "", res_headers: {}, res_body: "{}" },
  { ts: Date.now() / 1000, method: "GET", path: "/api/user/list", query: "page=1", url: "/api/user/list?page=1", matched: true, miss_reason: null, status: 200, req_headers: {}, req_body: "", res_headers: {}, res_body: '{"list":[{"id":1}]}' },
] };

const jsErrors = [];
const postCalls = [];
const dom = new JSDOM(htmlWithScripts, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url) => {
      const u = typeof url === "string" ? url : "";
      let data = { ok: true };
      if (u.indexOf("/api/request/") >= 0) { const seq = Number(u.split("/").pop()); data = RECS.find((r) => r.seq === seq) || { ok: false }; }
      else if (u.indexOf("/api/endpoint/doc") >= 0) data = { ok: true, doc: { name: "", note: "", tags: [], req: [], resp: [] } };
      else if (u.indexOf("/api/mock/logs") >= 0) data = LOGS;
      else if (u.indexOf("/api/mock/status") >= 0) data = { ok: true, running: false, url: "", count: 0 };
      else if (u.indexOf("/api/config") >= 0) data = { ok: true, match_mode: true, saved_port: 8000, mock_port: 9000 };
      else if (u.indexOf("/api/status") >= 0) data = { ok: true, running: false };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    window.postJSON = null;
    window.alert = () => {}; window.prompt = () => null;
    window.WebSocket = function () { this.send = () => {}; this.close = () => {}; };
    window.addEventListener("error", (e) => jsErrors.push(e.error ? e.error.stack : e.message));
    const of = window.fetch;
    window.fetch = (url, opts) => {
      if (opts && opts.method === "POST") {
        const u = typeof url === "string" ? url : "";
        postCalls.push({ url: u, body: opts.body || "" });
        if (u.indexOf("/api/mock/apis") >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(MOCK_APIS) });
        if (u.indexOf("/api/mock/logs") >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(LOGS) });
        if (u.indexOf("/api/endpoint/doc") >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, doc: { name: "", note: "", tags: [], req: [], resp: [] } }) });
        if (u.indexOf("/api/mock/make") >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, seq: 99 }) });
        if (u.indexOf("/api/mock/pin") >= 0) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      }
      return of(url, opts);
    };
  },
});
const { window } = dom;
const d = window.document;
const el = (id) => d.getElementById(id);
function click(e) { if (e) e.dispatchEvent(new window.Event("click", { bubbles: true })); }

let pass = 0, fail = 0;
function assert(n, c, x) { if (c) { pass++; console.log("[OK] " + n); } else { fail++; console.log("[FAIL] " + n + (x !== undefined ? " :: " + JSON.stringify(x) : "")); } }

setTimeout(() => {
  assert("加载期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));

  // 顶栏药丸
  assert("顶栏四药丸存在", !!el("recChip") && !!el("mockChip") && !!el("inboxChip") && !!el("menuChip"));
  assert("接口台账容器存在", !!el("epList") && !!el("listSearch"));
  assert("中栏各页签面板存在", !!el("paneHistory") && !!el("paneLedger") && !!el("paneMock") && !!el("paneExport") && !!el("workView"));
  assert("抽屉齐备", !!el("logsDrawer") && !!el("inboxDrawer") && !!el("makeDrawer") && !!el("exportDrawer") && !!el("settingsDrawer"));
  assert("默认展示请求历史（工作台隐藏）", !el("paneHistory").classList.contains("hide") && el("workView").classList.contains("hide"));

  // 注入快照 → 接口台账
  window.allRequests.length = 0;
  RECS.forEach((r) => window.allRequests.push(r));
  window.renderList();
  const rows = d.querySelectorAll("#epList .ep-row");
  assert("接口台账按 method+path 汇总出 2 个接口", rows.length === 2, rows.length);
  const loginRow = Array.from(rows).find((r) => r.getAttribute("data-p") === "/api/login");
  assert("login 接口行含 method 徽标与样本数", !!loginRow && loginRow.querySelector(".method-badge").textContent === "POST" && loginRow.textContent.indexOf("样本 2") >= 0, loginRow && loginRow.textContent);

  // 点接口 → 工作台
  click(loginRow);
  assert("工作台显示、台账列表隐藏", !el("workView").classList.contains("hide") && el("ledgerList").classList.contains("hide"));
  assert("工作台标题为选中接口", el("viewTitle").textContent === "POST /api/login", el("viewTitle").textContent);
  const tabs = d.querySelectorAll("#workView .work-tab");
  assert("工作台三页签齐备", tabs.length === 3, tabs.length);
  assert("默认样本页签：列出 2 条样本", d.querySelectorAll("#epSamples .sample-row").length === 2, d.querySelectorAll("#epSamples .sample-row").length);
  assert("样本页签右侧详情已渲染（含 DataBlock）", !!d.querySelector("#epDetail .data-block"));

  // 字段页签
  click(d.querySelector('#workView .work-tab[data-wtab="fields"]'));
  assert("字段页签渲染字段表", !!d.querySelector("#workBody .field-table") || !!d.querySelector("#workBody .empty"), !!d.querySelector("#workBody"));

  // 文档页签
  click(d.querySelector('#workView .work-tab[data-wtab="doc"]'));
  assert("文档页签渲染编辑区", !!el("epName") && !!el("epNote") && !!el("epTags") && !!el("epDocSave"));

  // Mock：中栏页签（Mock 处理流水；数据源 = /api/mock/logs）
  click(d.querySelector('[data-ctab="mock"]'));
  assert("Mock 中栏页签渲染流水容器", !!el("mockStream"));
  const msRows = d.querySelectorAll("#mockStream .mock-stream-row");
  assert("Mock 流水按处理记录逐条显示（LOGS 2 条）", msRows.length === 2, msRows.length);
  const msFirst = msRows[0];
  assert("流水行含 method 徽标与状态", !!msFirst.querySelector(".method-badge") && !!msFirst.querySelector(".mock-stream-status"), msFirst && msFirst.textContent);
  assert("未命中的记录带「未命中」徽标", !!msFirst.querySelector(".mock-stream-pin"), msFirst && msFirst.textContent);
  assert("流水行含「指定返回」「造数据」按钮", !!msFirst.querySelector(".ms-pin") && !!msFirst.querySelector(".ms-make"));
  click(msFirst.querySelector(".mock-stream-head"));
  assert("点流水行可展开（含未命中原因/响应体）", msFirst.classList.contains("expanded") && !!msFirst.querySelector(".mock-stream-code"));
  assert("Mock 头部有「清空记录」按钮", !!el("mockPaneClear"));

  // 返回总览
  click(el("workCloseBtn"));
  assert("返回后台账列表恢复", !el("ledgerList").classList.contains("hide") && el("workView").classList.contains("hide"));

  // 待造数据：mock 日志里的 404 miss → 药丸与收件箱
  window.renderHead();
  assert("存在未命中 → 待造药丸显示", !el("inboxChip").classList.contains("hide"), el("inboxChipTxt").textContent);
  click(el("inboxChip"));
  assert("收件箱抽屉打开且列出未命中", !el("inboxDrawer").classList.contains("hide") && d.querySelectorAll("#inboxList .inbox-row").length >= 1, d.querySelectorAll("#inboxList .inbox-row").length);

  // 造数据抽屉（从收件箱一键）
  const makeBtn = d.querySelector("#inboxList .inbox-make");
  click(makeBtn);
  assert("造数据抽屉打开并预填路径", !el("makeDrawer").classList.contains("hide") && el("makePath").value === "/api/missing", el("makePath") && el("makePath").value);
  assert("造数据预填 query", el("makeQuery").value === "id=9", el("makeQuery") && el("makeQuery").value);
  assert("造数据有保存按钮", !!el("makeSave"));

  // 提交造数据 → POST /api/mock/make（body 带 method/path/query/res_status/res_body）
  postCalls.length = 0;
  el("makeResBody").value = '{"ok":true,"made":1}';
  click(el("makeSave"));
  assert("保存为 Mock 发出 /api/mock/make", postCalls.some((c) => c.url.indexOf("/api/mock/make") >= 0), postCalls);
  const mkCall = postCalls.find((c) => c.url.indexOf("/api/mock/make") >= 0);
  assert("造数据 body 带 method/path/query", !!mkCall && /"method":"GET"/.test(mkCall.body) && /"path":"\/api\/missing"/.test(mkCall.body) && /"query":"id=9"/.test(mkCall.body), mkCall && mkCall.body);
  assert("造数据 body 带 res_status/res_body", !!mkCall && /"res_status":200/.test(mkCall.body) && /made/.test(mkCall.body), mkCall && mkCall.body);

  // 台账筛选：仅 API / 仅错误
  assert("台账有「仅 API」「仅错误」筛选片", !!el("railApiOnly") && !!el("railErrors"));
  click(el("railApiOnly"));
  window.renderList();
  assert("开启仅错误后仍能渲染（不崩）", d.querySelectorAll("#epList .ep-row").length >= 0);
  click(el("railApiOnly")); // 复位
  window.renderList();

  // 已录制的 4xx（非实时 mock miss）也应进入「待造数据」收件箱
  window.allRequests.push({ seq: 99, method: "GET", url: "https://a.example.com/api/record404", path: "/api/record404", host: "a.example.com", registered_domain: "example.com", resource_type: "XHR", query: "x=1", is_failed: false,
    request: { headers: {}, post_data: null }, response: { status: 404, status_text: "Not Found", headers: {}, body: '{"error":"not found"}' } });
  window.__mockApis = [];
  postCalls.length = 0;
  window.renderHead();
  assert("录制的 404 使待造药丸显示", !el("inboxChip").classList.contains("hide"), el("inboxChipTxt").textContent);
  click(el("inboxChip"));
  const recRows = Array.from(d.querySelectorAll("#inboxList .inbox-row"));
  const rec404 = recRows.find((r) => r.querySelector(".inbox-path") && r.querySelector(".inbox-path").textContent === "/api/record404");
  assert("收件箱含已录制 404 条目", !!rec404, recRows.map((r) => r.textContent));
  if (rec404) {
    click(rec404.querySelector(".inbox-make"));
    assert("录制 404 → 造数据预填路径", !el("makeDrawer").classList.contains("hide") && el("makePath").value === "/api/record404", el("makePath") && el("makePath").value);
    assert("录制 404 → 造数据预填 query", el("makeQuery").value === "x=1", el("makeQuery") && el("makeQuery").value);
  }
  // 200 的正常请求不应混入待造数据
  window.__mockApis = [];
  window.renderHead();
  const okRows = Array.from(d.querySelectorAll("#inboxList .inbox-row"));
  assert("正常 200 请求不进待造数据", !okRows.some((r) => r.querySelector(".inbox-path") && r.querySelector(".inbox-path").textContent === "/api/login"), okRows.map((r) => r.textContent));

  // 请求历史详情（legacy #detail）也应有一键「造数据」
  window.renderDetail({ seq: 99, method: "GET", url: "https://a.example.com/api/record404", path: "/api/record404", host: "a.example.com", registered_domain: "example.com", resource_type: "XHR", query: "x=1",
    request: { headers: {}, post_data: "" }, response: { status: 404, status_text: "Not Found", headers: {}, body: '{"error":"not found"}' } });
  assert("请求历史详情渲染出「造数据」按钮", !!el("makeDataBtn"), el("detail").innerHTML.slice(0, 80));
  click(el("makeDataBtn"));
  assert("点「造数据」打开造数据抽屉并预填", !el("makeDrawer").classList.contains("hide") && el("makePath").value === "/api/record404", el("makePath") && el("makePath").value);

  // 导出 / 设置：导出改为中栏页签，设置仍为抽屉
  click(el("menuChip"));
  click(el("menuExport"));
  assert("导出中栏页签打开且渲染 exportPad", !el("paneExport").classList.contains("hide") && el("exportPad").innerHTML.length > 0);
  click(el("menuChip"));
  click(el("menuSettings"));
  assert("设置抽屉打开且渲染 settingsPad", !el("settingsDrawer").classList.contains("hide") && el("settingsPad").innerHTML.length > 0);

  assert("运行期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));
  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}, 500);
