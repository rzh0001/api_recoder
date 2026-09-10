// jsdom 验证：JSON / 键值对组件「最大化」——点 ⛶ 在弹窗里全尺寸克隆展示
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const APIS = {
  ok: true,
  running: true,
  url: "http://127.0.0.1:1/",
  apis: [
    { seq: 1, method: "GET", path: "/api/x", query: "", status: 200, mock_pin: false, hits: 2, body_preview: '{"v":{"x":1}}', req_body_preview: '{"q":{"y":9}}', body_pretty: '{\n  "v": {\n    "x": 1\n  }\n}', req_body_pretty: '{\n  "q": {\n    "y": 9\n  }\n}', note: "", tags: [] },
  ],
};

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url, opts) => {
      const u = typeof url === "string" ? url : "";
      let body = { ok: true };
      if (u.indexOf("/api/mock/apis") >= 0) body = APIS;
      else if (u.indexOf("/api/mock/status") >= 0) body = { running: true, url: APIS.url, count: APIS.apis.length };
      else if (u.indexOf("/api/mock/logs") >= 0) body = { running: true, logs: [] };
      else if (u.indexOf("/api/status") >= 0) body = { status: "idle" };
      else if (u.indexOf("/api/config") >= 0) body = { ok: true, match_mode: true };
      else if (u.indexOf("/api/endpoint/") >= 0) body = { ok: true, docs: [] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    };
    window.alert = () => {};
    window.prompt = () => null;
    window.navigator.clipboard = { writeText: () => Promise.resolve() };
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

  // 切到 mock tab → 渲染 → 展开一张卡暴露 .mock-card-code
  document.querySelector('[data-go="mock"]').dispatchEvent(new window.Event("click", { bubbles: true }));

  setTimeout(() => {
    const list = document.getElementById("mockApiList");
    const card = list.querySelector(".mock-api-card");
    assert("mock 列表渲染出记录卡", !!card);

    // mock card 有 ⛶ 按钮（请求体 + 返回体 各一个）
    const cardMaxBtns = card.querySelectorAll(".mock-card-max");
    assert("记录卡含 2 个 ⛶（请求体/返回体）", cardMaxBtns.length === 2, cardMaxBtns.length);

    // 展开卡 → 展开返回体 code
    card.querySelector(".mock-api-card-head").dispatchEvent(new window.Event("click", { bubbles: true }));
    const resSummary = card.querySelector(".mock-res-summary");
    resSummary.dispatchEvent(new window.Event("click", { bubbles: true }));
    const resCode = card.querySelector(".mock-res-code");
    assert("返回体 code 已显示（display:block）", resCode.style.display === "block");
    assert("返回体 code 含 .json-viewer", !!resCode.querySelector(".json-viewer"));
    const srcRaw = resCode.querySelector(".json-viewer").getAttribute("data-raw");

    // 点击返回体 ⛶ → 打开最大化弹窗
    card.querySelector(".mock-res-section .mock-card-max").dispatchEvent(new window.Event("click", { bubbles: true }));
    const modal = document.getElementById("jsonMaxModal");
    assert("点击 ⛶ → #jsonMaxModal 显示（无 .hide）", !modal.classList.contains("hide"));
    const clone = document.querySelector("#jsonMaxBody .json-viewer");
    assert("弹窗内含克隆 .json-viewer", !!clone);
    assert("克隆体 data-raw 与源一致", clone && clone.getAttribute("data-raw") === srcRaw, clone && clone.getAttribute("data-raw"));
    assert("弹窗标题取自 section-title（返回体）", document.getElementById("jsonMaxTitle").textContent.indexOf("返回体") >= 0);

    // 克隆体仍保留折叠按钮（全局委托可继续交互）
    assert("克隆体保留 .json-fold 折叠按钮", !!clone.querySelector(".json-fold"));

    // 关闭（×）→ 弹窗隐藏且内容清空
    document.getElementById("jsonMaxClose").dispatchEvent(new window.Event("click", { bubbles: true }));
    assert("点 × → #jsonMaxModal 隐藏", modal.classList.contains("hide"));
    assert("关闭后 #jsonMaxBody 已清空", document.getElementById("jsonMaxBody").innerHTML === "");

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
