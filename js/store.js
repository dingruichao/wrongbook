/* 数据层：错题 CRUD + 设置 + 科目年级定义
 * 设计：以后端 PostgreSQL 为准；网络不可用时退化为 localStorage 兜底，保证页面永远可用。
 *       登录后数据按用户隔离——服务端按 Cookie 判断用户，本地兜底缓存也按 userId 分目录。
 */
window.Store = (function () {
  var LS_BASE = 'wrongbook.v1';
  var currentUserId = null;   // 当前登录用户 id（未登录为 null）

  // 本地兜底缓存按用户隔离：wrongbook.v1.errors.<userId>
  // 否则换账号登录后会看到上一个账号残留在本机的数据
  function lsErrorsKey() { return LS_BASE + '.errors' + (currentUserId ? '.' + currentUserId : ''); }
  function lsKvKey() { return LS_BASE + '.kv' + (currentUserId ? '.' + currentUserId : ''); }

  /* ---------- 科目与年级（先做数学、物理；后续加科目只改这里） ---------- */
  var SUBJECTS = [
    { id: 'math', name: '数学', icon: '📐', color: '#4f46e5' },
    { id: 'physics', name: '物理', icon: '🧲', color: '#0891b2' }
  ];
  var GRADES = [
    { id: '7', name: '七年级' },
    { id: '8', name: '八年级' },
    { id: '9', name: '九年级' }
  ];

  function subjectName(id) {
    for (var i = 0; i < SUBJECTS.length; i++) if (SUBJECTS[i].id === id) return SUBJECTS[i].name;
    return id;
  }
  function subjectMeta(id) {
    for (var i = 0; i < SUBJECTS.length; i++) if (SUBJECTS[i].id === id) return SUBJECTS[i];
    return { id: id, name: id, icon: '📘', color: '#64748b' };
  }
  function gradeName(id) {
    for (var i = 0; i < GRADES.length; i++) if (GRADES[i].id === String(id)) return GRADES[i].name;
    return id;
  }

  var DEFAULT_SETTINGS = {
    // OpenAI 兼容接口（默认 SiliconFlow 的 Qwen2.5-VL，视觉能力强、有免费额度）
    apiBase: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'Qwen/Qwen2.5-VL-32B-Instruct',
    // 服务商：currentProvider 为当前选中的服务商 id（'' 表示旧数据，首次打开设置时按 apiBase 迁移）
    // providers 按服务商各自存 { apiKey, model }，切换服务商时互不干扰
    currentProvider: '',
    providers: {},
    // 深度思考：默认关闭。qwen3.x-max/plus 这类推理模型开着会先"想"几十秒（实测读一张图 40s+），
    // 关掉后 1-2 秒返回且照样能看懂图；需要更严谨的推演时可在设置页打开（会明显变慢）。
    deepThinking: false,
    // 默认筛选
    defaultSubject: 'math',
    defaultGrade: '7'
  };

  var cache = null;     // 错题数组缓存
  var settings = null;  // 设置缓存
  var online = true;    // 后端是否可用

  /* ---------- 本地兜底 ---------- */
  function lsGet(k, def) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { }
  }

  /* ---------- 会话过期通知 ----------
   * 登录态在 HttpOnly Cookie 里，前端看不到有效期。一旦后端返回 401（cookie 过期/被清），
   * 通知 App 回到登录页，避免用户对着一个"怎么点都没反应"的页面发呆。 */
  var onAuthExpired = null;
  function setAuthExpiredHandler(fn) { onAuthExpired = fn; }
  function api(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (r) {
      if (r.status === 401 && onAuthExpired) onAuthExpired();
      return r;
    });
  }

  /* ---------- 初始化 ---------- */
  // 必须在 Auth.me() 确认登录后、setUser(u) 之后再调用，这样本地缓存才会落在正确的用户目录下
  function init() {
    settings = Object.assign({}, DEFAULT_SETTINGS, lsGet(lsKvKey(), {}));
    return api('/api/errors', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { cache = j.items || []; online = true; }
        else { cache = lsGet(lsErrorsKey(), []); online = false; }
        return cache;
      })
      .catch(function () {
        online = false;
        cache = lsGet(lsErrorsKey(), []);
        return cache;
      })
      .then(function () {
        return api('/api/kv/settings', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok && j.value) settings = Object.assign({}, DEFAULT_SETTINGS, j.value);
          })
          .catch(function () { });
      });
  }

  /* ---------- 登录用户切换 ---------- */
  function setUser(u) {
    currentUserId = (u && u.id) || null;
    cache = null; settings = null; online = true;
  }
  function getUser() { return currentUserId; }

  function isOnline() { return online; }

  /* ---------- 查询 ----------
   * filter.mastered: '' / undefined = 不限；'1' = 已会；'0' = 还需要复习
   * （服务端也用同一套语义，列表接口带 ?mastered=1|0） */
  function all() { return cache || []; }
  function list(filter) {
    filter = filter || {};
    var arr = all().slice();
    if (filter.subject) arr = arr.filter(function (x) { return x.subject === filter.subject; });
    if (filter.grade) arr = arr.filter(function (x) { return String(x.grade) === String(filter.grade); });
    if (filter.mastered === '1' || filter.mastered === '0') {
      var want = filter.mastered === '1';
      arr = arr.filter(function (x) { return !!x.mastered === want; });
    }
    return arr.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  }
  function get(id) {
    var arr = all();
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  /* ---------- 新增 ---------- */
  function add(item) {
    // item: { subject, grade, image(dataURL), note }
    if (!online) {
      var local = {
        id: 'L' + Date.now() + Math.random().toString(36).slice(2, 8),
        subject: item.subject,
        grade: String(item.grade),
        image: item.image,          // 离线时直接存 dataURL
        note: item.note || '',
        analysis: null,
        mastered: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        _local: true
      };
      cache.unshift(local);
      lsSet(lsErrorsKey(), cache);
      return Promise.resolve({ ok: true, item: local, offline: true });
    }
    return api('/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && j.item) { cache.unshift(j.item); }
      return j;
    });
  }

  /* ---------- 更新（保存 AI 分析结果 / 备注） ---------- */
  function update(id, patch) {
    var it = get(id);
    if (it) Object.assign(it, patch, { updatedAt: Date.now() });
    if (!online || (it && it._local)) { lsSet(lsErrorsKey(), all()); return Promise.resolve({ ok: true }); }
    return api('/api/errors/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }).then(function (r) { return r.json(); });
  }

  /* ---------- 是否已会 ----------
   * 详情页的「标记已会 / 取消标记」都走这里：本地先改（界面立刻响应），再存服务端。 */
  function setMastered(id, v) {
    return update(id, { mastered: !!v });
  }

  /* ---------- 删除 ---------- */
  function remove(id) {
    var idx = -1, arr = all();
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) { idx = i; break; }
    if (idx >= 0) arr.splice(idx, 1);
    if (!online) { lsSet(lsErrorsKey(), arr); return Promise.resolve({ ok: true }); }
    return api('/api/errors/' + id, { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .catch(function () { lsSet(lsErrorsKey(), arr); return { ok: true }; });
  }

  /* ---------- 他人正确解答（一条错题 N 张，单独存 solutions 表） ----------
   * 懒加载：详情页打开时才拉，避免列表接口变重；拉过一次就缓存在 item 上。
   * 离线模式直接存在 item.solutions 里，随本地兜底缓存一起落 localStorage。 */
  function loadSolutions(errorId) {
    var it = get(errorId);
    if (!it) return Promise.resolve([]);
    if (!online || it._local) return Promise.resolve(it.solutions || []);
    if (it._solLoaded && it.solutions) return Promise.resolve(it.solutions);
    return api('/api/errors/' + errorId + '/solutions', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { it.solutions = j.items || []; it._solLoaded = true; }
        return it.solutions || [];
      })
      .catch(function () { return it.solutions || []; });
  }

  function addSolution(errorId, data) {
    var it = get(errorId);
    if (!online || (it && it._local)) {
      var local = {
        id: 'L' + Date.now() + Math.random().toString(36).slice(2, 8),
        errorId: errorId, image: data.image, note: data.note || '',
        createdAt: Date.now(), updatedAt: Date.now(), _local: true
      };
      if (it) {
        it.solutions = (it.solutions || []).concat([local]);
        it.solutionCount = it.solutions.length;
        lsSet(lsErrorsKey(), all());
      }
      return Promise.resolve({ ok: true, item: local, offline: true });
    }
    return api('/api/errors/' + errorId + '/solutions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: data.image, note: data.note || '' })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && j.item && it) {
        it.solutions = (it.solutions || []).concat([j.item]);
        it.solutionCount = it.solutions.length;
      }
      return j;
    });
  }

  /* 找到某个解答所属的错题（用于按 sid 改/删） */
  function findSolution(sid) {
    var arr = all();
    for (var i = 0; i < arr.length; i++) {
      var list = arr[i].solutions || [];
      for (var k = 0; k < list.length; k++) if (list[k].id === sid) return { item: arr[i], sol: list[k] };
    }
    return null;
  }

  function updateSolution(sid, patch) {
    var hit = findSolution(sid);
    if (!hit) return Promise.resolve({ ok: false, error: 'not found' });
    Object.assign(hit.sol, patch, { updatedAt: Date.now() });
    if (!online || hit.item._local) { lsSet(lsErrorsKey(), all()); return Promise.resolve({ ok: true }); }
    return api('/api/solutions/' + sid, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }).then(function (r) { return r.json(); });
  }

  function removeSolution(sid) {
    var hit = findSolution(sid);
    if (hit) {
      hit.item.solutions = (hit.item.solutions || []).filter(function (s) { return s.id !== sid; });
      hit.item.solutionCount = hit.item.solutions.length;
    }
    if (!online || (hit && hit.item._local)) { lsSet(lsErrorsKey(), all()); return Promise.resolve({ ok: true }); }
    return api('/api/solutions/' + sid, { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: true }; });
  }

  /* ---------- 设置（服务端按用户存成 settings.<userId>） ---------- */
  function getSettings() { return settings || Object.assign({}, DEFAULT_SETTINGS); }

  /* 每服务商独立的 key / model（base 由服务商固定地址决定，不在这里存） */
  function providerConfig(provId) {
    var s = getSettings();
    var p = (s.providers && s.providers[provId]) || {};
    return { apiKey: p.apiKey || '', model: p.model || '' };
  }
  function setProviderConfig(provId, cfg) {
    var s = getSettings();
    if (!s.providers) s.providers = {};
    s.providers[provId] = {
      apiKey: (cfg && cfg.apiKey) || '',
      model: (cfg && cfg.model) || ''
    };
    return saveSettings({ providers: s.providers });
  }

  function saveSettings(patch) {
    settings = Object.assign(getSettings(), patch);
    lsSet(lsKvKey(), settings);
    if (!online) return Promise.resolve({ ok: true });
    return api('/api/kv/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    }).then(function (r) { return r.json(); }).catch(function () { return { ok: true }; });
  }

  return {
    SUBJECTS: SUBJECTS, GRADES: GRADES,
    subjectName: subjectName, subjectMeta: subjectMeta, gradeName: gradeName,
    init: init, isOnline: isOnline,
    setUser: setUser, getUser: getUser, setAuthExpiredHandler: setAuthExpiredHandler,
    all: all, list: list, get: get,
    add: add, update: update, remove: remove, setMastered: setMastered,
    loadSolutions: loadSolutions, addSolution: addSolution,
    updateSolution: updateSolution, removeSolution: removeSolution,
    getSettings: getSettings, saveSettings: saveSettings,
    providerConfig: providerConfig, setProviderConfig: setProviderConfig
  };
})();
