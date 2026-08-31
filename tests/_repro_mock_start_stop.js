// jsdom 真实加载验证：停止 Mock 后「启动 Mock」按钮必须恢复可点击（修复回归）
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
    window.fetch = (url, opts) => {
      let body = { ok: true };
      const u = typeof url === "string" ? url : "";
      if (u.indexOf("/api/mock/status") >= 0) body = { running: false };
      else if (u.indexOf("/api/mock/start") >= 0) body = { ok: true, running: true, url: "http://127.0.0.1:1/", port: 1, count: 2 };
      else if (u.indexOf("/api/mock/stop") >= 0) body = { ok: true, running: false };
      else if (u.indexOf("/api/mock/apis") >= 0) body = { ok: true, running: true, url: "http://127.0.0.1:1/", apis: [] };
      else if (u.indexOf("/api/status") >= 0) body = { status: "idle" };
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

const startBtn = () => document.getElementById("startMock");
const stopBtn = () => document.getElementById("stopMock");

setTimeout(() => {
  assert("加载期无 JS 错误", errors.length === 0, errors.slice(0, 3));

  // 初始（mock 未运行）
  assert("初始：启动按钮可点击", startBtn().disabled === false);
  assert("初始：停止按钮禁用", stopBtn().disabled === true);

  // 第一次启动
  startBtn().click();
  setTimeout(() => {
    assert("启动后：启动按钮禁用（防重复）", startBtn().disabled === true);
    assert("启动后：停止按钮可点击", stopBtn().disabled === false);

    // 停止
    stopBtn().click();
    setTimeout(() => {
      // —— 本修复点：停止后启动按钮必须恢复可点击 ——
      assert("停止后：启动按钮恢复可点击（修复点）", startBtn().disabled === false);
      assert("停止后：停止按钮禁用", stopBtn().disabled === true);

      // 再次启动，验证能真正拉起（按钮 enabled 时 .click() 才会触发监听）
      startBtn().click();
      setTimeout(() => {
        assert("再次启动：启动按钮禁用", startBtn().disabled === true);
        assert("再次启动：停止按钮可点击", stopBtn().disabled === false);
        console.log(`\nRESULT pass=${pass} fail=${fail}`);
        process.exit(fail ? 1 : 0);
      }, 50);
    }, 50);
  }, 50);
}, 120);
