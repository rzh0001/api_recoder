// jsdom 真实加载验证：导入完成后提示「去重 N 条」（后端返回 duplicates 时的前端展示）
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const alerts = [];
const jsErrors = [];

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url, opts) => {
      const u = typeof url === "string" ? url : "";
      let data = { ok: true };
      if (u.indexOf("/api/import") >= 0) data = { ok: true, kind: "HAR", count: 2, files: 1, duplicates: 3 };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    window.alert = (m) => alerts.push(m);
    window.confirm = () => true;
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
  const input = d.getElementById("importFile");

  assert("导入文件输入框存在", !!input);
  assert("加载期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));

  if (input) {
    const file = new window.File(["{}"], "a.har", { type: "application/json" });
    const list = { 0: file, length: 1, item: () => file };
    Object.defineProperty(input, "files", { value: list, configurable: true });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));

    setTimeout(() => {
      const okAlert = alerts.find((m) => m.indexOf("导入成功") >= 0);
      assert("触发导入成功提示", !!okAlert, alerts);
      assert("提示包含去重 3 条", !!okAlert && okAlert.indexOf("去重 3 条") >= 0, okAlert);
      assert("提示包含共 2 条", !!okAlert && okAlert.indexOf("共 2 条") >= 0, okAlert);
      console.log(`\nRESULT pass=${pass} fail=${fail}`);
      process.exit(fail ? 1 : 0);
    }, 100);
  } else {
    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exit(1);
  }
}, 300);
