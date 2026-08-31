// jsdom 真实加载验证：Mock 匹配模式开关 —— 默认严格(勾选)；切换后 POST /api/config 发 match_mode
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
      if (opts && opts.method === "POST" && u.indexOf("/api/config") >= 0) calls.push({ url: u, body });
      let resp = { ok: true, status: 200 };
      if (u.indexOf("/api/config") >= 0) resp = { ok: true, status: 200 };
      return Promise.resolve({ ok: resp.ok, status: resp.status, json: () => Promise.resolve({ ok: true }) });
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
  const toggle = d.getElementById("mockStrictToggle");

  assert("开关元素存在", !!toggle);
  assert("加载期无 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3));

  if (toggle) {
    // 1) 默认严格：开关应勾选（index.html checked + 前端 mockStrictMode=true 默认）
    assert("默认勾选（严格匹配）", toggle.checked === true, { checked: toggle.checked });

    // 2) 取消勾选 -> 模糊匹配 -> POST body 应含 match_mode:false
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
    setTimeout(() => {
      const c1 = calls.find((c) => c.body.indexOf('"match_mode"') >= 0 && JSON.parse(c.body).match_mode === false);
      assert("关闭开关 -> POST match_mode=false", !!c1, calls);

      // 3) 重新勾选 -> 严格 -> POST body 应含 match_mode:true
      toggle.checked = true;
      toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
      setTimeout(() => {
        const c2 = calls.find((c) => c.body.indexOf('"match_mode"') >= 0 && JSON.parse(c.body).match_mode === true);
        assert("打开开关 -> POST match_mode=true", !!c2, calls);

        // 4) 不应再出现旧键 strict_mode
        const oldKey = calls.some((c) => c.body.indexOf('"strict_mode"') >= 0);
        assert("请求中不再出现旧键 strict_mode", !oldKey, calls);

        console.log(`\nRESULT pass=${pass} fail=${fail}`);
        process.exit(fail ? 1 : 0);
      }, 50);
    }, 50);
  } else {
    console.log(`\nRESULT pass=${pass} fail=${fail}`);
    process.exit(1);
  }
}, 300);
