/* 框选编辑器黑盒测试：在 Node 里用迷你 DOM + canvas 桩跑 js/crop.js
 * 重点验证「屏幕上框住的那块 → 导出的原图区域」这套几何换算（含旋转） */
const fs = require('fs');
const vm = require('vm');
const SRC = 1000, SRC_H = 800;         // 假照片尺寸
const STAGE_W = 390, STAGE_H = 600;    // 假屏幕
const css = '/Users/dingrc/work/project/wrongbook/js/crop.js';

let madeCanvases = [];

/* ---------------- 迷你 DOM ---------------- */
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), className: '', id: '', children: [],
    parentNode: null, style: {}, dataset: {}, attrs: {}, _ls: {}, _html: '',
    getBoundingClientRect() { return { left: 0, top: 0, width: STAGE_W, height: STAGE_H }; },
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); },
    removeEventListener(t, f) { if (this._ls[t]) this._ls[t] = this._ls[t].filter(x => x !== f); },
    appendChild(n) { n.parentNode = this; this.children.push(n); return n; },
    insertBefore(n) { n.parentNode = this; this.children.unshift(n); return n; },
    removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; return n; },
    querySelector(sel) { return find(this, sel); },
    querySelectorAll() { return []; },
    closest(sel) { let p = this; while (p) { if (matches(p, sel)) return p; p = p.parentNode; } return null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    hasAttr(k) { return k.startsWith('data-') ? this.dataset[k.slice(5)] !== undefined : this.attrs[k] !== undefined; },
    getAttr(k) { return k.startsWith('data-') ? this.dataset[k.slice(5)] : this.attrs[k]; },
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = v; el.children = []; parseInto(el, v); },
  });
  if (String(tag).toLowerCase() === 'canvas') {
    el.width = 300; el.height = 150; el._xf = null;
    el.getContext = function () {
      return {
        fillStyle: '',
        fillRect() { },
        drawImage() { },
        setTransform(a, b, c, d, e, f) { el._xf = [a, b, c, d, e, f]; },
      };
    };
    el.toDataURL = function (type, q) { el._enc = { type, q }; return 'data:image/jpeg;base64,QUJD'; };
    madeCanvases.push(el);
  }
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
  if ((m = sel.match(/^\[([\w-]+)\]$/))) return el.hasAttr(m[1]);
  if ((m = sel.match(/^\[([\w-]+)="([^"]*)"\]$/))) return el.getAttr(m[1]) === m[2];
  return false;
}

function find(root, sel) {
  const pred = typeof sel === 'function' ? sel : (el => matches(el, sel));
  for (const c of root.children) {
    if (pred(c)) return c;
    const r = find(c, pred);
    if (r) return r;
  }
  return null;
}
function findAll(root, pred, out) {
  out = out || [];
  for (const c of root.children) { if (pred(c)) out.push(c); findAll(c, pred, out); }
  return out;
}

/* ---------------- 环境桩 ---------------- */
const win = {
  _ls: {},
  addEventListener(t, f) { (win._ls[t] = win._ls[t] || []).push(f); },
  removeEventListener(t, f) { if (win._ls[t]) win._ls[t] = win._ls[t].filter(x => x !== f); },
  dispatch(t, ev) { (win._ls[t] || []).slice().forEach(f => f(ev)); },
};
const doc = {
  body: makeEl('body'),
  createElement(tag) { return makeEl(tag); },
  getElementById() { return makeEl('div'); },
};

const sandbox = {
  console, window: win, document: doc, setTimeout, clearTimeout,
  requestAnimationFrame(cb) { cb(0); },
  FileReader: function () {
    this.readAsDataURL = function () { this.result = 'data:image/jpeg;base64,QUJD'; this.onload && this.onload(); };
  },
  Image: function () {
    const o = { naturalWidth: SRC, naturalHeight: SRC_H, onload: null, onerror: null };
    Object.defineProperty(o, 'src', { set() { setTimeout(() => o.onload && o.onload(), 0); } });
    return o;
  },
};
sandbox.window = win;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(css, 'utf8'), sandbox, { filename: css });
const Crop = win.Crop;

/* ---------------- 测试工具 ---------------- */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function near(name, a, b, tol) {
  tol = tol || 2;
  ok(name, Math.abs(a - b) <= tol, '实际 ' + (Math.round(a * 100) / 100) + '，期望 ' + b);
}
const tick = () => new Promise(r => setTimeout(r, 5));

function root() { return doc.body.children[doc.body.children.length - 1] || null; }
function click(act) {
  const r = root();
  const btn = find(r, el => el.dataset.act === act);
  if (!btn) throw new Error('找不到按钮 data-act=' + act);
  (r._ls.click || []).forEach(f => f({ target: btn, preventDefault() { } }));
}
function stage() { const r = root(); return r ? find(r, '[data-stage]') : null; }
function frameEl() { return find(root(), el => hasClass(el, 'crop-frame')); }
function imgEl() { return find(root(), el => el.tagName === 'CANVAS'); }
function pd(target, id, x, y) {
  (stage()._ls.pointerdown || []).forEach(f => f({ target, pointerId: id, clientX: x, clientY: y, preventDefault() { } }));
}
function pm(id, x, y) { win.dispatch('pointermove', { pointerId: id, clientX: x, clientY: y }); }
function pu(id) { win.dispatch('pointerup', { pointerId: id, clientX: 0, clientY: 0 }); }

/* 取最近一次导出：xf = [a,b,c,d,e,f] 即 setTransform 的六个参数 */
function grab() {
  const cv = madeCanvases[madeCanvases.length - 1];
  const xf = cv._xf;
  // 未旋转时 a=m、e=k*(tx-box.x)，可反推出取景框在原图里的位置
  return {
    cv, xf, w: cv.width, h: cv.height,
    u0: -xf[4] / xf[0],
    v0: -xf[5] / xf[3],
  };
}

/* ---------------- 开跑 ---------------- */
(async function () {
  console.log('用例 1：横放照片，默认取景框导出的是哪块原图');
  let p = Crop.open({}, {});
  await tick();
  ok('编辑器已挂载', !!stage() && !!imgEl());
  ok('有 8 个缩放手柄', findAll(root(), el => el.dataset.h !== undefined).length === 8);
  madeCanvases = [];
  click('ok');
  let out = await p;
  ok('返回了 dataURL', /^data:image\/jpeg/.test(out || ''));
  let g = grab();
  near('左上角 u0', g.u0, 40);
  near('左上角 v0', g.v0, 224);
  near('导出宽', g.cv.width, 920);
  near('导出高', g.cv.height, 320);
  near('缩放比 s2', g.xf[0], 1);

  console.log('\n用例 2：拖动取景框平移 20,10 像素');
  p = Crop.reopen();
  await tick();
  pd(frameEl(), 1, 100, 300);
  pm(1, 120, 310);
  pu(1);
  madeCanvases = [];
  click('ok');
  out = await p;
  g = grab();
  near('u0 右移 54.6 原图像素', g.u0, 94.6, 3);
  near('v0 下移 27.3 原图像素', g.v0, 251.3, 3);
  near('框的大小不变，按原图分辨率导出', g.cv.width, 920, 2);
  near('导出高不变', g.cv.height, 320, 2);

  console.log('\n用例 3：拖右下角手柄缩小取景框');
  p = Crop.reopen();
  await tick();
  const se = find(root(), el => el.dataset.h === 'se');
  pd(se, 1, 363, 352);
  pm(1, 300, 330);
  pu(1);
  madeCanvases = [];
  click('ok');
  await p;
  g = grab();
  near('导出宽变小', g.cv.width, 692, 4);
  near('导出高变小', g.cv.height, 231, 4);
  const wBeforeZoom = g.cv.width, hBeforeZoom = g.cv.height;

  console.log('\n用例 4：双指捏合放大图片 2 倍，取景框内的原图区域应减半');
  p = Crop.reopen();
  await tick();
  pd(imgEl(), 1, 100, 300);
  pd(imgEl(), 2, 200, 300);
  pm(2, 300, 300);
  pu(2); pu(1);
  madeCanvases = [];
  click('ok');
  await p;
  g = grab();
  near('放大 2 倍后导出宽减半', g.cv.width, wBeforeZoom / 2, 4);
  near('放大 2 倍后导出高减半', g.cv.height, hBeforeZoom / 2, 4);

  console.log('\n用例 5：旋转 90° 后导出的应是「转过来」的画面（所见即所得）');
  p = Crop.reopen();
  await tick();
  click('rotate');
  madeCanvases = [];
  click('ok');
  await p;
  g = grab();
  near('导出宽 = 屏幕上的框宽（横的）', g.cv.width, 736, 4);
  near('导出高 = 屏幕上的框高', g.cv.height, 400, 4);
  near('原图→输出 缩放为 1（不吃分辨率）', g.xf[0], 0, 0.001);   // a = m·cos90 = 0
  near('旋转分量 b = m·sin90 = m', g.xf[1], 1, 0.01);
  near('旋转分量 c = -m', g.xf[2], -1, 0.01);
  near('偏移 e（框左上角应对应输出原点）', g.xf[4], 767.9, 2);

  console.log('\n用例 6：旋转 90° 后点「整页」导出的是转过来的整张图');
  p = Crop.reopen();
  await tick();
  madeCanvases = [];
  click('full');
  await p;
  g = grab();
  near('整页宽 = 原图高', g.cv.width, SRC_H, 2);
  near('整页高 = 原图宽', g.cv.height, SRC, 2);

  console.log('\n用例 7：取景框拖到图片外的部分，导出为白底（所见即所得）');
  p = Crop.reopen();
  await tick();
  click('reset');            // 上一用例留了旋转，先转回正向再验证位移
  pd(frameEl(), 1, 100, 300);
  pm(1, 320, 560);           // 往右下拖出界
  pu(1);
  madeCanvases = [];
  click('ok');
  await p;
  g = grab();
  ok('框越过原图右边界', g.u0 + g.cv.width > SRC,
    `u0=${g.u0.toFixed(1)} w=${g.cv.width} 右边界=${(g.u0 + g.cv.width).toFixed(1)}`);
  ok('框越过原图下边界', g.v0 + g.cv.height > SRC_H,
    `v0=${g.v0.toFixed(1)} h=${g.cv.height} 下边界=${(g.v0 + g.cv.height).toFixed(1)}`);
  ok('导出尺寸仍等于框的尺寸（没被裁掉）', g.cv.width > 200 && g.cv.height > 100);

  console.log('\n用例 8：取消与重拍');
  p = Crop.reopen();
  await tick();
  click('cancel');
  ok('取消返回 null', (await p) === null);
  ok('编辑器已卸载', !stage());

  let retaken = 0;
  p = Crop.reopen({ onRetake: () => retaken++ });
  await tick();
  click('retake');
  await p;
  ok('重拍回调被调用', retaken === 1);
  ok('重拍后编辑器关闭', !stage());

  console.log('\n用例 9：关闭后仍能用同一张源图继续框');
  ok('hasSource() 为真', Crop.hasSource() === true);
  Crop.clearSource();
  ok('clearSource() 后为假', Crop.hasSource() === false);
  const none = await Crop.reopen();
  ok('没有源图时 reopen 返回 null', none === null);

  console.log('\n用例 10：加载新照片会重置状态');
  madeCanvases = [];
  p = Crop.open({}, {});
  await tick();
  near('源图被压到最长边以内', madeCanvases[0].width, SRC, 1);
  madeCanvases = [];
  click('ok');
  await p;
  g = grab();
  near('新照片回到默认取景框', g.u0, 40);
  near('新照片导出宽', g.cv.width, 920);

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
