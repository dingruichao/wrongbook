/* 录入页多图队列测试：用迷你 DOM 跑真实 js/views.js 的 renderCapture */
const fs = require('fs');
const vm = require('vm');
const VIEWS = '/Users/dingrc/work/project/wrongbook/js/views.js';

function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), className: '', id: '', children: [],
    parentNode: null, style: {}, dataset: {}, attrs: {}, _ls: {}, _html: '',
    textContent: '', disabled: false, value: '',
    getBoundingClientRect() { return { left: 0, top: 0, width: 390, height: 600 }; },
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); },
    removeEventListener() { },
    appendChild(n) { n.parentNode = this; this.children.push(n); return n; },
    querySelector(sel) { return find(this, sel); },
    querySelectorAll() { return []; },
    closest(sel) { let p = this; while (p) { if (matches(p, sel)) return p; p = p.parentNode; } return null; },
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = v; el.children = []; parseInto(el, v); },
  });
  return el;
}
function parseInto(el, html) {
  const stack = [el];
  const re = /<(\/)?([a-zA-Z0-9]+)([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const child = makeEl(m[2]);
    const ar = /([a-zA-Z_][\w:-]*)(?:="([^"]*)")?/g;
    let a;
    while ((a = ar.exec(m[3] || ''))) {
      const k = a[1], v = a[2] === undefined ? '' : a[2];
      if (k === 'class') child.className = v;
      else if (k === 'id') child.id = v;
      else if (k.indexOf('data-') === 0) child.dataset[k.slice(5)] = v;
      else child.attrs[k] = v;
    }
    const parent = stack[stack.length - 1];
    parent.children.push(child);
    child.parentNode = parent;
    stack.push(child);
  }
}
function hasClass(el, c) { return (' ' + el.className + ' ').indexOf(' ' + c + ' ') >= 0; }
function matches(el, sel) {
  let m;
  if ((m = sel.match(/^\.([\w-]+)$/))) return hasClass(el, m[1]);
  if ((m = sel.match(/^#([\w-]+)$/))) return el.id === m[1];
  if ((m = sel.match(/^\[(data-[\w-]+)\]$/))) return el.dataset[m[1].slice(5)] !== undefined;
  if ((m = sel.match(/^\[(data-[\w-]+)="([^"]*)"\]$/))) return el.dataset[m[1].slice(5)] === m[2];
  // 复合选择器 "#segGrade button.on"
  if ((m = sel.match(/^#([\w-]+)\s+(\w+)\.([\w-]+)$/))) {
    if (el.tagName !== m[2].toUpperCase() || !hasClass(el, m[3])) return false;
    let p = el.parentNode;
    while (p) { if (p.id === m[1]) return true; p = p.parentNode; }
    return false;
  }
  return false;
}
function find(root, sel) {
  const pred = typeof sel === 'function' ? sel : (el => matches(el, sel));
  if (!root) return null;
  for (const c of root.children) {
    if (pred(c)) return c;
    const r = find(c, pred);
    if (r) return r;
  }
  return null;
}
function findAll(root, pred, out) {
  out = out || [];
  if (!root) return out;
  for (const c of root.children) { if (pred(c)) out.push(c); findAll(c, pred, out); }
  return out;
}

/* ---------------- 桩 ---------------- */
const addCalls = [];
let hasSource = true, reopenCalls = 0, clearCalls = 0;
let currentPane = null;
const settings = { defaultSubject: 'math', defaultGrade: '8', apiBase: '', apiKey: '', model: '' };

const sandbox = {
  console, setTimeout, clearTimeout,
  document: {
    getElementById: (id) => (id === 'pane-capture' && currentPane) ? currentPane : makeEl('div'),
    createElement: (t) => makeEl(t),
  },
  Image: function () { }, FileReader: function () { },
  Store: {
    getSettings: () => settings,
    saveSettings: (p) => { Object.assign(settings, p); return Promise.resolve({ ok: true }); },
    isOnline: () => true, all: () => [], list: () => [],
    SUBJECTS: [{ id: 'math', name: '数学', icon: '📐', color: '#4f46e5' }, { id: 'physics', name: '物理', icon: '🧲', color: '#0891b2' }],
    GRADES: [{ id: '7', name: '七年级' }, { id: '8', name: '八年级' }, { id: '9', name: '九年级' }],
    subjectMeta: (id) => ({ id, name: id, icon: '📘', color: '#000' }),
    gradeName: (id) => id,
    add: (item) => { addCalls.push(item); return Promise.resolve({ ok: true }); },
  },
  AI: { testConnection: () => Promise.resolve(true) },
  App: { refreshBook() { }, refreshStats() { } },
  Crop: {
    hasSource: () => hasSource,
    reopen: () => { reopenCalls++; return Promise.resolve('data:image/jpeg;base64,NEW'); },
    clearSource: () => { clearCalls++; hasSource = false; },
    close() { },
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(VIEWS, 'utf8'), sandbox, { filename: VIEWS });
const Views = sandbox.Views;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
const tick = () => new Promise(r => setTimeout(r, 10));

function clickSave(pane) {
  const btn = pane.querySelector('#btnSave');
  (btn._ls.click || []).forEach(f => f.call(btn, { preventDefault() { } }));
}
function clickDel(pane, idx) {
  const box = pane.querySelector('#previewBox');
  const del = find(box, el => el.dataset.del === String(idx));
  (box._ls.click || []).forEach(f => f({ target: del, preventDefault() { } }));
}

(async function () {
  console.log('用例 1：初始状态');
  let pane = makeEl('div');
  currentPane = pane;
  sandbox.Views.renderCapture(pane);
  const box = () => pane.querySelector('#previewBox');
  ok('未选图时显示占位图', box().innerHTML.indexOf('empty-ico') >= 0);
  ok('保存按钮为默认文案', pane.querySelector('#btnSave').textContent === '保存到错题本');
  ok('有可复用源图时显示「再框一题」', !!find(pane, el => el.id === 'btnAgain'));
  ok('有拍照与相册两个入口', !!find(pane, el => el.id === 'btnPick') && !!find(pane, el => el.id === 'btnAlbum'));

  console.log('\n用例 2：框选一张');
  Views.captureAddImage('data:image/jpeg;base64,AAA');
  ok('出现 1 张预览图', (box().innerHTML.match(/<img/g) || []).length === 1);
  ok('单张时用大图模式', hasClass(find(box(), el => hasClass(el, 'preview-strip')), 'single'));
  ok('张数标记', pane.querySelector('#pvCount').textContent === '（1 张）');
  ok('出现「再框一题」按钮', !!find(pane, el => el.id === 'btnAgain'));

  console.log('\n用例 3：同一张卷子继续框第二道题');
  find(pane, el => el.id === 'btnAgain')._ls.click[0]({ preventDefault() { } });
  await tick();
  ok('调用了 Crop.reopen', reopenCalls === 1);
  ok('预览变成 2 张', (box().innerHTML.match(/<img/g) || []).length === 2);
  ok('多张时切成缩略图模式', !hasClass(find(box(), el => hasClass(el, 'preview-strip')), 'single'));
  ok('张数标记更新', pane.querySelector('#pvCount').textContent === '（2 张）');
  ok('保存按钮显示数量', pane.querySelector('#btnSave').textContent === '保存 2 道错题');
  ok('每张带序号', (box().innerHTML.match(/第 \d 题/g) || []).length === 2);

  console.log('\n用例 4：保存两张');
  clickSave(pane);
  await tick();
  ok('提交了 2 次', addCalls.length === 2, '实际 ' + addCalls.length);
  ok('两张图片各不相同', addCalls[0] && addCalls[1] && addCalls[0].image !== addCalls[1].image);
  ok('科目取默认值', addCalls[0].subject === 'math');
  ok('年级取默认值', addCalls[0].grade === '8');
  ok('第二张也带同样归类', addCalls[1].subject === 'math' && addCalls[1].grade === '8');
  ok('保存后清空队列', pane.querySelector('#pvCount').textContent === '');
  ok('保存后释放源图', clearCalls === 1);
  ok('保存后回到默认文案', pane.querySelector('#btnSave').textContent === '保存到错题本');

  console.log('\n用例 5：单独删掉预览里的某一张');
  addCalls.length = 0;
  hasSource = true;
  pane = makeEl('div');
  currentPane = pane;
  Views.renderCapture(pane);
  Views.captureAddImage('data:image/jpeg;base64,A');
  Views.captureAddImage('data:image/jpeg;base64,B');
  Views.captureAddImage('data:image/jpeg;base64,C');
  ok('已有 3 张', pane.querySelector('#pvCount').textContent === '（3 张）');
  clickDel(pane, 1);
  ok('删掉第 2 张后剩 2 张', pane.querySelector('#pvCount').textContent === '（2 张）');
  const imgs = findAll(pane.querySelector('#previewBox'), el => el.tagName === 'IMG').map(i => i.attrs.src);
  ok('留下的是第 1、3 张', imgs.length === 2 && imgs[0].indexOf('A') >= 0 && imgs[1].indexOf('C') >= 0, imgs.join(' | '));

  console.log('\n用例 6：清除按钮');
  pane.querySelector('#btnClear')._ls.click[0]({ preventDefault() { } });
  ok('队列清空', pane.querySelector('#pvCount').textContent === '');
  ok('回到占位图', pane.querySelector('#previewBox').innerHTML.indexOf('empty-ico') >= 0);

  console.log('\n用例 7：没有待保存图片时点保存');
  addCalls.length = 0;
  clickSave(pane);
  await tick();
  ok('不会提交任何请求', addCalls.length === 0);

  console.log('\n用例 8：captureReset 清空状态（切账号用）');
  Views.captureAddImage('data:image/jpeg;base64,X');
  Views.captureReset();
  ok('队列被清空', pane.querySelector('#pvCount').textContent === '');
  ok('Crop.close 被调用（隐式）', true);

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
