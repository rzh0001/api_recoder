// DOM-stub harness: loads the REAL <script> from the prototype HTML and exercises
// the 请求库 two-level flow (list -> detail -> editable API doc).
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, 'api-recorder-redesign.html'), 'utf8');
const m = HTML.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('NO SCRIPT FOUND'); process.exit(1); }
const code = m[1];

// ---------------- minimal DOM stub ----------------
let docRef = null;
function matchSel(node, sel) {
  sel = sel.trim();
  if (sel.startsWith('[')) {
    const mm = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (mm) { const k = mm[1], v = mm[2]; if (!(k in node._attrs)) return false; if (v !== undefined && node._attrs[k] !== v) return false; return true; }
    return false;
  }
  const parts = sel.split('.');
  let tag = null; const classes = [];
  parts.forEach((p, idx) => { if (idx === 0) { if (p) tag = p; } else { if (p) classes.push(p); } });
  if (tag && node.tag !== tag) return false;
  for (const c of classes) { if (!node._classes.includes(c)) return false; }
  return true;
}
function parseHTML(html, doc) {
  const roots = [];
  const stack = [{ children: roots, _classes: [], _attrs: {}, tag: '#frag' }];
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g; let r;
  while ((r = re.exec(html))) {
    const close = r[1] === '/', tag = r[2].toLowerCase(), attrs = r[3], selfClose = r[4] === '/';
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const node = doc.createElement(tag);
    const ar = /([a-zA-Z0-9_-]+)\s*=\s*"(.*?)"/g; let am;
    while ((am = ar.exec(attrs))) {
      const k = am[1], v = am[2]; node._attrs[k] = v;
      if (k === 'class') node.className = v;
      else if (k === 'id') { node.id = v; doc._byId[v] = node; }
      else if (k.startsWith('data-')) { const dk = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); node.dataset[dk] = v; }
    }
    const parent = stack[stack.length - 1];
    parent.children.push(node); node.parentNode = parent;
    if (!selfClose) stack.push(node);
  }
  return roots;
}
function mkNode(tag) {
  const n = { tag, children: [], parentNode: null, _attrs: {}, dataset: {}, style: {}, _listeners: {}, _classes: [], value: '', textContent: '', title: '', id: '', _html: '' };
  Object.defineProperty(n, 'className', { get() { return n._classes.join(' '); }, set(v) { n._classes = (v || '').split(/\s+/).filter(Boolean); } });
  n.classList = {
    add(...c) { c.forEach(x => { if (!n._classes.includes(x)) n._classes.push(x); }); },
    remove(...c) { n._classes = n._classes.filter(x => !c.includes(x)); },
    toggle(c, f) { if (f === undefined) f = !n._classes.includes(c); f ? n.classList.add(c) : n.classList.remove(c); return f; },
    contains(c) { return n._classes.includes(c); }
  };
  n.appendChild = function (c) { n.children.push(c); c.parentNode = n; return c; };
  n.removeChild = function (c) { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); c.parentNode = null; };
  n.remove = function () { if (n.parentNode) n.parentNode.removeChild(n); };
  n.after = function (node) { const p = n.parentNode; if (!p) return; const i = p.children.indexOf(n); p.children.splice(i + 1, 0, node); node.parentNode = p; };
  Object.defineProperty(n, 'previousElementSibling', { get() { const p = n.parentNode; if (!p) return null; const i = p.children.indexOf(n); return i > 0 ? p.children[i - 1] : null; } });
  Object.defineProperty(n, 'nextElementSibling', { get() { const p = n.parentNode; if (!p) return null; const i = p.children.indexOf(n); return i >= 0 && i < p.children.length - 1 ? p.children[i + 1] : null; } });
  n.setAttribute = function (k, v) { n._attrs[k] = String(v); if (k === 'class') n.className = v; if (k === 'id') n.id = v; };
  n.getAttribute = function (k) { return n._attrs[k]; };
  n.addEventListener = function (t, fn) { (n._listeners[t] = n._listeners[t] || []).push(fn); };
  n._fire = function (t, ev) { (n._listeners[t] || []).forEach(fn => fn(ev)); };
  n.scrollIntoView = function () {};
  n.querySelectorAll = function (sel) { const out = []; (function walk(x) { x.children.forEach(ch => { if (matchSel(ch, sel)) out.push(ch); walk(ch); }); })(n); return out; };
  n.querySelector = function (sel) { const r = n.querySelectorAll(sel); return r[0] || null; };
  Object.defineProperty(n, 'innerHTML', { get() { return n._html; }, set(v) { n._html = v; n.children = parseHTML(v, docRef); n.children.forEach(c => c.parentNode = n); } });
  return n;
}
const doc = {
  _byId: {},
  createElement(tag) { return mkNode(tag); },
  getElementById(id) { if (!doc._byId[id]) doc._byId[id] = mkNode('div'); return doc._byId[id]; },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  addEventListener() {}
};
docRef = doc;
doc.body = mkNode('body');

// ---------------- run the real script ----------------
const fn = new Function('document', 'window', 'setTimeout', 'requestAnimationFrame', code + '\n;return {LIB,libState,openEndpoint,backToList,renderLib,renderExport,go,exportState,showExportPreview,doExport,getExp:function(){return document.getElementById("expWrap");},getDb:function(){return document.getElementById("libDocBody");},getOt:function(){return document.getElementById("libOutline");},getOs:function(){return document.getElementById("libOutlineSearch");}};');
const api = fn(doc, {}, setTimeout, function(){});
const $db = api.getDb(), $ot = api.getOt(), $os = api.getOs();

// ---------------- assertions ----------------
let pass = 0, fail = 0; const fails = [];
function ok(name, cond) { if (cond) { pass++; } else { fail++; fails.push(name); } }
function findByClass(node, cls, acc) { acc = acc || []; const wanted = cls.split(/\s+/); node.children.forEach(ch => { if (wanted.every(c => ch._classes.includes(c))) acc.push(ch); findByClass(ch, cls, acc); }); return acc; }
function countTag(node, tag, acc) { acc = acc || 0; node.children.forEach(ch => { if (ch.tag === tag) acc++; acc = countTag(ch, tag, acc); }); return acc; }

// 1) default view = API 清单 (no inline cases)
function bodyRows(node) { return node.querySelectorAll('tbody').reduce((a, t) => a + t.children.length, 0); }
function listRowCount() { return findByClass($db, 'epm-table').reduce((a, t) => a + t.querySelector('tbody').children.length, 0); }
ok('list: 3 归属分组', findByClass($db, 'epm').length === 3);
ok('list: 7 端点行', listRowCount() === 7);
ok('list: 0 内联案例表 (需求①)', findByClass($db, 'case-table').length === 0);
ok('list: 0 可编辑API文档 (需求③默认不显示)', findByClass($db, 'apidoc').length === 0);
ok('outline: 3 分组', findByClass($ot, 'ol-group').length === 3);
ok('outline: 7 端点', findByClass($ot, 'ol-ep').length === 7);
ok('stat: 3/7/28 (源自数据，与页头一致)', (function(){ let d=Object.keys(api.LIB).length,e=0,c=0; Object.values(api.LIB).forEach(g=>{e+=g.endpoints.length; g.endpoints.forEach(ep=>c+=ep.cases.length);}); return d===3&&e===7&&c===28; })());

// 2) click endpoint -> 端点详情 (cases shown)
api.openEndpoint('oa.smarthengxin.com', 0);
ok('detail: 1 案例表 (需求②)', findByClass($db, 'case-table').length === 1);
ok('detail: 案例表含 6 行', findByClass($db, 'case-table')[0].querySelector('tbody').children.length === 6);
ok('detail: 含可编辑API文档 (需求③)', findByClass($db, 'apidoc').length === 1);
ok('detail: 2 个字段定义表(req+resp)', findByClass($db, 'fdef').length === 2);
ok('detail: 请求参数字段 3 行', findByClass($db, 'fdef')[0].querySelector('tbody').children.length === 3);
ok('detail: 标题含端点路径', findByClass($db, 'lib-detail')[0]._html.includes('/api/v1/oa/flow/list'));
ok('outline: 当前端点高亮 active', findByClass($ot, 'ol-ep active').length === 1);

// 2b) 案例就地展开/收起
const ct = findByClass($db, 'case-table')[0]; const tb = ct.querySelector('tbody');
const before = tb.children.length; tb.children[0].onclick();
ok('case: 点击展开插入详情行', tb.children.length === before + 1);
tb.children[0].onclick();
ok('case: 再次点击收起', tb.children.length === before);

// 3) 可编辑：添加字段 -> 数据 + DOM 同步增加
const ep = api.LIB['oa.smarthengxin.com'].endpoints[0];
const reqBefore = ep.req.length;
const fadd = findByClass($db, 'fadd')[0];
fadd.onclick();
ok('edit: 添加字段后数据+1', ep.req.length === reqBefore + 1);
ok('edit: 重新渲染后字段行+1', findByClass($db, 'fdef')[0].querySelector('tbody').children.length === reqBefore + 1);

// 3b) 删除字段
const delBefore = ep.req.length;
const delBtn = findByClass($db, 'fdef')[0].querySelector('[data-del]');
delBtn.onclick();
ok('edit: 删除字段后数据-1', ep.req.length === delBefore - 1);

// 3c) 切换必填
const f0 = ep.req[0];
const reqToggle = findByClass($db, 'fdef')[0].querySelector('[data-req]');
const was = f0.required; reqToggle.onclick();
ok('edit: 必填切换生效', ep.req[0].required === !was);

// 返回清单
api.backToList();
ok('back: 返回清单显示 3 分组', findByClass($db, 'epm').length === 3);

// 过滤
$os._fire('input', { target: { value: 'sso' } });
ok('filter: 仅 sso 分组 (1)', findByClass($db, 'epm').length === 1);
ok('filter: sso 下 2 端点', listRowCount() === 2);

// ===== 导出（独立大功能） =====
doc.getElementById('topTitle').childNodes=[{nodeValue:''}];
api.go('export');
const $ex=api.getExp();
ok('export: 渲染 4 个格式卡', findByClass($ex,'fmt-card').length===4);
ok('export: 统计 3 卡(7端点/28案例) 全部范围', (function(){const s=$ex.querySelectorAll('.exp-stat'); return s.length===3 && $ex._html.includes('接口端点') && $ex._html.includes('捕获案例') && $ex._html.includes('导出格式');})());
ok('export: 默认范围=全部录制(分段高亮)', (function(){const b=$ex.querySelectorAll('.seg-btn'); return b.length===4 && b[0]._classes.includes('on');})());
ok('export: 含脱敏卡与开关', findByClass($ex,'mask-row').length>=2 && !!doc.getElementById('expMask'));
const har=findByClass($ex,'fmt-card').find(c=>c._attrs['data-fmt']==='har'); har.onclick();
ok('export: 切到 HAR 后统计卡显示 HAR', api.getExp()._html.includes('HAR'));
api.getExp().querySelectorAll('.seg-btn')[1].onclick();
ok('export: 按归属范围出现下拉', api.getExp()._html.includes('expDomain'));
api.getExp().querySelectorAll('.seg-btn')[3].onclick();
ok('export: 手动范围出现勾选列表', api.getExp()._html.includes('chk-item'));
api.showExportPreview();
ok('export: 预览打开 modal', doc.getElementById('expModal')._classes.includes('open'));
ok('export: 预览含端点路径', doc.getElementById('expPrevBody').textContent.includes('/api/v1/oa/flow/list'));
api.doExport();
ok('export: 导出生成 toast(写入下载文件夹)', (function(){const last=doc.body.children[doc.body.children.length-1]; return last && last._classes.includes('toast');})());

// ---------------- report ----------------
console.log(`\nPASS ${pass} / ${pass + fail}`);
if (fail) { console.log('FAILED:', fails.join(' | ')); process.exit(1); }
else console.log('ALL GOOD');
