// 生成「Mock 面板 · 三级折叠」视觉预览页：用真实 styles.css + 真实渲染代码产出静态 HTML。
// 模拟一组典型 OA 接口（同 path 不同 query、不同请求/响应），便于浏览器核对：
//   1) 三级折叠：接口（method+path） → 请求参数（query） → 记录
//   2) 默认（pin）按钮在每条记录，query 子项头部展示「默认 200 · ...」摘要
//   3) 单条记录详情默认折叠，限高 320px 避免撑爆
//   4) 组头/卡片头/默认/测试/来源按钮全部可点（仅视觉）
// 用法：NODE_PATH=<workspace>/node_modules node design/build-mock-preview.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "static/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "static/app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "static/styles.css"), "utf8");
const htmlWithScript = html.replace("</body>", `<script>${js}</script></body>`);

const APIS = {
  ok: true,
  running: true,
  url: "http://127.0.0.1:7780/",
  apis: [
    {
      seq: 11, method: "GET", path: "/oa/rest/process/task/flow/list", query: "t=17858036",
      status: 200, mock_pin: false, hits: 3,
      body_preview: '[{"activityId":"X166616255947703551288001448869","activityName":"结束","name":"民警办理-结束"}]',
      req_body_preview: "", body_pretty: '[{"activityId":"X166616255947703551288001448869","activityName":"结束","name":"民警办理-结束"}]',
      req_body_pretty: "", note: "", tags: ["流程"],
    },
    {
      seq: 12, method: "GET", path: "/oa/rest/process/task/flow/list", query: "t=17858036",
      status: 200, mock_pin: true, hits: 12,
      body_preview: '[{"activityId":"X166616256126305416631808075187","activityName":"结束","name":"民警办理-结束"}]',
      req_body_preview: "", body_pretty: '[{"activityId":"X166616256126305416631808075187","activityName":"结束","name":"民警办理-结束"}]',
      req_body_pretty: "", note: "默认那条", tags: ["流程", "默认"],
    },
    {
      seq: 13, method: "GET", path: "/oa/rest/process/task/flow/list", query: "t=99999999",
      status: 200, mock_pin: false, hits: 3,
      body_preview: '[{"activityId":"DIFFERENT","activityName":"结束","name":"民警办理-结束"}]',
      req_body_preview: "", body_pretty: '[{"activityId":"DIFFERENT","activityName":"结束","name":"民警办理-结束"}]',
      req_body_pretty: "", note: "", tags: ["流程"],
    },
    {
      seq: 21, method: "POST", path: "/oa/api/process/batchCommit", query: "",
      status: 200, mock_pin: false, hits: 3,
      body_preview: '{"code":200,"msg":"success","result":true}',
      req_body_preview: '[{"type":"complete","taskId":"...","formKey":"fldtm","businessId":"TEST_001"}]',
      body_pretty: '{"code":200,"msg":"success","result":true}',
      req_body_pretty: '[{"type":"complete","taskId":"1798...","formKey":"fldtm","businessId":"TEST_001"}]',
      note: "无请求体演示", tags: [],
    },
    {
      seq: 22, method: "POST", path: "/oa/api/process/batchCommit", query: "",
      status: 200, mock_pin: false, hits: 3,
      body_preview: '{"code":200,"msg":"success","result":false}',
      req_body_preview: '[{"type":"complete","taskId":"...","formKey":"fldtm","businessId":"TEST_002"}]',
      body_pretty: '{"code":200,"msg":"success","result":false}',
      req_body_pretty: '[{"type":"complete","taskId":"1799...","formKey":"fldtm","businessId":"TEST_002"}]',
      note: "", tags: [],
    },
    {
      seq: 31, method: "POST", path: "/oa/api/data/saveFormData", query: "",
      status: 200, mock_pin: true, hits: 12,
      body_preview: '{"code":200,"msg":"已保存"}',
      req_body_preview: '[{"taskId":"...","formKey":"26f661cb582e6ba6","$form":{"id":"...","fldtm":"..."}}]',
      body_pretty: '{"code":200,"msg":"已保存"}',
      req_body_pretty: '[{"taskId":"1797...","formKey":"26f661cb582e6ba6","$form":{"id":"1796...","fldtm":"关于北京边检..."}}]',
      note: "表单保存默认", tags: ["主流程"],
    },
  ],
};

const dom = new JSDOM(htmlWithScript, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://localhost/",
  beforeParse(window) {
    window.fetch = (url) => {
      const u = typeof url === "string" ? url : "";
      let data = { ok: true };
      if (u.indexOf("/api/mock/apis") >= 0) data = APIS;
      else if (u.indexOf("/api/mock/status") >= 0) data = { running: true, url: APIS.url, port: 7780, count: APIS.apis.length };
      else if (u.indexOf("/api/mock/logs") >= 0) data = { running: true, logs: [] };
      else if (u.indexOf("/api/mock/pin") >= 0) data = { ok: true };
      else if (u.indexOf("/api/mock/test") >= 0) data = { ok: true, status: 200, body: "(preview 测试桩)" };
      else if (u.indexOf("/api/status") >= 0) data = { status: "idle" };
      else if (u.indexOf("/api/config") >= 0) data = { ok: true, match_mode: true };
      else if (u.indexOf("/api/endpoint/") >= 0) data = { ok: true, docs: [] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    window.alert = () => {};
    window.prompt = () => null;
    window.WebSocket = function () { this.send = () => {}; this.close = () => {}; };
    window.addEventListener("error", () => {});
  },
});

const { window } = dom;
const { document } = window;

setTimeout(() => {
  document.querySelector('[data-go="mock"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  setTimeout(() => {
    const list = document.getElementById("mockApiList");
    // 默认全部展开组与 query（详情保持折叠）：方便一眼看清三级结构
    list.querySelectorAll(".mock-group").forEach((g) => g.classList.add("expanded"));
    list.querySelectorAll(".mock-query-item").forEach((q) => q.classList.add("expanded"));

    const listHtml = list.outerHTML;
    const head = document.querySelector("#panelMock .mock-dash-head").outerHTML;
    const logsHead = document.querySelector(".mock-logs .mock-dash-head").outerHTML;
    const logsList = document.getElementById("mockLogList").outerHTML;

    const out = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>Mock 面板 · 三级折叠预览</title>
<style>
${css}
body { background: var(--bg); margin: 0; padding: 24px; }
.preview-wrap { max-width: 980px; margin: 0 auto; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; box-shadow: var(--sh-2); }
.preview-note { max-width: 980px; margin: 0 auto 14px; color: var(--text-2); font-size: 13px; line-height: 1.8; }
.preview-note b { color: var(--text); }
.preview-note code { background: var(--surface-2); padding: 1px 6px; border-radius: 4px; }
.mock-dash { padding: 14px 18px; gap: 10px; }
.mock-api-list { max-height: 70vh; }
</style>
</head>
<body>
<div class="preview-note">
  <b>Mock 面板 · 三级折叠</b> —— 预览已自动展开前两层（接口组 + query 子项），单条记录详情默认折叠并限高 320px，点击卡头展开。
  <ul>
    <li>组头：<code>method + path</code> + 记录数 / query 数 + 「已默认 N 个 query」badge（按 query 各自默认，命中时返回各自默认）。</li>
    <li>query 子项：<code>query 字符串</code> + 记录数 + 「默认 状态码 · 摘要」一句话标识该 query 的默认条。</li>
    <li>记录卡：状态码 + 响应摘要 + 「默认/取消默认」「测试」「来源」按钮。点击卡头展开详情（请求体/返回体）。</li>
    <li>处理记录栏（下方）：标题右侧新增 <b>「清空」</b> 按钮（无记录时禁用，点击二次确认后清空全部处理记录，不影响运行状态与命中计数）。</li>
  </ul>
</div>
<div class="preview-wrap">
  ${head}
  <div class="mock-dash">
    ${listHtml}
  </div>
</div>

<div class="preview-wrap" style="margin-top:16px">
  ${logsHead}
  <div class="mock-dash">
    ${logsList}
  </div>
</div>
<script>
// 预览页：阻断 Mock 启动/停机按钮和「来源」「测试」真行为，仅保留折叠交互
document.querySelectorAll(".mock-pin-one").forEach(function (b) {
  b.addEventListener("click", function (e) { e.stopPropagation(); e.preventDefault(); var old = b.textContent; b.textContent = (b.textContent.indexOf("取消") >= 0) ? "默认" : "已默认 ✓"; b.disabled = true; setTimeout(function () { b.disabled = false; b.textContent = old; }, 900); });
});
document.querySelectorAll(".mock-test-one").forEach(function (b) {
  b.addEventListener("click", function (e) { e.stopPropagation(); e.preventDefault(); var card = b.closest(".mock-api-card"); var body = card.querySelector(".mock-api-card-body"); if (body.style.display === "none" || body.style.display === "") { body.style.display = "block"; } var pre = card.querySelector(".mock-api-result"); pre.style.display = "block"; pre.textContent = "测试中…"; setTimeout(function () { pre.textContent = "[preview] 200 OK · (测试桩返回)"; }, 200); });
});
document.querySelectorAll(".mock-src-one").forEach(function (b) {
  b.addEventListener("click", function (e) { e.stopPropagation(); e.preventDefault(); var old = b.textContent; b.textContent = "已跳 ✓"; b.disabled = true; setTimeout(function () { b.disabled = false; b.textContent = old; }, 900); });
});
</script>
</body>
</html>`;

    const outPath = path.join(ROOT, "design", "mock-preview.html");
    fs.writeFileSync(outPath, out, "utf8");
    console.log("已生成预览：" + outPath);
    process.exit(0);
  }, 200);
}, 120);