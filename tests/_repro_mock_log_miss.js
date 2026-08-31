// jsdom 真实加载验证：Mock 处理记录未命中时显示"比对未命中"原因（行内 + 详情弹窗）
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const logs = [
  {
    ts: 1785050000, method: "GET", path: "/api/x", query: "a=1",
    matched: false, status: 404,
    miss_reason: "同路径记录 2 条，query 均不匹配（请求 query: a=1）",
    req_headers: {}, req_body: "", res_headers: {}, res_body: "",
  },
  {
    ts: 1785050001, method: "POST", path: "/api/y", query: "",
    matched: false, status: 404,
    miss_reason: "同 query 记录 1 条，请求体均不匹配；与其中一条对比：请求多出键: name；记录多出键: user",
    req_headers: {}, req_body: '{"name":"x"}', res_headers: {}, res_body: "",
  },
  {
    ts: 1785050002, method: "GET", path: "/api/z", query: "",
    matched: true, status: 200,
    req_headers: {}, req_body: "", res_headers: {}, res_body: '{"ok":true}',
  },
];

const jsErrors = [];

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url, opts) => {
      const u = typeof url === "string" ? url : "";
      let resp = { ok: true, status: 200 };
      if (u.indexOf("/api/mock/logs") >= 0) resp = { ok: true, status: 200 };
      return Promise.resolve({
        ok: resp.ok,
        status: resp.status,
        json: () => Promise.resolve(u.indexOf("/api/mock/logs") >= 0 ? { ok: true, logs } : { ok: true }),
      });
    };
    window.alert = () => {};
    window.prompt = () => null;
    window.addEventListener("error", (e) => jsErrors.push(e.message));
  },
});
const { window } = dom;

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("[OK] " + name); }
  else { fail++; console.log("[FAIL] " + name + (extra ? " :: " + JSON.stringify(extra) : "")); }
}

setTimeout(() => {
  const d = window.document;

  assert("加载期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));

  const rows = d.querySelectorAll(".mock-log-row");
  assert("处理记录渲染 3 条", rows.length === 3);

  const missBadges = d.querySelectorAll(".badge.miss");
  assert("未命中徽章 2 个", missBadges.length === 2);

  const missReasons = d.querySelectorAll(".miss-reason");
  assert("行内未命中原因 2 条", missReasons.length === 2);
  assert(
    "行内原因内容正确（query 不匹配）",
    missReasons.length > 0 && missReasons[0].textContent.indexOf("query 均不匹配") >= 0,
    missReasons[0] && missReasons[0].textContent
  );
  assert(
    "行内原因内容正确（body 键差，超长截断）",
    missReasons.length > 1
      && missReasons[1].textContent.indexOf("…") >= 0
      && missReasons[1].getAttribute("title").indexOf("请求多出键: name") >= 0,
    { text: missReasons[1] && missReasons[1].textContent, title: missReasons[1] && missReasons[1].getAttribute("title") }
  );
  assert("命中的行不显示原因", !(rows[2] && rows[2].querySelector(".miss-reason")));

  // 点击第一条未命中 -> 详情弹窗含未命中原因块
  rows[0].click();
  setTimeout(() => {
    const modal = d.getElementById("mockLogModal");
    assert("详情弹窗已打开", modal && !modal.classList.contains("hide"));
    const missBlock = d.querySelector(".mock-log-miss");
    assert("详情弹窗含未命中原因块", !!missBlock);
    assert(
      "详情原因完整显示（不截断）",
      !!missBlock && missBlock.textContent.indexOf("同路径记录 2 条，query 均不匹配（请求 query: a=1）") >= 0,
      missBlock && missBlock.textContent
    );
    assert("命中的记录详情无未命中原因块", d.querySelectorAll(".mock-log-miss").length === 1);
    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  }, 50);
}, 300);
