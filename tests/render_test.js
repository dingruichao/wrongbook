/* 轻量验证：在 Node 里用 DOM 桩执行 views.js 的 renderStats，检查设置页是否正确渲染服务商下拉 */
const fs = require('fs');
const vm = require('vm');
const path = '/Users/dingrc/work/project/wrongbook/js/views.js';

function fakeEl() {
  const el = {
    innerHTML: '', value: '', textContent: '', disabled: false, selectedIndex: 0,
    style: {}, options: [], dataset: {},
    addEventListener() { }, classList: { add() { }, remove() { }, toggle() { } },
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
    closest() { return null; },
    appendChild() { },
  };
  return el;
}

const settings = {
  apiBase: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  apiKey: 'sk-sp-test',
  model: 'qwen3.7-plus',
  currentProvider: 'bailian_tokenplan',
  providers: {
    siliconflow: { apiKey: 'sk-a', model: 'Qwen/Qwen2.5-VL-32B-Instruct' },
    bailian_tokenplan: { apiKey: 'sk-sp-test', model: 'qwen3.7-plus' },
    amd: { apiKey: 'rc-b', model: 'Qwen3.8-Flash-Next' },
  },
  defaultSubject: 'math', defaultGrade: '8',
};

const sandbox = {
  console,
  document: {
    getElementById: () => fakeEl(),
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    createElement: () => fakeEl(),
  },
  Store: {
    getSettings: () => settings,
    saveSettings: (p) => { Object.assign(settings, p); return Promise.resolve({ ok: true }); },
    providerConfig: (id) => (settings.providers[id] || { apiKey: '', model: '' }),
    setProviderConfig: (id, cfg) => { settings.providers[id] = cfg; return Promise.resolve({ ok: true }); },
    isOnline: () => true,
    all: () => [], list: () => [],
    SUBJECTS: [{ id: 'math', name: '数学', icon: '📐', color: '#4f46e5' }, { id: 'physics', name: '物理', icon: '🧲', color: '#0891b2' }],
    GRADES: [{ id: '7', name: '七年级' }, { id: '8', name: '八年级' }, { id: '9', name: '九年级' }],
    subjectMeta: (id) => ({ id, name: id, icon: '📘', color: '#000' }),
    gradeName: (id) => id,
  },
  AI: { testConnection: () => Promise.resolve(true) },
  App: { refreshBook() { }, refreshStats() { } },
  Image: function () { }, FileReader: function () { },
  setTimeout, clearTimeout,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path, 'utf8'), sandbox, { filename: path });

const pane = fakeEl();
sandbox.Views.renderStats(pane);
const html = pane.innerHTML;

const optCount = (html.match(/<option/g) || []).length;
const provOpts = (html.match(/<option value="(siliconflow|openai|bailian|bailian_tokenplan|zhipu|amd|litellm|custom)"/g) || []);
console.log('服务商下拉 select#cfgProvider :', html.includes('id="cfgProvider"') ? '✅ 已渲染' : '❌ 缺失');
console.log('服务商选项数量             :', provOpts.length, provOpts.length === 8 ? '✅' : '❌');
console.log('当前选中项                 :', /value="bailian_tokenplan" selected/.test(html) ? '✅ bailian_tokenplan' : '⚠️  ' + (html.match(/value="[a-z_]+" selected/) || ['无'])[0]);
console.log('百炼计划下拉(应显示)       :', /id="cfgPlanField" style="display:"/.test(html) ? '✅ 显示' : '❌ 未显示');
console.log('计划选项(应为6个)          :', (html.match(/<option value="qwen/g) || []).length);
console.log('测试连接按钮               :', html.includes('id="btnTest"') ? '✅' : '❌');
console.log('保存按钮                   :', html.includes('id="btnSaveCfg"') ? '✅' : '❌');
console.log('API Key 回填               :', html.includes('value="sk-sp-test"') ? '✅' : '❌');
console.log('Key 输入框 placeholder     :', (html.match(/placeholder="(sk-[^"]*)"/) || [])[1]);
console.log('总 option 数               :', optCount);
