// jsdom 复现：设置页输入端口 → 点保存 → 验证 fetch 是否发出 POST /api/config 及 body 内容
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const calls = [];
const jsErrors = [];

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url, opts) => {
      const u = typeof url === "string" ? url : "";
      const body = opts && opts.body ? opts.body : "";
      if (opts && opts.method === "POST") calls.push({ url: u, body });
      let resp = { ok: true, status: 200 };
      if (u.indexOf("/api/config") >= 0) resp = { ok: true, status: 200 };
      return Promise.resolve({ ok: resp.ok, status: resp.status, json: () => Promise.resolve({ ok: true }) });
    };
    window.alert = (m) => { console.log("[alert]", m); };
    window.prompt = () => null;
    window.addEventListener("error", (e) => jsErrors.push(e.message));
  },
});
const { window } = dom;

setTimeout(() => {
  const d = window.document;

  // 模拟用户真实操作：切到别页再切回设置页（go('settings') 会重新渲染设置页，
  // 旧版 savePortCfg 读缓存的旧节点会读到空值——"端口没保存"根因）
  if (typeof window.go === "function") {
    window.go("recording");
    window.go("settings");
  }
  const portInput = d.getElementById("portInput");
  const maskSave = d.getElementById("maskSave");
  console.log("切页后 portInput 存在:", !!portInput, "| maskSave 存在:", !!maskSave);

  if (portInput && maskSave) {
    portInput.value = "9999";
    const mpi = d.getElementById("mockPortInput");
    if (mpi) mpi.value = "8888";
    maskSave.click();
  }

  setTimeout(() => {
    console.log("JS 运行错误:", jsErrors.length ? jsErrors : "无");
    console.log("POST 请求捕获:", calls.length ? JSON.stringify(calls, null, 2) : "无 —— 保存按钮未发出请求！");
    const cfgCall = calls.find((c) => c.url.indexOf("/api/config") >= 0 && c.body.indexOf('"port"') >= 0);
    const btn = d.getElementById("maskSave");
    const btnOk = btn && btn.textContent.indexOf("已保存") >= 0;
    console.log("保存按钮反馈:", btnOk ? "已保存 ✓ 已显示" : "无");
    const portVal = cfgCall ? JSON.parse(cfgCall.body).port : null;
    console.log("POST 中 port 值:", portVal, portVal === "9999" ? "(正确——实时查询新节点生效)" : "(为空——旧 bug 复现)");
    const pass = !!cfgCall && portVal === "9999" && btnOk;
    console.log(pass ? "PASS: 切页重渲染后保存仍能读取新节点端口值" : "FAIL: 切页后保存读到空端口（旧 bug 复现）");
    process.exit(pass ? 0 : 1);
  }, 100);
}, 500);
