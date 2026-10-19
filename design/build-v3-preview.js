// 生成「v3 接口为中心重构版」可交互单文件预览：内联真实 index.html + styles.css + app.js + v3.js，
// 仅桩掉 fetch / WebSocket 喂演示数据，其余全部是真实渲染与交互代码（非模拟）。
// 用法：NODE_PATH=<workspace>/node_modules node design/build-v3-preview.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "static/styles.css"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const v3 = fs.readFileSync(path.join(ROOT, "static/v3.js"), "utf8");

const strip = (h, re, to) => h.replace(re, to);
html = strip(html, '<link rel="stylesheet" href="/static/styles.css" />', `<style>\n${css}\n</style>`);
html = strip(html, '<script src="/static/app.js"></script>', "");
html = strip(html, '<script src="/static/v3.js"></script>', "");

const bootstrap = `
<script>
(function () {
  var RECS = [
    { seq: 1, method: "POST", url: "https://a.example.com/api/login", path: "/api/login", host: "a.example.com", registered_domain: "example.com",
      resource_type: "XHR", query: "", is_failed: false,
      request: { headers: { "Content-Type": "application/json" }, post_data: JSON.stringify({ username: "admin", password: "123456" }, null, 2) },
      response: { status: 200, status_text: "OK", headers: { "Content-Type": "application/json" }, mime_type: "application/json",
        body: JSON.stringify({ code: 0, msg: "ok", data: { token: "tk_001", user: { id: 7, name: "张三", dept: "技术科" } } }, null, 2) } },
    { seq: 2, method: "POST", url: "https://a.example.com/api/login", path: "/api/login", host: "a.example.com", registered_domain: "example.com",
      resource_type: "XHR", query: "", is_failed: false,
      request: { headers: { "Content-Type": "application/json" }, post_data: JSON.stringify({ username: "bob", password: "888888" }, null, 2) },
      response: { status: 200, status_text: "OK", headers: { "Content-Type": "application/json" }, mime_type: "application/json",
        body: JSON.stringify({ code: 0, msg: "ok", data: { token: "tk_002", user: { id: 9, name: "李四", dept: "业务科" } } }, null, 2) } },
    { seq: 3, method: "GET", url: "https://a.example.com/api/user/list?page=1&size=20", path: "/api/user/list", host: "a.example.com", registered_domain: "example.com",
      resource_type: "XHR", query: "page=1&size=20", is_failed: false,
      request: { headers: {}, post_data: null },
      response: { status: 200, status_text: "OK", headers: { "Content-Type": "application/json" }, mime_type: "application/json",
        body: JSON.stringify({ code: 0, data: { total: 2, list: [{ id: 7, name: "张三" }, { id: 9, name: "李四" }] } }, null, 2) } },
    { seq: 4, method: "GET", url: "https://a.example.com/api/dict/type?t=1785803600", path: "/api/dict/type", host: "a.example.com", registered_domain: "example.com",
      resource_type: "XHR", query: "t=1785803600", is_failed: false,
      request: { headers: {}, post_data: null },
      response: { status: 200, status_text: "OK", headers: { "Content-Type": "application/json" }, mime_type: "application/json",
        body: JSON.stringify({ code: 0, data: ["待办", "已办", "批示"] }, null, 2) } }
  ];
  var DOCS = {
    "POST /api/login": { name: "登录", note: "账号密码登录，返回 token。", tags: ["鉴权", "核心"] },
    "GET /api/user/list": { name: "用户列表", note: "分页查询用户。", tags: ["用户"] }
  };
  var MOCK_APIS = { ok: true, data: { url: "http://127.0.0.1:9100", apis: [
    { seq: 1, method: "POST", path: "/api/login", query: "", status: 200, mock_pin: true, hits: 12,
      body_preview: '{"code":0,"token":"tk_001"}', req_body_preview: '{"username":"admin"}' }
  ] } };
  var LOGS = { ok: true, logs: [
    { method: "GET", path: "/api/order/detail", query: "id=9527", status: 404, miss_reason: "无可匹配的固定响应（未收录该接口）", time: Date.now() - 12000 },
    { method: "POST", path: "/api/login", query: "", status: 200, miss_reason: "", time: Date.now() - 30000 },
    { method: "GET", path: "/api/user/avatar", query: "uid=7", status: 404, miss_reason: "无可匹配的固定响应（query 不一致）", time: Date.now() - 60000 }
  ] };
  function jd(u) {
    var s = typeof u === "string" ? u : (u && u.url) || "";
    if (s.indexOf("/api/mock/apis") >= 0) return MOCK_APIS;
    if (s.indexOf("/api/mock/logs") >= 0) return LOGS;
    if (s.indexOf("/api/request/") >= 0) { var n = Number(s.split("/").pop()); return RECS.filter(function (r) { return r.seq === n; })[0] || { error: "not found" }; }
    if (s.indexOf("/api/endpoint/docs") >= 0) return { ok: true, docs: DOCS };
    if (s.indexOf("/api/endpoint/doc") >= 0) return { ok: true, doc: { name: "", note: "", tags: [], req: [], resp: [] } };
    if (s.indexOf("/api/config") >= 0) return { ok: true, match_mode: true, saved_port: 8000, mock_port: 9100 };
    if (s.indexOf("/api/mock/status") >= 0) return { ok: true, running: true, url: "http://127.0.0.1:9100", count: 1 };
    if (s.indexOf("/api/status") >= 0) return { ok: true, running: false };
    return { ok: true };
  }
  window.fetch = function (u, opts) {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(jd(u)); }, text: function () { return Promise.resolve(""); } });
  };
  window.WebSocket = function () {
    var self = this; this.readyState = 1;
    this.send = function () {}; this.close = function () {};
    setTimeout(function () {
      if (typeof self.onopen === "function") self.onopen();
      if (typeof self.onmessage === "function") self.onmessage({ data: JSON.stringify({ type: "snapshot", requests: RECS }) });
    }, 30);
  };
  window.alert = function () {}; window.confirm = function () { return true; }; window.prompt = function () { return null; };
  window.pywebview = undefined;
})();
</script>
<script>
${app}
</script>
<script>
${v3}
</script>
`;

html = html.replace("</body>", bootstrap + "\n</body>");
html = html.replace(/<title>.*?<\/title>/, "<title>API Recorder · v3 重构版预览（可交互）</title>");
html = html.replace(/(<body[^>]*>)/, `$1
<div style="position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:99999;background:var(--surface,#fff);border:1px solid var(--border,#ddd);border-radius:999px;padding:5px 14px;font-size:12px;color:var(--text-2,#666);box-shadow:0 2px 10px rgba(0,0,0,.08);pointer-events:none">
  v3 重构版预览 · 真实界面与逻辑，演示数据 · 左栏点接口 / 顶栏点药丸 / ⋯ 菜单
</div>`);

const outPath = path.join(ROOT, "design", "v3-preview.html");
fs.writeFileSync(outPath, html, "utf8");
console.log("已生成预览：" + outPath + "  (" + Math.round(html.length / 1024) + " KB)");
