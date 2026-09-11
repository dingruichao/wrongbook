/* 验证：v2 分析结果在错题详情页的渲染 + v1 旧记录兼容 + 提示词内容 */
const fs = require('fs'), vm = require('vm');
const base = '/Users/dingrc/work/project/wrongbook/js/';

function fakeEl() {
  return {
    innerHTML: '', value: '', textContent: '', disabled: false, selectedIndex: 0,
    style: {}, options: [], dataset: {},
    addEventListener() { }, classList: { add() { }, remove() { }, toggle() { } },
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    closest() { return null; }, appendChild() { },
  };
}

const sheetRoot = fakeEl();
const ITEM = {
  id: 'e1', subject: 'math', grade: '8', image: '/uploads/a.jpg',
  note: '第3题，我答的是36', createdAt: Date.now(), updatedAt: Date.now(),
  analysis: {
    schema: 'v3',
    question: '一个长方形的长是 8cm，宽是 5cm，求面积',
    studentAnswer: '36',
    answer: '40 cm²',
    why: '长方形面积一定用到「长 × 宽」，看到「面积」「长」「宽」三个词就能想到 S=ab',
    steps: ['写出面积公式 S = 长 × 宽', '代入 8 × 5，依据是面积定义本身'],
    knowledge: '长方形面积公式',
    causeType: '计算失误',
    causeDetail: '学生答 36，把 8×5 算成了 8×4.5，属于口诀记忆错误',
    fixOneLine: '8×5=40，不是 36，背口诀后要验算',
    tip: '注意 5×8 与 6×6 的区别',
    similar: { q: '长 12cm、宽 4cm 的长方形面积？', a: '48 cm²', hint: '同样用长×宽' },
    reviewDays: 3,
    reviewFocus: '重做时先写公式再代数',
    uncertain: false,
    raw: '...', model: 'test', noteUsed: '第3题，我答的是36', analyzedAt: Date.now(),
  },
};

const OLD_ITEM = JSON.parse(JSON.stringify(ITEM));
OLD_ITEM.analysis = { question: '旧版题目', answer: '旧版答案', steps: ['一步'], knowledge: '旧知识点', tip: '旧易错点', raw: '...', model: 'old', analyzedAt: 1 };

let currentItem = ITEM;
let captured = null;

const sandbox = {
  console,
  document: {
    getElementById: (id) => (id === 'sheetRoot' ? sheetRoot : fakeEl()),
    querySelector: () => fakeEl(), querySelectorAll: () => [], createElement: () => fakeEl(),
  },
  Store: {
    get: () => currentItem,
    getSettings: () => ({ apiBase: 'https://x/v1', apiKey: 'sk-t', model: 'Qwen2.5-VL' }),
    update: () => Promise.resolve({ ok: true }),
    remove: () => Promise.resolve({ ok: true }),
    saveSettings: () => Promise.resolve({ ok: true }),
    gradeName: (g) => ({ '7': '七年级', '8': '八年级', '9': '九年级' }[String(g)] || '初中'),
    subjectMeta: (id) => ({ id, name: id === 'math' ? '数学' : '物理', icon: '📐', color: '#000' }),
    all: () => [], list: () => [], providerConfig: () => ({ apiKey: '', model: '' }),
    setProviderConfig: () => Promise.resolve({ ok: true }),
    // 他人正确解答（详情页懒加载这些）
    loadSolutions: () => Promise.resolve(currentItem.solutions || []),
    addSolution: () => Promise.resolve({ ok: true }),
    updateSolution: () => Promise.resolve({ ok: true }),
    removeSolution: () => Promise.resolve({ ok: true }),
    SUBJECTS: [], GRADES: [],
  },
  AI: { analyze: () => Promise.resolve({}), testConnection: () => Promise.resolve(true) },
  App: { refreshBook() { }, refreshStats() { } },
  Image: function () { }, FileReader: function () { }, setTimeout, clearTimeout,
  fetch: (u, o) => { captured = captured || JSON.parse(o.body); return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: '{}' } }] })) }); },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const STUB_STORE = sandbox.Store;
vm.runInContext(fs.readFileSync(base + 'store.js', 'utf8'), sandbox, { filename: 'store.js' });
sandbox.Store = STUB_STORE;      // store.js 会覆盖 window.Store，这里换回桩
sandbox.window.Store = STUB_STORE;
vm.runInContext(fs.readFileSync(base + 'ai.js', 'utf8'), sandbox, { filename: 'ai.js' });
vm.runInContext(fs.readFileSync(base + 'views.js', 'utf8'), sandbox, { filename: 'views.js' });

/* ---- 1. 详情页渲染（v2） ---- */
currentItem = ITEM;
sandbox.Views.openDetail('e1');
const h = sheetRoot.innerHTML;
const checks = [
  ['题目', '一个长方形的长是 8cm'],
  ['学生原答案', '✍️ 学生原答案'],
  ['正确答案', '40 cm²'],
  ['为什么这样做标签', '💡 为什么这样做'],
  ['为什么这样做正文', '看到「面积」「长」「宽」三个词就能想到'],
  ['分步讲解标签', '📝 分步讲解'],
  ['分步讲解正文', '写出面积公式 S = 长 × 宽'],
  ['分步讲解含依据', '依据是面积定义本身'],
  ['知识点', '长方形面积公式'],
  ['错因标签', '<span class="pill">计算失误</span>'],
  ['错因依据', '把 8×5 算成了 8×4.5'],
  ['一句话订正', '✏️ 一句话订正'],
  ['易错点', '⚠️ 易错点'],
  ['同类变式题', '长 12cm、宽 4cm'],
  ['同类题提示', '提示：同样用长×宽'],
  ['同类题答案', '参考答案：48 cm²'],
  ['复习安排', '3 天后重做这道题'],
  ['复习重点', '先写公式再代数'],
  ['备注回显', 'value="第3题，我答的是36"'],
  ['分析用备注', '本次分析参考的备注'],
];
let pass = 0;
console.log('=== 1. 详情页 v2 渲染 ===');
checks.forEach(([n, s]) => { const ok = h.includes(s); if (ok) pass++; console.log((ok ? '✅' : '❌') + ' ' + n); });
console.log('不放未定义字段:', h.includes('undefined') ? '❌ 出现 undefined' : '✅');

/* ---- 2. 旧版 v1 记录兼容 ---- */
console.log('\n=== 2. 旧版 v1 记录兼容 ===');
currentItem = OLD_ITEM;
sheetRoot.innerHTML = '';
sandbox.Views.openDetail('e1');
const h2 = sheetRoot.innerHTML;
console.log((h2.includes('旧版题目') && h2.includes('旧知识点') && h2.includes('旧易错点') ? '✅' : '❌') + ' 旧字段照常显示');
console.log((h2.includes('undefined') ? '❌ 出现 undefined' : '✅') + ' 不因缺新字段而报错');
console.log((h2.includes('错因分析') ? '❌ 不该出现空错因' : '✅') + ' 无数据时不渲染空模块');

/* ---- 2b. 分析质量提示条（2026-09-11 新增） ---- */
console.log('\n=== 2b. 分析质量提示 ===');
const Q_ITEM = JSON.parse(JSON.stringify(ITEM));
currentItem = Q_ITEM;
Q_ITEM.analysis.quality = 'good';
Q_ITEM.analysis.warnings = [];
sheetRoot.innerHTML = '';
sandbox.Views.openDetail('e1');
console.log((sheetRoot.innerHTML.includes('这次分析没成功') || sheetRoot.innerHTML.includes('结果仅供参考')
  ? '❌' : '✅') + ' quality=good 不弹提示');

Q_ITEM.analysis.quality = 'partial';
Q_ITEM.analysis.warnings = ['已自动过滤 178 条模型的思考过程'];
sheetRoot.innerHTML = '';
sandbox.Views.openDetail('e1');
const hp = sheetRoot.innerHTML;
console.log((hp.includes('已自动过滤 178 条模型的思考过程') ? '✅' : '❌') + ' partial 显示具体原因');
console.log((hp.includes('重新分析') ? '✅' : '❌') + ' partial 建议重新分析');

Q_ITEM.analysis.quality = 'low';
Q_ITEM.analysis.warnings = ['模型输出被长度上限截断，内容可能不完整'];
Q_ITEM.analysis._unparsed = true;
sheetRoot.innerHTML = '';
sandbox.Views.openDetail('e1');
const hl = sheetRoot.innerHTML;
console.log((hl.includes('这次分析没成功') ? '✅' : '❌') + ' low 明确说没成功');
console.log((hl.includes('重新拍照') ? '✅' : '❌') + ' low 给出重拍建议');
console.log((hl.includes('undefined') ? '❌ 出现 undefined' : '✅') + ' 提示条不出现 undefined');

/* ---- 2c. 他人正确解答区块（2026-09-11 新增） ---- */
console.log('\n=== 2c. 他人正确解答区块 ===');
let solPass = 0, solTotal = 0;
const solOk = (n, c) => { solTotal++; if (c) solPass++; console.log((c ? '✅' : '❌') + ' ' + n); };

const NO_SOL = JSON.parse(JSON.stringify(ITEM));
NO_SOL.solutions = [];
currentItem = NO_SOL;
sheetRoot.innerHTML = '';
sandbox.Views.openDetail('e1');
const h0 = sheetRoot.innerHTML;
solOk('有「他人正确解答」小标题', h0.indexOf('👥 他人正确解答') >= 0);
solOk('文案写明可多张', h0.indexOf('可多张') >= 0);
solOk('空状态有引导语', h0.indexOf('还没有他人解答') >= 0);
solOk('有拍照按钮', h0.indexOf('id="solPick"') >= 0);
solOk('有相册按钮', h0.indexOf('id="solAlbum"') >= 0);
solOk('区块排在备注之后', h0.indexOf('id="noteInput"') < h0.indexOf('id="solBox"'));
solOk('区块排在分析结果之前', h0.indexOf('id="solBox"') < h0.indexOf('id="analysisBox"'));
solOk('空状态下无 undefined', h0.indexOf('undefined') < 0);

const WITH_SOL = JSON.parse(JSON.stringify(ITEM));
WITH_SOL.solutions = [
  { id: 's1', errorId: 'e1', image: '/uploads/s1.jpg', note: '张老师的解法', createdAt: 1, updatedAt: 1 },
  { id: 's2', errorId: 'e1', image: '/uploads/s2.jpg', note: '', createdAt: 2, updatedAt: 2 },
];
currentItem = WITH_SOL;
sheetRoot.innerHTML = '';
sandbox.Views.openDetail('e1');
const h1s = sheetRoot.innerHTML;
solOk('两张缩略图都渲染', h1s.indexOf('/uploads/s1.jpg') >= 0 && h1s.indexOf('/uploads/s2.jpg') >= 0);
solOk('缩略图带序号 1 / 2', h1s.indexOf('>1<') >= 0 && h1s.indexOf('>2<') >= 0);
solOk('说明文字渲染出来', h1s.indexOf('张老师的解法') >= 0);
solOk('每张都有删除按钮', (h1s.match(/data-delsol=/g) || []).length === 2);
solOk('每张都能点开大图', (h1s.match(/data-view=/g) || []).length === 2);

const EVIL = JSON.parse(JSON.stringify(ITEM));
EVIL.solutions = [{ id: 's1', errorId: 'e1', image: '/a.jpg', note: '<img src=x onerror=alert(1)>', createdAt: 1, updatedAt: 1 }];
currentItem = EVIL;
sheetRoot.innerHTML = '';
sandbox.Views.openDetail('e1');
const h2e = sheetRoot.innerHTML;
solOk('说明里的 HTML 被转义（防注入）', h2e.indexOf('<img src=x onerror=') < 0 && h2e.indexOf('&lt;img src=x') >= 0);

/* ---- 3. 提示词 ---- */
console.log('\n=== 3. 提示词（skill 方法论是否编译进去） ===');
sandbox.window.AI.analyze('data:image/jpeg;base64,AA', 'math', '8', '第3题，我答的是36').then(() => {
  const t = captured.messages[0].content.filter(c => c.type === 'text').map(c => c.text).join('');
  const must = [
    ['只输出 JSON', '只输出一个 JSON'],
    ['反循环:最多复核一次', '最多复核一次'],
    ['自算与答案冲突就标 uncertain', 'uncertain 设为 true'],
    ['禁止自我怀疑字句', '严禁出现「让我再看」'],
    ['why 是为什么这样做', 'why 是「为什么这样做」'],
    ['why 不超过 120 字', '不超过 120 字'],
    ['steps 升级为分步讲解', 'steps 是「分步讲解」'],
    ['steps 限 3-5 步 60 字', '每步不超过 60 字'],
    ['steps 每步写清依据', '每步写清「做什么 + 为什么这么做（依据）」'],
    ['篇幅上限', '全文不超过 800 字'],
    ['禁止只给答案', '不许只给答案'],
    ['不许都算粗心', '不许一律归为粗心'],
    ['备注写答案用于判错因', '我答的是'],
    ['备注写题号用于锁题', '题号'],
    ['看不出作答的兜底', '未看到学生作答痕迹'],
    ['JSON 含 causeType', '"causeType"'],
    ['JSON 含 why（紧跟 answer）', '"answer":"","why"'],
    ['JSON 含 similar', '"similar"'],
    ['JSON 含 reviewDays', '"reviewDays"'],
    ['steps 仍排在最后（截断保护）', '"uncertain":false,"steps"'],
    ['识别不出题目时的兜底', '未能识别题目'],
    ['年级匹配', '八年级'],
    ['数学定制提示', '分类讨论'],
  ];
  let p = 0;
  must.forEach(([n, s]) => { const ok = t.includes(s); if (ok) p++; console.log((ok ? '✅' : '❌') + ' ' + n); });
  console.log('\n渲染检查通过 ' + pass + '/' + checks.length +
    '，他人解答区块 ' + solPass + '/' + solTotal +
    '，提示词检查通过 ' + p + '/' + must.length);
});
