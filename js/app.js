/* 启动与路由
 * 启动顺序：绑定全局事件 → Auth.me() 探登录态 → 已登录进入应用 / 未登录显示登录页
 * 登录成功后由 Auth 事件驱动：切换 Store 用户 → 载入该用户的数据 → 渲染各 tab
 */
window.App = (function () {
  var TABS = [
    { id: 'capture', title: '拍照录入', sub: '拍下错题，归入对应科目与年级' },
    { id: 'book', title: '错题本', sub: '按科目与年级查看，点开可让 AI 讲解' },
    { id: 'stats', title: '统计与设置', sub: '错题分布与大模型接口配置' }
  ];

  var panes = {};
  var tab = 'capture';
  var booted = false;   // 已登录并完成 Store 初始化（解锁 tabbar 与各页渲染）

  function go(id) {
    if (!booted) return;
    tab = id;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('is-active', b.dataset.tab === id);
    });
    Object.keys(panes).forEach(function (k) { panes[k].classList.toggle('on', k === id); });

    var t = TABS.filter(function (x) { return x.id === id; })[0] || TABS[0];
    document.getElementById('pageTitle').textContent = t.title;
    document.getElementById('pageSub').textContent = t.sub;

    if (id === 'book') renderBook(panes.book);
    if (id === 'stats') renderStats(panes.stats);
    window.scrollTo(0, 0);
  }

  function renderBook(p) { Views.renderBook(p); }
  function renderStats(p) { Views.renderStats(p); }

  function refreshBook() { if (panes.book) Views.renderBook(panes.book); }
  function refreshStats() { if (panes.stats) Views.renderStats(panes.stats); }

  /* ---------- 文件选择（拍照 / 相册）→ 进入框选编辑器 ----------
   * opts: { retakeInput, hd, tip, onDone } —— onDone 存在时，图片交给它而不是录入队列 */
  function openCropper(file, opts) {
    opts = opts || {};
    Views.toast('载入照片…', 900);
    Crop.open(file, {
      onRetake: function () { document.getElementById(opts.retakeInput || 'fileInput').click(); },
      hd: opts.hd,
      tip: opts.tip
    })
      .then(function (dataUrl) {
        if (!dataUrl) return;                 // 取消 / 重拍
        if (opts.onDone) {
          Crop.clearSource();                 // 别让录入页误以为"还能继续框这张卷子"
          opts.onDone(dataUrl);
          return;
        }
        if (tab !== 'capture') go('capture');
        Views.captureAddImage(dataUrl);
        Views.toast('已加入，可继续框这张卷子上的下一题', 2400);
      })
      .catch(function (e) {
        Views.toast('图片处理失败：' + e.message);
      });
  }

  /* 他人正确解答：独立的输入与文案，框完直接交给详情页上传 */
  function openSolutionCropper(file) {
    openCropper(file, {
      retakeInput: 'fileInputSol',
      hd: '拖动取景框，只框住正确解法那部分',
      tip: '框内是保存的区域 · 只留解答部分，字迹更清楚',
      onDone: function (dataUrl) { Views.solutionImagePicked(dataUrl); }
    });
  }

  function bindOneFileInput(id, handle) {
    var fi = document.getElementById(id);
    if (!fi) return;
    fi.addEventListener('change', function () {
      var f = fi.files && fi.files[0];
      fi.value = '';                          // 允许连续选择同一张图
      if (!f) return;
      if (!/^image\//.test(f.type)) { Views.toast('请选择图片文件'); return; }
      handle(f);
    });
  }

  function bindFileInput() {
    bindOneFileInput('fileInput', openCropper);
    bindOneFileInput('fileInputAlbum', openCropper);
    bindOneFileInput('fileInputSol', openSolutionCropper);
    bindOneFileInput('fileInputSolAlbum', openSolutionCropper);
  }

  function bindGlobal() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () { go(b.dataset.tab); });
    });
    document.getElementById('settingBtn').addEventListener('click', function () {
      go('stats');
    });
    Views.bindUserChip();          // 右上角账号胶囊
    Auth.on(onAuthEvent);          // 订阅登录 / 登出，自动切换整套 UI
    bindFileInput();
  }

  /* ---------- Auth 事件：登录 → 载入该用户数据并渲染；登出 → 回到登录页 ---------- */
  function onAuthEvent(ev) {
    if (ev.type === 'login') {
      Store.setUser(ev.user);
      Store.init().then(mountAfterLogin);
    } else if (ev.type === 'logout') {
      booted = false;
      Store.setUser(null);
      var tabbar = document.querySelector('.tabbar');
      if (tabbar) tabbar.style.display = 'none';
      // 移除所有 pane，避免下次登录重复创建时残留旧节点（里面可能有上一个账号的数据）
      Object.keys(panes).forEach(function (k) {
        var n = panes[k];
        if (n && n.parentNode) n.parentNode.removeChild(n);
      });
      panes = {};
      Views.captureReset();          // 丢掉上一个账号待保存的图片与缓存的照片
      var v = document.getElementById('view');
      v.innerHTML = '';
      Views.showLogin(v);
      Views.renderUserChip();
    }
  }

  function mountAfterLogin() {
    booted = true;
    var v = document.getElementById('view');
    var old = v.querySelector('.auth-wrap');
    if (old) old.remove();
    Views.setAuthed();             // 显示 tabbar + 刷新账号胶囊

    TABS.forEach(function (t) {
      if (panes[t.id]) return;     // 已建过的 pane 不重复创建
      var p = document.createElement('div');
      p.className = 'pane';
      p.id = 'pane-' + t.id;
      v.appendChild(p);
      panes[t.id] = p;
    });

    Views.renderCapture(panes.capture);
    go('capture');
    if (!Store.isOnline()) {
      Views.toast('后端未连接，已进入离线模式', 2600);
    }
  }

  function init() {
    bindGlobal();

    // 会话过期（后端返回 401）时自动回到登录页，别让用户对着没反应的页面
    Store.setAuthExpiredHandler(function () {
      if (!booted) return;
      booted = false;
      Views.toast('登录已过期，请重新登录', 2600);
      Auth.logout();               // 会触发 logout 事件走登出流程
    });

    // 启动先探一次 cookie：有效则 Auth 会派发 login 事件，由 onAuthEvent 接续
    Auth.me().then(function (u) {
      if (u) return;
      var v = document.getElementById('view');
      v.innerHTML = '';
      Views.showLogin(v);
    });
  }

  return { boot: init, go: go, refreshBook: refreshBook, refreshStats: refreshStats };
})();

document.addEventListener('DOMContentLoaded', function () { App.boot(); });
