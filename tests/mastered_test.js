/* 验证「已会 / 还需要复习」：
 *   A. store.js 的筛选与标记（真逻辑，fetch 用桩，不发真请求）
 *   B. 错题本页的「掌握情况」筛选与卡片标记（views.js 渲染）
 *   C. 详情页在删除按钮下面一行的「是否已会」按钮（位置 / 文案 / 点击行为）
 */
const fs = require('fs'), vm = require('vm');
const base = '/Users/dingrc/work/project/wrongbook/js/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
const tick = () => new Promise(r => setTimeout(r, 0));

/* ============================================================
 * A. store.js：筛选 + 标记（走真代码）
 * ============================================================ */
const ITEMS = [
  { id: 'e1', subject: 'math', grade: '8', image: '/uploads/1.jpg', note: '', analysis: null, mastered: false, createdAt: 1000, updatedAt: 1000 },
  { id: 'e2', subject: 'math', grade: '8', image: '/uploads/2.jpg', note: '', analysis: null, mastered: true, createdAt: 2000, updatedAt: 2000 },
  { id: 'e3', subject: 'physics', grade: '9', image: '/uploads/3.jpg', note: '', analysis: null, mastered: false, createdAt: 3000, updatedAt: 3000 },
];
const requests = [];
const ls = {};
const storeSandbox = {
  console,
  localStorage: {
    getItem: k => (k in ls ? ls[k] : null),
    setItem: (k, v) => { ls[k] = v; },
  },
  fetch: (url, opts) => {
    requests.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (url === '/api/errors') return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, items: JSON.parse(JSON.stringify(ITEMS)) }) });
    if (url === '/api/kv/settings') return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, value: {} }) });
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, item: { id: 'e1', mastered: true } }) });
  },
  setTimeout, clearTimeout,
};
storeSandbox.window = storeSandbox;
vm.createContext(storeSandbox);
vm.runInContext(fs.readFileSync(base + 'store.js', 'utf8'), storeSandbox, { filename: 'store.js' });
const S = storeSandbox.Store;
S.setUser({ id: 5 });

(async () => {
  await S.init();
  console.log('=== A. store.js 的筛选与标记 ===');
  ok('不传 mastered = 全部', S.list({}).length === 3, S.list({}).length);
  ok('mastered="1" 只出已会', S.list({ mastered: '1' }).map(x => x.id).join(',') === 'e2', S.list({ mastered: '1' }).map(x => x.id).join(','));
  ok('mastered="0" 只出还需要复习', S.list({ mastered: '0' }).map(x => x.id).join(',') === 'e3,e1', S.list({ mastered: '0' }).map(x => x.id).join(','));
  ok('mastered 与科目可叠加', S.list({ subject: 'math', mastered: '0' }).map(x => x.id).join(',') === 'e1',
    S.list({ subject: 'math', mastered: '0' }).map(x => x.id).join(','));
  ok('mastered="all" 当全部处理', S.list({ mastered: 'all' }).length === 3);
  ok('已会状态不影响原有排序（新→旧）', S.list({}).map(x => x.id).join(',') === 'e3,e2,e1', S.list({}).map(x => x.id).join(','));

  requests.length = 0;
  await S.setMastered('e1', true);
  const patch = requests.filter(r => r.method === 'PATCH')[0];
  ok('setMastered 发 PATCH /api/errors/e1', !!patch && patch.url === '/api/errors/e1', patch && patch.url);
  ok('请求体带 mastered:true', !!patch && patch.body && patch.body.mastered === true, patch && JSON.stringify(patch.body));
  ok('本地状态立刻更新', S.get('e1').mastered === true);

  requests.length = 0;
  await S.setMastered('e2', false);
  const patch2 = requests.filter(r => r.method === 'PATCH')[0];
  ok('取消标记发 mastered:false', !!patch2 && patch2.body.mastered === false, patch2 && JSON.stringify(patch2.body));

  /* ============================================================
   * B/C. views.js：渲染（带缓存 querySelector 的 DOM 桩，能拿到按钮并触发点击）
   * ============================================================ */
  function el() {
    const e = {
      innerHTML: '', value: '', textContent: '', disabled: false, className: '', id: '',
      style: {}, dataset: {}, options: [], _on: {}, _q: {},
      addEventListener(t, fn) { (e._on[t] = e._on[t] || []).push(fn); },
      fire(t, ev) { (e._on[t] || []).forEach(fn => fn.call(e, ev || { target: e, preventDefault() { } })); },
      querySelector(sel) { return (e._q[sel] = e._q[sel] || el()); },
      querySelectorAll() { return []; },
      closest() { return null; }, appendChild() { }, scrollIntoView() { },
      classList: { add() { }, remove() { }, toggle() { } },
    };
    return e;
  }

  const sheetRoot = el();
  const viewItems = [
    { id: 'e1', subject: 'math', grade: '8', image: '/uploads/1.jpg', note: '', analysis: null, mastered: false, createdAt: 1000, updatedAt: 1000, solutions: [], _solLoaded: true },
    { id: 'e2', subject: 'physics', grade: '9', image: '/uploads/2.jpg', note: '', analysis: null, mastered: true, createdAt: 2000, updatedAt: 2000, solutions: [], _solLoaded: true },
  ];
  const marked = [];
  const stubStore = {
    get: id => viewItems.filter(x => x.id === id)[0] || null,
    list: (f) => {
      f = f || {};
      let a = viewItems.slice();
      if (f.subject) a = a.filter(x => x.subject === f.subject);
      if (f.grade) a = a.filter(x => String(x.grade) === String(f.grade));
      if (f.mastered === '1' || f.mastered === '0') a = a.filter(x => !!x.mastered === (f.mastered === '1'));
      return a.sort((x, y) => y.createdAt - x.createdAt);
    },
    getSettings: () => ({}),
    isOnline: () => true,
    update: (id, patch) => { marked.push({ id, patch }); return Promise.resolve({ ok: true }); },
    setMastered: (id, v) => { marked.push({ id, patch: { mastered: v } }); const it = stubStore.get(id); if (it) it.mastered = !!v; return Promise.resolve({ ok: true }); },
    remove: () => Promise.resolve({ ok: true }),
    saveSettings: () => Promise.resolve({ ok: true }),
    gradeName: g => ({ '7': '七年级', '8': '八年级', '9': '九年级' }[String(g)] || '初中'),
    subjectMeta: id => ({ id, name: id === 'math' ? '数学' : '物理', icon: '📐', color: '#000' }),
    all: () => viewItems, loadSolutions: () => Promise.resolve([]),
    addSolution: () => Promise.resolve({ ok: true }), updateSolution: () => Promise.resolve({ ok: true }),
    removeSolution: () => Promise.resolve({ ok: true }),
    providerConfig: () => ({ apiKey: '', model: '' }), setProviderConfig: () => Promise.resolve({ ok: true }),
    SUBJECTS: [{ id: 'math', name: '数学', icon: '📐', color: '#000' }, { id: 'physics', name: '物理', icon: '🧲', color: '#0af' }],
    GRADES: [{ id: '7', name: '七年级' }, { id: '8', name: '八年级' }, { id: '9', name: '九年级' }],
  };
  const viewSandbox = {
    console,
    document: {
      getElementById: id => (id === 'sheetRoot' ? sheetRoot : el()),
      querySelector: () => el(), querySelectorAll: () => [], createElement: () => el(),
    },
    Store: stubStore,
    AI: { analyze: () => Promise.resolve({}), testConnection: () => Promise.resolve(true) },
    App: { refreshBook() { }, refreshStats() { } },
    Image: function () { }, FileReader: function () { }, setTimeout, clearTimeout,
    fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') }),
  };
  viewSandbox.window = viewSandbox;
  vm.createContext(viewSandbox);
  vm.runInContext(fs.readFileSync(base + 'views.js', 'utf8'), viewSandbox, { filename: 'views.js' });
  const Views = viewSandbox.Views;

  console.log('\n=== B. 错题本「掌握情况」筛选 ===');
  const pane = el();
  Views.renderBook(pane);
  const hb = pane.innerHTML;
  ok('有「掌握情况」这一栏', hb.indexOf('掌握情况') >= 0);
  ok('三个选项：全部 / 还需要复习 / 已会',
    hb.indexOf('data-mastered="all"') >= 0 && hb.indexOf('data-mastered="0"') >= 0 && hb.indexOf('data-mastered="1"') >= 0);
  ok('文案带「还需要复习」', hb.indexOf('还需要复习') >= 0);
  ok('默认选「全部」', /data-mastered="all" class="on"/.test(hb));
  ok('已会的题显示 ✓ 已会 标记', hb.indexOf('✓ 已会') >= 0);
  ok('已会的卡片带 is-mastered 类', hb.indexOf('grid-item is-mastered') >= 0);
  ok('还需要复习的卡片不带 is-mastered', (hb.match(/grid-item is-mastered/g) || []).length === 1);
  ok('小结写明各状态数量', hb.indexOf('还需要复习 1 道') >= 0 && hb.indexOf('已会 1 道') >= 0);
  ok('两张卡都渲染了', hb.indexOf('/uploads/1.jpg') >= 0 && hb.indexOf('/uploads/2.jpg') >= 0);

  // 点「还需要复习」→ 只剩未掌握的
  pane.querySelector('#fMastered').fire('click', { target: { closest: () => ({ dataset: { mastered: '0' } }) } });
  const hb0 = pane.innerHTML;
  ok('切到「还需要复习」只剩未掌握的', hb0.indexOf('/uploads/1.jpg') >= 0 && hb0.indexOf('/uploads/2.jpg') < 0);
  ok('筛选后按钮高亮切过去', /data-mastered="0" class="on"/.test(hb0));
  ok('筛选后小结改成「当前筛选 N 道」', hb0.indexOf('当前筛选 1 道') >= 0, (hb0.match(/当前筛选[^<]*/) || [])[0]);

  // 点「已会」→ 只剩已掌握的
  pane.querySelector('#fMastered').fire('click', { target: { closest: () => ({ dataset: { mastered: '1' } }) } });
  const hb1 = pane.innerHTML;
  ok('切到「已会」只剩已掌握的', hb1.indexOf('/uploads/2.jpg') >= 0 && hb1.indexOf('/uploads/1.jpg') < 0);
  // 空结果时的引导语不能是「还没有错题」（那是误导）
  viewItems.forEach(x => { x.mastered = false; });
  Views.renderBook(pane);
  const hb2 = pane.innerHTML;
  ok('「已会」筛不到时给对应文案', hb2.indexOf('还没有已会的错题') >= 0, (hb2.match(/<div class="t">[^<]*/) || [])[0]);
  ok('空结果不出现「去录入页拍下第一道错题」', hb2.indexOf('去「录入」页拍下第一道错题吧') < 0);
  viewItems[1].mastered = true;

  console.log('\n=== C. 详情页「是否已会」 ===');
  sheetRoot.innerHTML = '';
  sheetRoot._q = {};
  marked.length = 0;
  Views.openDetail('e1');
  const hd = sheetRoot.innerHTML;
  ok('详情页有「标记为已会」按钮', hd.indexOf('id="btnMastered"') >= 0);
  ok('按钮在删除按钮下面一行', hd.indexOf('id="btnDel"') < hd.indexOf('id="btnMastered"'),
    'btnDel@' + hd.indexOf('id="btnDel"') + ' btnMastered@' + hd.indexOf('id="btnMastered"'));
  ok('未标记时默认样式是描边（line）', /class="btn full line" id="btnMastered"/.test(hd), (hd.match(/class="btn full[^"]*" id="btnMastered"/) || [])[0]);
  ok('未标记时文案是「标记为已会」', hd.indexOf('>标记为已会<') >= 0);
  ok('有说明文案（可取消）', hd.indexOf('随时能取消') >= 0);

  const bdRoot = sheetRoot.querySelector('.sheet-bd');
  const mBtn = bdRoot.querySelector('#btnMastered');
  mBtn.fire('click');
  await tick();
  await tick();
  ok('点击后调用 setMastered(id, true)', marked.length === 1 && marked[0].id === 'e1' && marked[0].patch.mastered === true,
    JSON.stringify(marked));
  ok('按钮立刻变成已会态（ok 样式 + 勾）', mBtn.className === 'btn full ok' && mBtn.textContent.indexOf('✅ 已会') === 0,
    mBtn.className + ' / ' + mBtn.textContent);
  ok('按钮重新可用（没卡在 disabled）', mBtn.disabled === false);

  mBtn.fire('click');
  await tick();
  await tick();
  ok('再点一次取消标记', marked.length === 2 && marked[1].patch.mastered === false, JSON.stringify(marked));
  ok('按钮回到描边态', mBtn.className === 'btn full line' && mBtn.textContent === '标记为已会', mBtn.className + ' / ' + mBtn.textContent);

  // 打开一道「已会」的题，按钮应直接是已会态
  sheetRoot.innerHTML = '';
  sheetRoot._q = {};
  Views.openDetail('e2');
  const hd2 = sheetRoot.innerHTML;
  ok('已会的题打开就是已会态', /class="btn full ok" id="btnMastered"/.test(hd2), (hd2.match(/class="btn full[^"]*" id="btnMastered"/) || [])[0]);
  ok('已会态文案是「点一下取消」', hd2.indexOf('✅ 已会（点一下取消）') >= 0);
  ok('详情页无 undefined', hd2.indexOf('undefined') < 0);

  console.log('\n==============================================');
  console.log('已会/复习功能：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) process.exitCode = 1;
})();
