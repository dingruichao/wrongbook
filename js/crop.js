/* 框选拍照：像小猿搜题那样，拍下整张卷子后拖取景框只框住一道题
 *
 * 为什么是「先拍照、再框选」而不是在相机画面上直接加框：
 * 手机浏览器无法在系统相机里叠加取景框；要自己画预览就得用 getUserMedia，
 * 而它只在 https / localhost 下可用 —— 手机经局域网 http://192.168.x.x:8322
 * 访问时会被浏览器直接禁用摄像头。所以采用等效的框选流程，任何环境都能用。
 *
 * 附带的好处：导出的是原图局部，单题区域不必再被整页缩到 1280，
 * 字迹清楚得多，AI 也不会被同页其它题干扰。
 *
 * 手势：双指捏合=缩放图片｜单指拖框外=平移图片｜拖框内=移动取景框｜
 *       拖 8 个白色手柄=改框大小｜滚轮=缩放（桌面）
 */
window.Crop = (function () {
  'use strict';

  var MAX_SRC = 3200;                  // 载入时源图最长边（省内存，仍足够清楚）
  var MAX_PX = 8e6;                    // 源图总像素上限，iOS 上画布太大容易整块空白
  var MAX_OUT = 1600;                  // 导出区域的最长边
  var MAX_BYTES = 1.2 * 1024 * 1024;   // 导出图片体积上限
  var MIN_FRAME = 56;                  // 取景框最小边长（屏幕像素）

  var src = null;        // { el: canvas, w, h } 源图
  var S = null;          // 编辑状态（关闭后保留，供「再框一题」复用同一张卷子）
  var el = {};           // 当前 DOM 引用
  var ptrs = new Map();  // 活动指针（支持双指）
  var resolveChoice = null;
  var retakeCb = null;
  var winBound = false;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---------------- 载入源图 ---------------- */
  function readImage(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var im = new Image();
        im.onload = function () { resolve(im); };
        im.onerror = function () { reject(new Error('图片解析失败，请换一张试试')); };
        im.src = fr.result;
      };
      fr.onerror = function () { reject(new Error('文件读取失败')); };
      fr.readAsDataURL(file);
    });
  }

  /* 长边压到 MAX_SRC 以内、总像素压到 MAX_PX 以内（超大图在手机上容易超出 canvas 限制） */
  function normalize(im) {
    var w = im.naturalWidth || im.width;
    var h = im.naturalHeight || im.height;
    if (!w || !h) throw new Error('图片尺寸异常');
    var s = Math.min(1, MAX_SRC / Math.max(w, h), Math.sqrt(MAX_PX / (w * h)));
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * s));
    cv.height = Math.max(1, Math.round(h * s));
    var ctx = cv.getContext('2d');
    if (!ctx) throw new Error('当前浏览器无法处理这张图片，请换一张试试');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(im, 0, 0, cv.width, cv.height);
    return { el: cv, w: cv.width, h: cv.height };
  }

  /* ---------------- 几何计算 ---------------- */
  function newState() {
    return {
      rot: 0, scale: 1, fitScale: 1, tx: 0, ty: 0, stageW: 0, stageH: 0,
      rect: { left: 0, top: 0 },
      frame: { x: 0, y: 0, w: 0, h: 0 },
      mode: '', dir: '', start: null, frame0: null, tx0: 0, ty0: 0, gest: null
    };
  }

  function rad() { return S.rot * Math.PI / 180; }

  /* 旋转是绕图片左上角做的，所以旋转后整张图的包围盒会偏到负方向。
   * 这里给出「图片左上角」相对包围盒左上角的偏移（图片像素单位）。 */
  function boxOff() {
    if (S.rot === 90) return { x: -src.h, y: 0 };
    if (S.rot === 180) return { x: -src.w, y: -src.h };
    if (S.rot === 270) return { x: 0, y: -src.w };
    return { x: 0, y: 0 };
  }

  /* 旋转后图片在屏幕上的显示尺寸 */
  function dispSize() {
    var c = Math.abs(Math.cos(rad())), s = Math.abs(Math.sin(rad()));
    return {
      w: (src.w * c + src.h * s) * S.scale,
      h: (src.w * s + src.h * c) * S.scale
    };
  }

  /* 图片在屏幕上的包围盒（tx/ty 是变换原点，不是左上角，别混用） */
  function boxRect() {
    var o = boxOff(), d = dispSize();
    return { x: S.tx + o.x * S.scale, y: S.ty + o.y * S.scale, w: d.w, h: d.h };
  }

  function setBoxLeft(x) { S.tx = x - boxOff().x * S.scale; }
  function setBoxTop(y) { S.ty = y - boxOff().y * S.scale; }

  function fitView() {
    var c = Math.abs(Math.cos(rad())), s = Math.abs(Math.sin(rad()));
    var w0 = src.w * c + src.h * s;
    var h0 = src.w * s + src.h * c;
    S.fitScale = Math.min(S.stageW * 0.94 / w0, S.stageH * 0.94 / h0);
    S.scale = S.fitScale;
    var d = dispSize();
    setBoxLeft((S.stageW - d.w) / 2);
    setBoxTop((S.stageH - d.h) / 2);
  }

  /* 默认取景框：图片可视区中间偏上的一条横带（题目大多是这个形状） */
  function resetFrame() {
    var b = boxRect();
    var x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
    var x1 = Math.min(S.stageW, b.x + b.w), y1 = Math.min(S.stageH, b.y + b.h);
    var vw = Math.max(40, x1 - x0), vh = Math.max(40, y1 - y0);
    S.frame = { x: x0 + vw * 0.04, y: y0 + vh * 0.28, w: vw * 0.92, h: vh * 0.40 };
  }

  function clampPan() {
    var b = boxRect(), pad = 48;
    var cx = (S.stageW - b.w) / 2, cy = (S.stageH - b.h) / 2;
    setBoxLeft(clamp(b.x, Math.min(pad - b.w, cx), Math.max(S.stageW - pad, cx)));
    setBoxTop(clamp(b.y, Math.min(pad - b.h, cy), Math.max(S.stageH - pad, cy)));
  }

  /* ---------------- 渲染 ---------------- */
  function renderImg() {
    el.img.style.width = src.w + 'px';
    el.img.style.height = src.h + 'px';
    el.img.style.transform = 'translate(' + S.tx + 'px,' + S.ty + 'px) rotate(' + S.rot + 'deg) scale(' + S.scale + ')';
  }

  function renderFrame() {
    var f = S.frame;
    el.frame.style.left = f.x + 'px';
    el.frame.style.top = f.y + 'px';
    el.frame.style.width = f.w + 'px';
    el.frame.style.height = f.h + 'px';
  }

  function flashTip(msg) {
    if (!el.tip) return;
    el.tip.textContent = msg;
    el.tip.classList.add('warn');
    clearTimeout(flashTip._t);
    flashTip._t = setTimeout(function () {
      el.tip.classList.remove('warn');
      el.tip.textContent = TIP;
    }, 1800);
  }
  var TIP = '框内是保存的区域 · 双指缩放 · 拖框外平移图片';
  /* 顶部/底部文案可按用途改写（错题录入 vs 他人解答录入） */
  var HD_DEFAULT = '拖动取景框，只框住这一道题';
  var hdText = HD_DEFAULT, tipText = TIP;

  /* ---------------- 导出 ---------------- */
  function encode(cv) {
    var q = 0.92;
    var out = cv.toDataURL('image/jpeg', q);
    while (out.length * 0.75 > MAX_BYTES && q > 0.5) {
      q -= 0.08;
      out = cv.toDataURL('image/jpeg', q);
    }
    return out;
  }

  /* 导出：所见即所得 —— 取景框在屏幕上框住什么，就存什么（旋转也一样生效）
   * box 用屏幕坐标。输出像素按原图分辨率算，最多到 MAX_OUT，不做放大。 */
  function exportRegion(box) {
    if (!box || box.w < 2 || box.h < 2) return null;

    var k = Math.min(1 / S.scale, MAX_OUT / Math.max(box.w, box.h));  // 屏幕像素 → 输出像素
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(box.w * k));
    cv.height = Math.max(1, Math.round(box.h * k));
    var ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);

    // 把「原图 → 屏幕」的变换接到「屏幕 → 输出」上，一次 setTransform 搞定（含旋转）
    var c = Math.cos(rad()), s = Math.sin(rad());
    var m = k * S.scale;
    ctx.setTransform(m * c, m * s, -m * s, m * c, k * (S.tx - box.x), k * (S.ty - box.y));
    ctx.drawImage(src.el, 0, 0);
    return encode(cv);
  }

  /* ---------------- DOM ---------------- */
  function build() {
    var handles =
      '<i class="crop-h hc" data-h="nw"></i><i class="crop-h hc" data-h="ne"></i>' +
      '<i class="crop-h hc" data-h="sw"></i><i class="crop-h hc" data-h="se"></i>' +
      '<i class="crop-h hs" data-h="n"></i><i class="crop-h hs" data-h="s"></i>' +
      '<i class="crop-h hs" data-h="w"></i><i class="crop-h hs" data-h="e"></i>';

    var root = document.createElement('div');
    root.className = 'crop-root';
    root.innerHTML =
      '<div class="crop-hd">' +
        '<button type="button" data-act="cancel">取消</button>' +
        '<div class="crop-hd-t">' + hdText + '</div>' +
        '<button type="button" data-act="ok" class="crop-ok">完成</button>' +
      '</div>' +
      '<div class="crop-stage" data-stage="1">' +
        '<div class="crop-frame">' + handles + '<div class="crop-grid"></div></div>' +
        '<div class="crop-tip">' + TIP + '</div>' +
      '</div>' +
      '<div class="crop-tools">' +
        '<button type="button" data-act="rotate">↻ 旋转</button>' +
        '<button type="button" data-act="full">整页</button>' +
        '<button type="button" data-act="reset">重置</button>' +
        '<button type="button" data-act="retake">重拍</button>' +
      '</div>';
    document.body.appendChild(root);
    return root;
  }

  function measure() {
    var r = el.stage.getBoundingClientRect();
    S.rect = { left: r.left, top: r.top };
    S.stageW = r.width;
    S.stageH = r.height;
  }

  function show() {
    hideDom();
    el.root = build();
    el.stage = el.root.querySelector('[data-stage]');
    el.frame = el.root.querySelector('.crop-frame');
    el.tip = el.root.querySelector('.crop-tip');

    // 直接把源图 canvas 当显示层：省掉一次 base64 编码，也避免额外的内存副本
    src.el.className = 'crop-img';
    el.stage.insertBefore(src.el, el.stage.firstChild);
    el.img = src.el;

    bindButtons();
    bindStage();
    bindWindow();
    document.body.style.overflow = 'hidden';

    requestAnimationFrame(function () {
      if (!el.stage) return;
      measure();
      fitView();
      if (!S.frame.w) resetFrame();
      renderImg();
      renderFrame();
    });
  }

  function hideDom() {
    unbindWindow();
    if (el.root && el.root.parentNode) el.root.parentNode.removeChild(el.root);
    el = {};
    ptrs.clear();
  }

  function hide() {
    hideDom();
    document.body.style.overflow = '';
  }

  function settle(val) {
    var f = resolveChoice;
    resolveChoice = null;
    if (f) f(val);
  }

  /* ---------------- 交互 ---------------- */
  function bindButtons() {
    el.root.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!b) return;
      var a = b.dataset.act;
      if (a === 'cancel') { hide(); settle(null); return; }
      if (a === 'ok') { doExport(S.frame); return; }
      if (a === 'full') {
        doExport(boxRect());
        return;
      }
      if (a === 'rotate') S.rot = (S.rot + 90) % 360;
      else if (a === 'reset') S.rot = 0;
      else if (a === 'retake') {
        var cb = retakeCb;
        hide();
        settle(null);
        if (cb) cb();
        return;
      }
      fitView();
      resetFrame();
      renderImg();
      renderFrame();
    });
  }

  function doExport(box) {
    var out = exportRegion(box);
    if (!out) { flashTip('框选区域几乎不在图片上，请重新框选'); return; }
    hide();
    settle(out);
  }

  function local(e) {
    return { x: e.clientX - S.rect.left, y: e.clientY - S.rect.top };
  }

  function ptrList() {
    var arr = [];
    ptrs.forEach(function (v) { arr.push(v); });
    return arr;
  }

  function pinch() {
    var a = ptrList();
    var dx = a[0].x - a[1].x, dy = a[0].y - a[1].y;
    return { d: Math.max(1, Math.sqrt(dx * dx + dy * dy)), cx: (a[0].x + a[1].x) / 2, cy: (a[0].y + a[1].y) / 2 };
  }

  function onDown(e) {
    if (e.target.closest && e.target.closest('[data-act]')) return;
    ptrs.set(e.pointerId, local(e));
    if (ptrs.size > 2) return;
    e.preventDefault();
    if (ptrs.size === 2) { S.mode = 'pinch'; S.gest = pinch(); return; }

    var h = e.target.closest ? e.target.closest('.crop-h') : null;
    if (h) {
      S.mode = 'resize';
      S.dir = h.dataset.h;
      S.frame0 = { x: S.frame.x, y: S.frame.y, w: S.frame.w, h: S.frame.h };
    } else if (e.target.closest && e.target.closest('.crop-frame')) {
      S.mode = 'move';
      S.frame0 = { x: S.frame.x, y: S.frame.y, w: S.frame.w, h: S.frame.h };
      S.start = local(e);
    } else {
      S.mode = 'pan';
      S.start = local(e);
      S.tx0 = S.tx;
      S.ty0 = S.ty;
    }
  }

  function onMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    var p = local(e);
    ptrs.set(e.pointerId, p);

    if (S.mode === 'pinch' && ptrs.size >= 2) {
      var g = pinch();
      var ns = clamp(S.scale * (g.d / S.gest.d), S.fitScale * 0.4, S.fitScale * 14);
      var k = ns / S.scale;
      // 先以两指中点为中心缩放，再跟着中点平移
      S.tx = S.gest.cx - (S.gest.cx - S.tx) * k;
      S.ty = S.gest.cy - (S.gest.cy - S.ty) * k;
      S.scale = ns;
      S.tx += g.cx - S.gest.cx;
      S.ty += g.cy - S.gest.cy;
      S.gest = g;
      clampPan();
      renderImg();
      return;
    }

    if (S.mode === 'move' && S.frame0) {
      var dx = p.x - S.start.x, dy = p.y - S.start.y;
      S.frame.x = clamp(S.frame0.x + dx, 0, Math.max(0, S.stageW - S.frame0.w));
      S.frame.y = clamp(S.frame0.y + dy, 0, Math.max(0, S.stageH - S.frame0.h));
      renderFrame();
    } else if (S.mode === 'resize' && S.frame0) {
      resizeTo(p);
    } else if (S.mode === 'pan') {
      S.tx = S.tx0 + (p.x - S.start.x);
      S.ty = S.ty0 + (p.y - S.start.y);
      clampPan();
      renderImg();
    }
  }

  function resizeTo(p) {
    var f0 = S.frame0, d = S.dir;
    var right = f0.x + f0.w, bottom = f0.y + f0.h;
    var x = f0.x, y = f0.y, w = f0.w, h = f0.h;
    if (d.indexOf('w') >= 0) { x = clamp(p.x, 0, right - MIN_FRAME); w = right - x; }
    if (d.indexOf('e') >= 0) { w = clamp(p.x - f0.x, MIN_FRAME, S.stageW - f0.x); }
    if (d.indexOf('n') >= 0) { y = clamp(p.y, 0, bottom - MIN_FRAME); h = bottom - y; }
    if (d.indexOf('s') >= 0) { h = clamp(p.y - f0.y, MIN_FRAME, S.stageH - f0.y); }
    S.frame = { x: x, y: y, w: w, h: h };
    renderFrame();
  }

  function onUp(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size === 0) { S.mode = ''; S.gest = null; return; }
    // 双指变单指：把剩下的那根手指改成拖图片，避免手势中断
    if (ptrs.size === 1) {
      var a = ptrList()[0];
      S.mode = 'pan';
      S.start = { x: a.x, y: a.y };
      S.tx0 = S.tx;
      S.ty0 = S.ty;
      S.gest = null;
    }
  }

  function onWheel(e) {
    e.preventDefault();
    var p = local(e);
    var ns = clamp(S.scale * Math.exp(-e.deltaY * 0.0016), S.fitScale * 0.4, S.fitScale * 14);
    var k = ns / S.scale;
    S.tx = p.x - (p.x - S.tx) * k;
    S.ty = p.y - (p.y - S.ty) * k;
    S.scale = ns;
    clampPan();
    renderImg();
  }

  function onResize() {
    if (!el.stage || !S) return;
    var oldW = S.stageW, oldH = S.stageH;
    measure();
    if (Math.abs(S.stageW - oldW) < 2 && Math.abs(S.stageH - oldH) < 2) return;
    fitView();
    resetFrame();
    renderImg();
    renderFrame();
  }

  function bindStage() {
    el.stage.addEventListener('pointerdown', onDown);
    el.stage.addEventListener('wheel', onWheel, { passive: false });
  }

  function bindWindow() {
    if (winBound) return;
    winBound = true;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
  }

  function unbindWindow() {
    if (!winBound) return;
    winBound = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
  }

  /* 应用本次的文案（opts.hd / opts.tip 不传就用错题录入的默认文案） */
  function applyTexts(opts) {
    hdText = (opts && opts.hd) || HD_DEFAULT;
    tipText = (opts && opts.tip) || TIP;
  }

  /* ---------------- 对外接口 ---------------- */
  /* open(file, {onRetake, hd, tip}) → Promise<dataURL | null>，取消时 resolve(null) */
  function open(file, opts) {
    opts = opts || {};
    close();                       // 先关掉可能开着的一次
    return new Promise(function (resolve, reject) {
      readImage(file).then(function (im) {
        try {
          src = normalize(im);
        } catch (err) { reject(err); return; }
        S = newState();
        applyTexts(opts);
        retakeCb = opts.onRetake || null;
        resolveChoice = resolve;
        show();
      }).catch(reject);
    });
  }

  /* 用同一张源图再框一次（一张卷子连续录多道题） */
  function reopen(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      if (!src || !S) { resolve(null); return; }
      applyTexts(opts);
      retakeCb = opts.onRetake || null;
      resolveChoice = resolve;
      show();
    });
  }

  function hasSource() { return !!(src && S); }

  function clearSource() { src = null; S = null; }

  function close() {
    hide();
    settle(null);
  }

  return { open: open, reopen: reopen, hasSource: hasSource, clearSource: clearSource, close: close };
})();
