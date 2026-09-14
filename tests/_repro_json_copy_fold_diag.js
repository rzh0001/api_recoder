// 诊断：JSON 查看器 (1) 复制按钮在 clipboard 同步异常时是否回落 (2) 所有容器都能折叠（含根级数组/数组元素）
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = "E:/api_recoder";
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const errors = [];
const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
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

function countContainers(obj) {
  if (obj === null || typeof obj !== "object") return 0;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return 0;
    let n = 1;
    obj.forEach((v) => { if (v && typeof v === "object") n += countContainers(v); });
    return n;
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) return 0;
  let n = 1;
  keys.forEach((k) => { const v = obj[k]; if (v && typeof v === "object") n += countContainers(v); });
  return n;
}

function checkFolds(label, jsonText) {
  const obj = JSON.parse(jsonText);
  const expected = countContainers(obj);
  const html = window.renderJsonGutter(jsonText, {});
  const wrap = d.createElement("div");
  wrap.innerHTML = html;
  d.body.appendChild(wrap);
  const folds = wrap.querySelectorAll(".json-fold");
  assert(`${label}：容器折叠按钮数 = 期望值(${expected})`, folds.length === expected, { got: folds.length, expected });
  // 默认折叠：所有 indent>=1 的 open 行初始收起
  const collapsed = wrap.querySelectorAll(".json-line.fold-collapsed");
  assert(`${label}：默认折叠行数 > 0`, collapsed.length > 0, collapsed.length);
  // 每个 json-fold 都指向一个存在 data-line 的行
  let allValid = true;
  folds.forEach((f) => {
    const line = f.closest(".json-line");
    if (!line || !line.getAttribute("data-line")) allValid = false;
  });
  assert(`${label}：每个折叠按钮都绑定到行`, allValid);
  d.body.removeChild(wrap);
  return wrap;
}

// 1) 对象根 + 嵌套对象 + 数组(对象/标量)
const objRoot = JSON.stringify({
  result: {
    formId: "oa_shouwen",
    components: [
      { type: "text", name: "标题" },
      { type: "select", name: "部门" },
    ],
    activity: { id: 1, title: "审批" },
    content: {
      idField: "id",
      designers: [{ name: "张三" }, { name: "李四" }],
    },
  },
}, null, 2);

// 2) 数组根 + 对象元素 + 嵌套
const arrRoot = JSON.stringify([
  { id: 1, items: [{ a: 1 }, { a: 2 }] },
  { id: 2, items: [] },
], null, 2);

checkFolds("对象根", objRoot);
checkFolds("数组根", arrRoot);

// 3) 复制：模拟非安全上下文 navigator.clipboard.writeText 同步抛异常 -> 必须回落到 execCommand
let fallbackText = null;
d.execCommand = (cmd) => { if (cmd === "copy") return true; return false; };
const taValue = {};
const realCreate = d.createElement.bind(d);
window.document.createElement = (tag) => {
  const el = realCreate(tag);
  if (tag === "textarea") {
    Object.defineProperty(el, "value", { get() { return taValue.v; }, set(v) { taValue.v = v; } });
  }
  return el;
};
window.navigator.clipboard = {
  writeText: () => { throw new Error("NotAllowedError: insecure context"); },
};

const recHtml = window.renderJsonGutter(objRoot, {});
const wrap = d.createElement("div");
wrap.innerHTML = recHtml;
d.body.appendChild(wrap);
const copyBtn = wrap.querySelector('[data-copy-json-path="result.formId"]');
assert("标量字段复制按钮存在", !!copyBtn);
if (copyBtn) {
  copyBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert("同步异常下回落并复制成功", taValue.v === "oa_shouwen", taValue.v);
}
d.body.removeChild(wrap);

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
