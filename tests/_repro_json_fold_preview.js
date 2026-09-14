// jsdom 验证：JSON 折叠后，开括号行显示预览文本（{ xxxxx... }），而不是只剩 "{"
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const REC = {
  seq: 1,
  method: "POST",
  url: "https://api.example.com/v1/data",
  path: "/v1/data",
  host: "api.example.com",
  registered_domain: "example.com",
  resource_type: "XHR",
  query: "",
  duration_ms: 20,
  is_failed: false,
  request: { headers: {}, post_data: null },
  response: {
    status: 200,
    status_text: "OK",
    mime_type: "application/json",
    size_bytes: 256,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        user: { id: 1, name: "Alice" },
        items: [{ a: 1 }, { b: 2 }],
      },
    }),
  },
  timing: {},
  annotations: { req: {}, res: {} },
};

const errors = [];
const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url, opts) => {
      const u = typeof url === "string" ? url : "";
      let data = { ok: true };
      if (u.indexOf("/api/request/") >= 0) data = REC;
      else if (u.indexOf("/api/endpoint/doc") >= 0) data = { ok: true, doc: { name: "", note: "", tags: [], req: [], resp: [] } };
      else if (u.indexOf("/api/mock/logs") >= 0) data = { ok: true, logs: [] };
      else if (u.indexOf("/api/mock/apis") >= 0) data = { ok: true, apis: [] };
      else if (u.indexOf("/api/config") >= 0) data = { ok: true, port: 8080, match_mode: true };
      else if (u.indexOf("/api/status") >= 0) data = { ok: true, running: false };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    window.alert = () => {};
    window.prompt = () => null;
    window.addEventListener("error", (e) => errors.push(e.error ? e.error.stack : e.message));
  },
});
const { window } = dom;
const d = window.document;

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("[OK] " + name); }
  else { fail++; console.log("[FAIL] " + name + (extra ? " :: " + JSON.stringify(extra) : "")); }
}

function clickTab(key) {
  const el = d.querySelector(`.detail-tabs .tab[data-tab="${key}"]`);
  if (el) el.dispatchEvent(new window.Event("click", { bubbles: true }));
}

function body() { return d.getElementById("detailBody"); }

setTimeout(() => {
  assert("加载期无 JS 错误", errors.length === 0, errors.slice(0, 3));

  window.allRequests.length = 0;
  window.allRequests.push(REC);
  window.renderDetail(REC);

  clickTab("response");

  const viewer = body().querySelector(".json-viewer");
  assert("响应体 JSON viewer 已渲染", !!viewer);

  const folds = viewer.querySelectorAll(".json-fold");
  assert("存在可折叠节点", folds.length > 0, folds.length);

  // 找一个对象 open 行（如 "data": {）——用 fold-collapsed 区分根（不折叠）与该对象（默认折叠），避免被根行的折叠预览文本干扰
  const fold = Array.from(folds).find((f) => {
    const line = f.closest(".json-line");
    return line && line.classList.contains("fold-collapsed") && /"data"\s*:/.test(line.textContent);
  }) || folds[0];

  const openLine = fold.closest(".json-line");
  const openLineNo = Number(openLine.getAttribute("data-line"));
  const endLineNo = Number(fold.getAttribute("data-end"));
  const preview = openLine.querySelector(".json-collapsed-preview");

  // 默认折叠：第一层对象/数组（indent >= 1）应初始收起
  assert("默认状态下第一层对象已折叠", fold.textContent === "▶", fold.textContent);
  assert("默认折叠行有 fold-collapsed", openLine.classList.contains("fold-collapsed"));
  assert("默认折叠预览 span 已存在并显示", !!preview && preview.textContent.length > 2, preview && preview.textContent);

  let hiddenByDefault = true;
  for (let n = openLineNo + 1; n <= endLineNo; n++) {
    const line = viewer.querySelector(`.json-line[data-line="${n}"]`);
    if (line && !line.classList.contains("fold-hidden")) hiddenByDefault = false;
  }
  assert("默认折叠下内部行全部 fold-hidden", hiddenByDefault, { openLineNo, endLineNo });

  // 点击展开
  fold.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert("展开后 fold 按钮变回 ▼", fold.textContent === "▼", fold.textContent);
  assert("展开后 openLine 无 fold-collapsed", !openLine.classList.contains("fold-collapsed"));
  let shownOk = true;
  for (let n = openLineNo + 1; n <= endLineNo; n++) {
    const line = viewer.querySelector(`.json-line[data-line="${n}"]`);
    if (line && line.classList.contains("fold-hidden")) shownOk = false;
  }
  assert("展开后隐藏行恢复显示", shownOk);

  // 再次点击折叠 -> 预览文本正确
  fold.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert("再次折叠后 fold 按钮变成 ▶", fold.textContent === "▶", fold.textContent);
  const previewText = preview ? preview.textContent : "";
  assert("折叠预览含关闭符号", previewText.indexOf("}") >= 0 || previewText.indexOf("]") >= 0, previewText);
  assert("折叠预览含省略号（多字段）", previewText.indexOf("...") >= 0, previewText);

  // JSON 字段级复制
  let copiedText = null;
  window.navigator.clipboard = { writeText: (t) => { copiedText = t; return Promise.resolve(); } };
  const copyBtn = viewer.querySelector('[data-copy-json-path="data.user.id"]');
  assert("标量字段存在复制按钮", !!copyBtn);
  if (copyBtn) {
    copyBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    assert("点击复制按钮复制字段值", copiedText === "1", copiedText);
  }
  const copyStrBtn = viewer.querySelector('[data-copy-json-path="data.user.name"]');
  if (copyStrBtn) {
    copyStrBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    assert("字符串字段复制不带引号", copiedText === "Alice", copiedText);
  }
  const copyObjBtn = viewer.querySelector('[data-copy-json-path="data.user"]');
  if (copyObjBtn) {
    copyObjBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    assert("对象字段复制为 JSON 字符串", copiedText === JSON.stringify({ id: 1, name: "Alice" }), copiedText);
  }

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}, 120);
