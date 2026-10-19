// jsdom 验证：造数据抽屉支持「挂文件」（文件下载类接口）
// 流程：openMake → 选文件（内存缓存）→ 保存为 Mock → 先 POST /api/mock/make 拿 seq → 再 POST /api/mock/file 挂上
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const v3Js = fs.readFileSync(path.join(ROOT, "static/v3.js"), "utf8");
const htmlWithScript = html.replace(
  "</body>",
  `<script>${appJs}</script><script>${v3Js}</script></body>`
);

const POSTS = [];

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url, opts) => {
      const u = typeof url === "string" ? url : "";
      let payload = {};
      try { payload = JSON.parse((opts && opts.body) || "{}"); } catch (e) {}
      if (opts && opts.method === "POST") POSTS.push({ url: u, body: payload });
      let body = { ok: true };
      // 真实后端形状：/api/mock/make → {"ok":true,"seq":N}；/api/mock/file → {"ok":true}
      if (u.indexOf("/api/mock/make") >= 0) body = { ok: true, seq: 4242 };
      else if (u.indexOf("/api/mock/file") >= 0) body = { ok: true };
      else if (u.indexOf("/api/mock/logs") >= 0) body = { running: true, logs: [] };
      else if (u.indexOf("/api/mock/apis") >= 0) body = { ok: true, running: true, url: "http://127.0.0.1:1/", apis: [] };
      else if (u.indexOf("/api/mock/status") >= 0) body = { running: true, url: "http://127.0.0.1:1/", count: 0 };
      else if (u.indexOf("/api/status") >= 0) body = { status: "idle" };
      else if (u.indexOf("/api/config") >= 0) body = { ok: true, match_mode: true };
      else if (u.indexOf("/api/endpoint/") >= 0) body = { ok: true, docs: [] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    };
    // FileReader 桩：读出固定 b64
    window.FileReader = function () {
      this.result = "data:application/pdf;base64,JVBERi0xLjQK";
      this.onload = null; this.onerror = null;
      this.readAsDataURL = () => { if (this.onload) setTimeout(() => this.onload(), 0); };
    };
    window.alert = () => {};
    window.prompt = () => null;
    window.confirm = () => true;
    window.WebSocket = function () { this.send = () => {}; this.close = () => {}; };
  },
});
const { window } = dom;
const { document } = window;
const errors = [];
window.addEventListener("error", (e) => errors.push(e.error ? e.error.stack : e.message));

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("[OK] " + name); }
  else { fail++; console.log("[FAIL] " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : "")); }
}
function click(el) { if (el) el.dispatchEvent(new window.Event("click", { bubbles: true })); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

setTimeout(async () => {
  assert("加载期无 JS 错误", errors.length === 0, errors.slice(0, 3));

  window.openMake({ method: "POST", path: "/oa/api/business/downloadAttachment", query: "a=1&b=2" });
  await tick(30);

  const drawer = document.getElementById("makeDrawer");
  assert("造数据抽屉已打开", !drawer.classList.contains("hide"), drawer.className);
  assert("抽屉里有「挂文件」按钮", !!document.getElementById("makeAttach"));
  assert("抽屉里有挂文件状态位", !!document.getElementById("makeFileInfo"));
  assert("初始显示「未挂文件」", document.getElementById("makeFileInfo").textContent.indexOf("未挂文件") >= 0,
    document.getElementById("makeFileInfo").textContent);
  assert("有文件下载用途的提示文案", !!document.querySelector(".make-hint"));

  // 选文件：必须用 app 自己那个 input（_getMockFileInput 缓存，parent=BODY）。
  // ★ 页面里可能还有别的 .file-input-hidden，用 querySelector 取第一个会拿错对象，静默失败。
  assert("存在隐藏 file input", !!document.querySelector("input.file-input-hidden"));
  click(document.getElementById("makeAttach"));
  await tick(20);
  const hidden = window._getMockFileInput();
  assert("点「选择文件」后在隐藏 input 上挂了 onchange", typeof hidden.onchange === "function", typeof hidden.onchange);
  Object.defineProperty(hidden, "files", {
    configurable: true,
    value: [{ name: "报表.pdf", size: 20480, type: "application/pdf" }],
  });
  if (typeof hidden.onchange === "function") hidden.onchange();
  // FileReader 异步：等它 onload 落地再继续（否则保存时 _makeFile 还是 null，文件被静默丢掉）
  await tick(80);

  const info = document.getElementById("makeFileInfo");
  assert("挂文件后显示文件名", info.textContent.indexOf("报表.pdf") >= 0, info.textContent);
  assert("挂文件后显示大小", info.textContent.indexOf("20") >= 0, info.textContent);
  assert("挂文件后出现「移除」链接", !!document.getElementById("makeFileRemove"));

  // 保存 → 应先后 POST /api/mock/make 和 /api/mock/file（带 seq）
  POSTS.length = 0;
  click(document.getElementById("makeSave"));
  await tick(120);

  const makeCall = POSTS.find((p) => p.url.indexOf("/api/mock/make") >= 0);
  const fileCall = POSTS.find((p) => p.url.indexOf("/api/mock/file") >= 0);
  assert("保存时调用了 /api/mock/make", !!makeCall, POSTS.map((p) => p.url));
  assert("make 请求带上了路径", !!makeCall && makeCall.body.path === "/oa/api/business/downloadAttachment",
    makeCall && makeCall.body.path);
  assert("make 请求带上了请求体", !!makeCall && String(makeCall.body.req_body || "").length === 0,
    makeCall && makeCall.body.req_body);

  assert("保存后调用了 /api/mock/file 挂文件", !!fileCall, POSTS.map((p) => p.url));
  assert("挂文件带上了新建记录的 seq", !!fileCall && fileCall.body.seq === 4242, fileCall && fileCall.body.seq);
  assert("挂文件带上了文件名", !!fileCall && fileCall.body.filename === "报表.pdf", fileCall && fileCall.body.filename);
  assert("挂文件带上了 mime", !!fileCall && fileCall.body.mime === "application/pdf", fileCall && fileCall.body.mime);
  assert("挂文件带上了 b64 内容", !!fileCall && typeof fileCall.body.b64 === "string" && fileCall.body.b64.length > 0,
    fileCall && String(fileCall.body.b64 || "").slice(0, 20));

  assert("保存后抽屉关闭", drawer.classList.contains("hide"), drawer.className);
  assert("运行期无 JS 错误", errors.length === 0, errors.slice(0, 3));

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}, 300);
