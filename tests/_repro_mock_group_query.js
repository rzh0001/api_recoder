// jsdom 验证：Mock 列表三级折叠（接口 → query → 记录）+ 默认按钮在记录级 + 限高
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
    { seq: 1, method: "GET", path: "/api/x", query: "",      status: 200, mock_pin: false, hits: 2, body_preview: '{"v":1}', req_body_preview: "", body_pretty: '{"v":1}', req_body_pretty: "", note: "", tags: [] },
    { seq: 2, method: "GET", path: "/api/x", query: "",      status: 200, mock_pin: true,  hits: 5, body_preview: '{"v":2}', req_body_preview: "", body_pretty: '{"v":2}', req_body_pretty: "", note: "默认那条", tags: ["main"] },
    { seq: 3, method: "GET", path: "/api/x", query: "a=9",   status: 200, mock_pin: false, hits: 0, body_preview: '{"v":3}', req_body_preview: "", body_pretty: '{"v":3}', req_body_pretty: "", note: "", tags: [] },
    { seq: 4, method: "GET", path: "/api/y", query: "",      status: 404, mock_pin: false, hits: 1, body_preview: '{"err":1}', req_body_preview: "", body_pretty: '{"err":1}', req_body_pretty: "", note: "", tags: [] },
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

  // 切到 mock tab → 拉 apis → 渲染
  document.querySelector('[data-go="mock"]').dispatchEvent(new window.Event("click", { bubbles: true }));

  setTimeout(() => {
    const list = document.getElementById("mockApiList");
    const groups = list.querySelectorAll(".mock-group");
    assert("渲染 2 个 mock-group（按 method+path 分）", groups.length === 2);

    const xGroup = Array.from(groups).find((g) => g.querySelector(".mock-group-path").textContent === "/api/x");
    assert("存在 /api/x 组", !!xGroup);
    if (xGroup) {
      assert("/api/x 组头：显示方法", !!xGroup.querySelector(".method-badge"));
      assert("/api/x 组头：路径", !!xGroup.querySelector(".mock-group-path"));
      assert("/api/x 组头：数量 = 3 条 / 2 个 query", xGroup.querySelector(".mock-group-count").textContent === "3 条 / 2 个 query");
      const badge = xGroup.querySelector(".pin-badge");
      assert("/api/x 组头：已默认 badge 显示「已默认 1 条」", badge && badge.textContent === "已默认 1 条");
      assert("/api/x 组头：唯一默认 title 提示整接口固定", badge && badge.getAttribute("title").indexOf("整接口已固定") >= 0);

      const queries = xGroup.querySelectorAll(".mock-query-item");
      assert("/api/x 下有 2 个 query 子项", queries.length === 2);

      const q0 = Array.from(queries).find((q) => !q.getAttribute("data-qkey"));
      assert("存在空 query 子项", !!q0);
      if (q0) {
        const cards = q0.querySelectorAll(".mock-api-card");
        assert("空 query 子项下 2 张记录卡", cards.length === 2);
        const pinned = q0.querySelector(".mock-api-card.pinned");
        assert("mock_pin 卡片 .pinned class", !!pinned && pinned.getAttribute("data-seq") === "2");
        const pinTip = q0.querySelector(".mock-query-pin-tip");
        assert("query 子项显示「默认 200 · {...}」", pinTip && /默认\s*200/.test(pinTip.textContent));
      }

      const qa9 = Array.from(queries).find((q) => q.getAttribute("data-qkey") === "a=9");
      assert("存在 query=a=9 子项", !!qa9);
      if (qa9) {
        const pinTip = qa9.querySelector(".mock-query-pin-tip.muted");
        assert("query=a=9 子项显示「未默认」", !!pinTip);
      }
    }

    const yGroup = Array.from(groups).find((g) => g.querySelector(".mock-group-path").textContent === "/api/y");
    assert("/api/y 组：1 条 / 1 个 query", yGroup && yGroup.querySelector(".mock-group-count").textContent === "1 条 / 1 个 query");
    assert("/api/y 组：未默认（无 pin-badge）", yGroup && !yGroup.querySelector(".pin-badge"));

    // 默认按钮在每条记录（mock-pin-one）
    const pinBtns = list.querySelectorAll(".mock-pin-one");
    assert("4 张记录卡共 4 个「默认」按钮", pinBtns.length === 4);
    assert("pinned 卡片按钮文案 = 取消默认", Array.from(pinBtns).find((b) => b.getAttribute("data-seq") === "2").textContent === "取消默认");

    // 命中次数徽标（每张卡一个，取各自 hits）
    const hitBadges = list.querySelectorAll(".mock-hit-badge");
    assert("4 张记录卡共 4 个命中徽标", hitBadges.length === 4);
    const hitBySeq = {};
    hitBadges.forEach((b) => {
      const card = b.closest(".mock-api-card");
      hitBySeq[card.getAttribute("data-seq")] = b.textContent;
    });
    assert("seq2 显示「命中 5」", hitBySeq["2"] === "命中 5", hitBySeq);
    assert("seq4 显示「命中 1」", hitBySeq["4"] === "命中 1", hitBySeq);
    assert("seq3 显示「命中 0」", hitBySeq["3"] === "命中 0", hitBySeq);

    // 默认全部折叠
    const allGroups = list.querySelectorAll(".mock-group");
    assert("所有 group 默认折叠（无 .expanded）", Array.from(allGroups).every((g) => !g.classList.contains("expanded")));
    assert("所有 query 默认折叠（无 .expanded）", Array.from(list.querySelectorAll(".mock-query-item")).every((q) => !q.classList.contains("expanded")));
    assert("所有卡 body 默认折叠（display:none 或 ''）", Array.from(list.querySelectorAll(".mock-api-card-body")).every((b) => b.style.display === "none" || b.style.display === ""));

    // 点击 /api/x 组头展开
    const xHead = xGroup.querySelector(".mock-group-head");
    xHead.dispatchEvent(new window.Event("click", { bubbles: true }));
    assert("点击组头 → 组 .expanded", xGroup.classList.contains("expanded"));

    // 点击 /api/x 下空 query 头展开
    const emptyQ = xGroup.querySelector('.mock-query-item[data-qkey=""]').querySelector(".mock-query-head");
    emptyQ.dispatchEvent(new window.Event("click", { bubbles: true }));
    const emptyQItem = emptyQ.closest(".mock-query-item");
    assert("点击空 query 头 → .mock-query-item.expanded", emptyQItem.classList.contains("expanded"));

    // 点击某条卡头展开详情
    const cardHead = emptyQItem.querySelector(".mock-api-card-head");
    cardHead.dispatchEvent(new window.Event("click", { bubbles: true }));
    const cardBody = emptyQItem.querySelector(".mock-api-card-body");
    assert("点击卡头 → body display block", cardBody.style.display === "block");
    const toggle = cardHead.querySelector(".mock-expand-toggle");
    assert("点击卡头 → toggle 文字 ▲", toggle.textContent === "▲");

    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  }, 200);
}, 120);