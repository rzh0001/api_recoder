// jsdom 验收：JSON 组件通用能力 —— 最大化后的「对比」
// - 对比面板默认收起，点最大化弹窗顶部「对比」按钮才展开（再点收起）
// - 左右两栏是同一个 JSON 组件（.json-viewer），等高并排
// - 两种模式：按字段（默认） / 按行
// - 差异直接高亮在左右两个 JSON 区里（不另开差异清单）
// - 任何能最大化的 JSON 区都能用；键值对（请求头）没有对比按钮
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "static/styles.css"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const REQ_BODY = JSON.stringify({
  username: "admin",
  password: "123456",
  remember: true,
  extra: { device: "pc", ip: "10.0.0.7" },
}, null, 2);

const REC = {
  seq: 1,
  method: "POST",
  url: "https://api.example.com/v1/login",
  path: "/v1/login",
  host: "api.example.com",
  registered_domain: "example.com",
  resource_type: "XHR",
  query: "",
  duration_ms: 12,
  is_failed: false,
  request: { headers: { "Content-Type": "application/json" }, post_data: REQ_BODY },
  response: {
    status: 200, status_text: "OK", mime_type: "application/json",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: 0, msg: "ok" }),
    body_size: 20, size_bytes: 20,
  },
  timing: {},
  annotations: { req: {}, res: {} },
};

const jsErrors = [];
const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url) => {
      const u = typeof url === "string" ? url : "";
      let data = { ok: true };
      if (u.indexOf("/api/request/") >= 0) data = REC;
      else if (u.indexOf("/api/endpoint/doc") >= 0) data = { ok: true, doc: { name: "", note: "", tags: [], req: [], resp: [] } };
      else if (u.indexOf("/api/mock/logs") >= 0) data = { ok: true, logs: [] };
      else if (u.indexOf("/api/config") >= 0) data = { ok: true, port: 8080, match_mode: true };
      else if (u.indexOf("/api/status") >= 0) data = { ok: true, running: false };
      else if (u.indexOf("/api/mock/status") >= 0) data = { ok: true, running: false, url: "", count: 0 };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    window.alert = () => {};
    window.prompt = () => null;
    window.WebSocket = function () { this.send = () => {}; this.close = () => {}; };
    window.addEventListener("error", (e) => jsErrors.push(e.error ? e.error.stack : e.message));
  },
});
const { window } = dom;
const d = window.document;

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("[OK] " + name); }
  else { fail++; console.log("[FAIL] " + name + (extra ? " :: " + JSON.stringify(extra) : "")); }
}
function click(el) { if (el) el.dispatchEvent(new window.Event("click", { bubbles: true })); }
function clickTab(key) { click(d.querySelector(`.detail-tabs .tab[data-tab="${key}"]`)); }
function maxBtnFor(title) {
  const blk = Array.from(d.querySelectorAll("#detailBody .data-block")).find((b) => {
    const t = b.querySelector(".db-title");
    return t && t.textContent.trim() === title;
  });
  return blk ? blk.querySelector(".db-max") : null;
}
const el = (id) => d.getElementById(id);
const pane = () => el("jsonMaxCompare");
const headBtn = () => el("jsonMaxCompareBtn");
const leftViewer = () => el("jsonMaxBody").querySelector(".json-viewer");
const rightViewer = () => el("jsonMaxCompareView").querySelector(".json-viewer");
function marks(viewer, cls) { return viewer.querySelectorAll(".json-line." + cls).length; }
function runCompare(rightText) {
  el("jsonMaxCompareInput").value = rightText;
  click(el("jsonMaxCompareRun"));
}
const stat = () => el("jsonMaxCompareStat").textContent || "";

const SAMPLE = JSON.stringify({
  username: "admin",
  password: "newpass",
  extra: { device: "pc" },
  captcha: "9999",
}, null, 2);

setTimeout(() => {
  assert("加载期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 2));
  assert("旧的差异清单容器已移除", el("jsonMaxCompareResult") === null);
  assert("对比区两栏等高布局（flex 1 1 50% × 2）", (css.match(/flex:\s*1 1 50%/g) || []).length >= 2);

  window.allRequests.length = 0;
  window.allRequests.push(REC);
  window.renderDetail(REC);

  // ---- 请求体最大化：对比面板默认收起 ----
  clickTab("request");
  click(maxBtnFor("请求体"));
  assert("最大化弹窗打开", !el("jsonMaxModal").classList.contains("hide"));
  assert("标题为请求体", el("jsonMaxTitle").textContent === "请求体");
  assert("左侧渲染 JSON viewer", !!leftViewer());
  assert("对比面板默认收起", pane().classList.contains("hide"));
  assert("顶部对比按钮可用（文案=对比）",
    !headBtn().classList.contains("hide") && headBtn().textContent === "对比");

  // ---- 点顶部按钮展开 ----
  click(headBtn());
  assert("点对比 → 面板展开", !pane().classList.contains("hide"));
  assert("展开后共享工具栏也显示", !el("jsonMaxBar").classList.contains("hide"));
  assert("展开后按钮变为收起对比", headBtn().textContent === "收起对比" && headBtn().classList.contains("is-active"));
  assert("对比区初始为编辑态（textarea 可见）", !el("jsonMaxCompareInput").classList.contains("hide"));
  assert("默认模式为按字段",
    d.querySelector('#jsonMaxBar .jm-mode[data-jm-mode="field"]').classList.contains("is-active"));
  assert("两种模式按钮齐备",
    !!d.querySelector('#jsonMaxBar .jm-mode[data-jm-mode="field"]') &&
    !!d.querySelector('#jsonMaxBar .jm-mode[data-jm-mode="line"]'));

  // ---- 按字段（默认）：差异高亮在左右两个 JSON 区里 ----
  runCompare(SAMPLE);
  assert("左右两栏都是 JSON 组件", !!leftViewer() && !!rightViewer());
  assert("对比后右侧切到预览态（textarea 收起）", el("jsonMaxCompareInput").classList.contains("hide"));
  const lv = leftViewer(), rv = rightViewer();
  assert("左侧高亮：仅左侧 2 行", marks(lv, "diff-del") === 2, marks(lv, "diff-del"));
  assert("左侧高亮：值不同 1 行", marks(lv, "diff-mod") === 1, marks(lv, "diff-mod"));
  assert("右侧高亮：仅右侧 1 行", marks(rv, "diff-add") === 1, marks(rv, "diff-add"));
  assert("右侧高亮：值不同 1 行", marks(rv, "diff-mod") === 1, marks(rv, "diff-mod"));
  assert("password 左侧标值不同", lv.querySelector('.json-line[data-path="password"]').classList.contains("diff-mod"));
  assert("password 右侧标值不同", rv.querySelector('.json-line[data-path="password"]').classList.contains("diff-mod"));
  assert("remember 左侧标仅左侧", lv.querySelector('.json-line[data-path="remember"]').classList.contains("diff-del"));
  assert("captcha 右侧标仅右侧", rv.querySelector('.json-line[data-path="captcha"]').classList.contains("diff-add"));
  const ipLine = lv.querySelector('.json-line[data-path="extra.ip"]');
  assert("嵌套字段 extra.ip 被标仅左侧", ipLine.classList.contains("diff-del"));
  assert("差异行自动展开所在折叠块（可见）", !ipLine.classList.contains("fold-hidden"));
  assert("汇总文案为共 4 处差异",
    stat().indexOf("共 4 处差异：仅左侧 2 · 仅右侧 1 · 值不同 1") >= 0, stat());

  // ---- 相同内容 → 无差异 ----
  runCompare(REQ_BODY);
  assert("相同 JSON 提示无差异", stat().indexOf("无差异") >= 0, stat());
  assert("无差异时两侧都不高亮",
    marks(leftViewer(), "diff-del") + marks(leftViewer(), "diff-mod") === 0 &&
    marks(rightViewer(), "diff-add") + marks(rightViewer(), "diff-mod") === 0);

  // ---- 按行模式：严格逐行文本对比 ----
  click(d.querySelector('#jsonMaxBar .jm-mode[data-jm-mode="line"]'));
  runCompare(REQ_BODY.replace('"admin"', '"root"'));
  assert("按行模式已激活",
    d.querySelector('#jsonMaxBar .jm-mode[data-jm-mode="line"]').classList.contains("is-active"));
  assert("按行：仅 1 处值不同",
    stat().indexOf("共 1 处差异：仅左侧 0 · 仅右侧 0 · 值不同 1") >= 0, stat());
  assert("按行：左右各标 1 行",
    marks(leftViewer(), "diff-mod") === 1 && marks(rightViewer(), "diff-mod") === 1);
  assert("按行：改的是第 2 行",
    leftViewer().querySelector('.json-line[data-line="2"]').classList.contains("diff-mod"));

  runCompare(REQ_BODY + "\n// note");
  assert("按行：多出一行 → 仅右侧 1",
    stat().indexOf("共 1 处差异：仅左侧 0 · 仅右侧 1 · 值不同 0") >= 0, stat());
  assert("按行：右侧末行标仅右侧",
    rightViewer().querySelector('.json-line[data-line="10"]').classList.contains("diff-add"));

  click(d.querySelector('#jsonMaxBar .jm-mode[data-jm-mode="field"]'));
  assert("切回按字段且内容非法 → 提示改用按行", stat().indexOf("按行") >= 0);

  // ---- 编辑原文：切回编辑时把（可能压缩的）JSON 重新格式化 ----
  runCompare('{"code":0,"msg":"ok","data":{"id":1,"list":[1,2,3]}}');
  click(el("jsonMaxCompareEdit"));
  const editTa = el("jsonMaxCompareInput");
  assert("编辑原文：切回编辑时 textarea 被格式化（含换行）", editTa.value.indexOf("\n") >= 0, editTa.value);
  assert("编辑原文：格式化结果仍是合法 JSON", (() => {
    try { return JSON.stringify(JSON.parse(editTa.value)) === JSON.stringify({ code: 0, msg: "ok", data: { id: 1, list: [1, 2, 3] } }); }
    catch (e) { return false; }
  })(), editTa.value);
  assert("编辑原文：textarea 回到可见", !editTa.classList.contains("hide"));
  click(el("jsonMaxCompareClear"));
  assert("清空后输入框为空", el("jsonMaxCompareInput").value === "");
  assert("清空后右侧 viewer 收起", el("jsonMaxCompareView").classList.contains("hide"));
  assert("清空后左侧高亮全部去掉",
    marks(leftViewer(), "diff-del") + marks(leftViewer(), "diff-mod") + marks(leftViewer(), "diff-add") === 0);
  assert("清空后模式复位为按字段",
    d.querySelector('#jsonMaxBar .jm-mode[data-jm-mode="field"]').classList.contains("is-active"));

  // ---- 同步滚动 + 等高两栏 ----
  const lb = el("jsonMaxBody"), rb = el("jsonMaxCompareView");
  assert("滚动联动已挂载（左右两栏）", lb._cmpScrollLinked === true && rb._cmpScrollLinked === true);
  lb.scrollTop = 60;
  lb.dispatchEvent(new window.Event("scroll"));
  assert("左栏滚动同步到右栏", rb.scrollTop === 60, rb.scrollTop);
  assert("两栏等高布局（左/右均为 50%）", (css.match(/flex:\s*1 1 50%/g) || []).length >= 2);

  click(headBtn());
  assert("再点顶部按钮 → 面板收起", pane().classList.contains("hide"));
  assert("收起后共享工具栏也收起", el("jsonMaxBar").classList.contains("hide"));
  assert("收起后按钮文案回到对比", headBtn().textContent === "对比");

  // ---- 响应体最大化：同样有对比按钮（对比是通用能力），但默认收起 ----
  click(el("jsonMaxClose"));
  assert("关窗后弹窗隐藏", el("jsonMaxModal").classList.contains("hide"));
  assert("关窗后对比面板也收起", pane().classList.contains("hide"));
  clickTab("response");
  click(maxBtnFor("响应体"));
  assert("响应体最大化标题正确", el("jsonMaxTitle").textContent === "响应体");
  assert("响应体最大化同样有对比按钮", !headBtn().classList.contains("hide"));
  assert("响应体最大化对比面板默认收起", pane().classList.contains("hide"));
  click(headBtn());
  runCompare(JSON.stringify({ code: 200, msg: "changed" }, null, 2));
  assert("响应体也能对比出差异",
    leftViewer().querySelectorAll(".json-line.diff-mod").length >= 1, stat());
  click(el("jsonMaxClose"));

  // ---- 键值对（请求头）最大化：没有对比按钮 ----
  clickTab("overview");
  const kvMax = maxBtnFor("请求头");
  assert("请求头有最大化按钮", !!kvMax);
  click(kvMax);
  assert("请求头最大化渲染 kv-viewer", !!el("jsonMaxBody").querySelector(".kv-viewer"));
  assert("键值对没有对比按钮", headBtn().classList.contains("hide"));
  assert("键值对对比面板收起", pane().classList.contains("hide"));
  click(el("jsonMaxClose"));

  assert("运行期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));
  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}, 400);
