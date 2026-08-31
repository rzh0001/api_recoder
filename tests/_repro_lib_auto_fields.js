// jsdom 验证：请求库详情 API 信息回填 + 请求参数/响应字段自动推断
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

let fetchCalls = [];
const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.alert = (msg) => { window.__lastAlert = msg; };
    window.prompt = (msg) => window.__promptReturn || "";
    window.fetch = (url, opts) => {
      fetchCalls.push({ url, opts });
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (url === "/api/endpoint/doc" && opts && opts.method === "POST" && !body.name && !body.tags && !body.req) {
        // read request
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, doc: { name: "后端名称", note: "后端备注", tags: ["tag1"], req: [], resp: [] } }), text: () => Promise.resolve("{}") });
      }
      if (url === "/api/endpoint/doc" && opts && opts.method === "POST" && (body.name || body.tags || body.req)) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve("{}") });
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
  // build samples（必须 mutate 模块级 allRequests，不能整体替换引用）
  window.allRequests.length = 0;
  window.allRequests.push(
    {
      seq: 1, method: "POST", path: "/api/users", host: "api.example.com", registered_domain: "example.com",
      url: "https://api.example.com/api/users?page=1&size=20",
      query: "page=1&size=20",
      resource_type: "XHR",
      request: { headers: { "Content-Type": "application/json" }, post_data: JSON.stringify({ name: "Alice", age: 30, active: true, profile: { city: "BJ", zip: "100000" } }) },
      response: { status: 200, body: JSON.stringify({ id: 123, name: "Alice", success: true, result: [{ itemId: 1, itemName: "a" }, { itemId: 2, itemName: "b" }] }) },
    },
    {
      seq: 2, method: "POST", path: "/api/users", host: "api.example.com", registered_domain: "example.com",
      url: "https://api.example.com/api/users?page=1",
      query: "page=1",
      resource_type: "XHR",
      request: { headers: { "Content-Type": "application/json" }, post_data: JSON.stringify({ name: "Bob", age: 25, profile: { city: "SH" } }) },
      response: { status: 200, body: JSON.stringify({ id: 124, name: "Bob", success: true, result: [{ itemId: 3, itemName: "c" }] }) },
    },
    {
      // 同端点第 3 次捕获：格式不一致（id 变字符串、result 为空数组、profile 缺失）
      seq: 3, method: "POST", path: "/api/users", host: "api.example.com", registered_domain: "example.com",
      url: "https://api.example.com/api/users?page=2",
      query: "page=2",
      resource_type: "XHR",
      request: { headers: { "Content-Type": "application/json" }, post_data: JSON.stringify({ name: "Cid", age: 28 }) },
      response: { status: 200, body: JSON.stringify({ id: "abc", name: "Cid", result: [] }) },
    },
  );

  assert("无加载期错误", errors.length === 0, errors.slice(0, 3));

  // navigate to library detail（必须 mutate 模块级 libState，不能整体替换引用）
  Object.assign(window.libState, { view: "detail", domain: "example.com", method: "POST", path: "/api/users", filter: "", collapsed: {} });
  window.libState.filters = { methods: new Set(), err: false, apiOnly: true };
  const pad = window.document.getElementById("libraryPad") || window.document.createElement("div");
  pad.id = "libraryPad";
  if (!pad.parentNode) window.document.body.appendChild(pad);
  window.renderLibDetail(pad);

  // 按字段名取该行的 {type, required, desc}
  const fieldOf = (containerId, fieldName) => {
    let found = null;
    window.document.querySelectorAll(`#${containerId}B tr`).forEach(tr => {
      if (tr.querySelector("input[data-k='name']").value === fieldName) {
        found = {
          type: tr.querySelector("input[data-k='type']").value,
          required: tr.querySelector("input[data-k='required']").checked,
          desc: tr.querySelector("input[data-k='desc']").value,
        };
      }
    });
    return found;
  };

  // 同步检查初始渲染的标题卡片
  assert("顶部 doc-head 存在", !!window.document.querySelector(".doc-head"));
  assert("标题默认显示 path", window.document.getElementById("epTitle").textContent === "/api/users");
  assert("未填名称时路径副标题隐藏", window.document.getElementById("epTitlePath").style.display === "none");

  setTimeout(() => {
    // API 信息回填（只剩 名称 / 标签 / 备注）
    assert("名称应从后端 doc 回填", window.document.getElementById("epName").value === "后端名称");
    assert("备注应从后端 doc 回填", window.document.getElementById("epNote").value === "后端备注");
    assert("回填名称后标题应显示名称", window.document.getElementById("epTitle").textContent === "后端名称");
    assert("回填名称后路径副标题应可见", window.document.getElementById("epTitlePath").style.display === "");
    assert("路径副标题显示真实 path", window.document.getElementById("epTitlePath").textContent === "/api/users");
    const chips = Array.from(window.document.getElementById("epTags").querySelectorAll(".tag-chip")).map(c => c.textContent.replace("×", "").trim());
    assert("标签应从后端 doc 回填", chips.includes("tag1"), chips);

    // 请求参数自动推断（后端 doc.req 为空，所以用推断）
    const reqNames = Array.from(window.document.querySelectorAll("#epReqFieldsB input[data-k='name']")).map(i => i.value);
    assert("query 参数 page 应被推断", reqNames.includes("page"), reqNames);
    assert("query 参数 size 应被推断", reqNames.includes("size"), reqNames);
    assert("json body 字段 name 应被推断", reqNames.includes("name"), reqNames);
    assert("json body 字段 age 应被推断", reqNames.includes("age"), reqNames);
    assert("嵌套字段 profile.city 应被推断", reqNames.includes("profile.city"), reqNames);
    assert("嵌套字段 profile.zip 应被推断", reqNames.includes("profile.zip"), reqNames);

    const reqRows = window.document.querySelectorAll("#epReqFieldsB tr");
    let sizeRequired, nameRequired;
    reqRows.forEach(tr => {
      const name = tr.querySelector("input[data-k='name']").value;
      const checked = tr.querySelector("input[data-k='required']").checked;
      if (name === "size") sizeRequired = checked;
      if (name === "name") nameRequired = checked;
    });
    assert("size 只出现一次，不应必填", sizeRequired === false);
    assert("name 在所有样本出现，应必填", nameRequired === true);

    // 响应字段自动推断
    const respNames = Array.from(window.document.querySelectorAll("#epRespFieldsB input[data-k='name']")).map(i => i.value);
    assert("响应字段 id 应被推断", respNames.includes("id"), respNames);
    assert("响应字段 name 应被推断", respNames.includes("name"), respNames);
    assert("响应字段 success 应被推断", respNames.includes("success"), respNames);
    assert("数组元素字段 result[*].itemId 应被推断", respNames.includes("result[*].itemId"), respNames);
    assert("数组元素字段 result[*].itemName 应被推断", respNames.includes("result[*].itemName"), respNames);

    // 同端点多样本格式不一致的处理
    // 1) 类型冲突：id 在样本 1/2 是 integer、样本 3 是 string → 联合类型 integer|string
    const idField = fieldOf("epRespFields", "id");
    assert("类型冲突字段 id 应展示联合类型 integer|string", idField && idField.type === "integer|string", idField);

    // 2) 字段时有时无：profile.city 只在 2/3 个样本出现 → 不标必填 + 说明里标出现率
    const cityField = fieldOf("epReqFields", "profile.city");
    assert("profile.city 只出现 2/3，不应标必填", cityField && cityField.required === false, cityField);
    assert("profile.city 说明应标注出现率 2/3", cityField && cityField.desc === "出现 2/3 次", cityField);

    // 3) 数组多元素不放大出现次数：result[*].itemId 虽有多个元素，仍按样本去重 → 2/3
    const itemIdField = fieldOf("epRespFields", "result[*].itemId");
    assert("result[*].itemId 按样本去重统计为 2/3", itemIdField && itemIdField.desc === "出现 2/3 次", itemIdField);

    // 4) 稳定字段（id 在 3/3 样本出现）→ 标必填且不写出现率
    assert("id 在所有样本出现，应标必填", idField && idField.required === true, idField);
    assert("id 为稳定字段，说明不写出现率", idField && idField.desc === "", idField);

    // 案例展开 UI：点击案例行应出现录制界面同款 tab 视图
    const caseRow = window.document.querySelector('.case-row[data-seq="1"]');
    assert("案例行存在", !!caseRow);
    caseRow.click();
    const detailRow = window.document.getElementById("cd-1");
    assert("点击后案例详情行展开", detailRow && detailRow.style.display !== "none", detailRow && detailRow.style.display);
    assert("案例详情包含 tab 栏", detailRow.querySelector(".detail-tabs") !== null, detailRow.innerHTML.slice(0, 200));
    assert("案例详情包含详情体", detailRow.querySelector(".detail-body") !== null);
    assert("默认显示概览 tab 内容", detailRow.textContent.includes("URL"));

    // 切换响应体 tab
    const resBodyTab = Array.from(detailRow.querySelectorAll(".tab")).find((el) => el.textContent.trim() === "响应体");
    assert("响应体 tab 存在", !!resBodyTab);
    resBodyTab.click();
    assert("响应体 tab 切出 JSON 渲染内容", detailRow.textContent.includes("Alice"), detailRow.textContent.slice(0, 300));

    // 保存应发 /api/endpoint/doc 且包含推断的 req/resp
    window.document.getElementById("epSave").click();
    const saveCall = fetchCalls.find(c => c.url === "/api/endpoint/doc" && c.opts && c.opts.method === "POST" && JSON.parse(c.opts.body || "{}").name === "后端名称");
    assert("保存应调用 /api/endpoint/doc", !!saveCall);
    const saved = JSON.parse(saveCall.opts.body);
    assert("保存时应包含推断的请求参数 page", saved.req && saved.req.some(f => f.name === "page"), saved.req);
    assert("保存时应包含推断的响应字段 id", saved.resp && saved.resp.some(f => f.name === "id"), saved.resp);

    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    if (fail) process.exit(1);
  }, 100);
}

setTimeout(run, 80);
