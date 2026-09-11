/* 端到端：用真实 js/ai.js + 真实上游模型跑一次 analyze，校验输出质量自检 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const { Client } = require('pg');
const base = '/Users/dingrc/work/project/wrongbook/js/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

(async () => {
  // ---------- 单元：sanitizeSteps ----------
  console.log('用例 1：sanitizeSteps 清洗模型思考痕迹');
  const sandbox = {
    console, setTimeout, clearTimeout,
    document: { getElementById: () => null, createElement: () => ({ getContext: () => ({}), toDataURL: () => '' }) },
    Store: {
      getSettings: () => ({}),
      gradeName: (g) => ({ '7': '七年级', '8': '八年级', '9': '九年级' }[String(g)] || '初中'),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(base + 'ai.js', 'utf8'), sandbox, { filename: 'ai.js' });
  const AI = sandbox.AI;

  const dirty = [
    '1. 简化电路：四电阻并联，电压表测电源电压。',
    '2. 算支路电流：每个 3Ω 电阻 4A。',
    '等等，让我重新看电路图连接。',
    '不对，这样算出来和选项不符。',
    '第三步：判断电流表测哪部分电流。',
    '   ',
    'x'.repeat(300),
  ];
  const clean = AI.sanitizeSteps(dirty);
  ok('去掉重复行首序号', clean[0] === '简化电路：四电阻并联，电压表测电源电压。', clean[0]);
  ok('保留正常步骤', clean.some(s => s.indexOf('算支路电流') === 0));
  ok('丢掉「让我重新看」', !clean.some(s => /让我|重新看/.test(s)));
  ok('丢掉「不对…」', !clean.some(s => /^不对/.test(s)));
  ok('「第三步：」前缀被剥掉', clean.some(s => s === '判断电流表测哪部分电流。'));
  ok('超长步骤被截断', clean.filter(s => s.length > 121).length === 0);
  ok('空步骤被丢弃', clean.every(s => s.trim().length > 0));
  ok('条数受限(<=6)', clean.length <= 6, String(clean.length));
  ok('非数组入参返回 []', AI.sanitizeSteps(null).length === 0 && AI.sanitizeSteps('x').length === 0);

  // ---------- 提示词契约 ----------
  console.log('用例 2：新提示词包含反循环铁律');
  const p = AI.buildPrompt('physics', '9', '第2题，我答的是B');
  ok('含「最多复核一次」', p.indexOf('最多复核一次') >= 0);
  ok('含「不一致就标 uncertain」', p.indexOf('uncertain 设为 true') >= 0);
  ok('禁止自我怀疑字句', p.indexOf('严禁出现「让我再看」') >= 0);
  ok('steps 排在最后', p.lastIndexOf('"steps"') > p.lastIndexOf('"uncertain"'));
  ok('备注写答案用于判错因', p.indexOf('我答的是') >= 0);
  ok('备注写题号用于锁题', p.indexOf('题号') >= 0);
  ok('不许只给答案', p.indexOf('不许只给答案') >= 0);
  ok('错因不许一律归粗心', p.indexOf('不许一律归为粗心') >= 0);
  ok('含 causeType 枚举', p.indexOf('概念不清|公式用错') >= 0 || p.indexOf('概念不清 | 公式用错') >= 0);
  ok('含 similar/reviewDays', p.indexOf('"similar"') >= 0 && p.indexOf('"reviewDays"') >= 0);
  ok('年级匹配', p.indexOf('九年级') >= 0);
  ok('物理定制', p.indexOf('物理过程') >= 0);
  ok('数学定制', AI.buildPrompt('math', '8', '').indexOf('分类讨论') >= 0);
  ok('无备注时的分支', AI.buildPrompt('math', '8', '').indexOf('没有备注') >= 0);

  // ---------- 端到端：真实模型 ----------
  console.log('用例 3：真实模型端到端（真调上游）');
  const c = new Client({ host: 'localhost', port: 5432, user: 'postuser', password: 'postuser', database: 'wrongbook' });
  await c.connect();
  const st = (await c.query("select value from kv where key='settings.5'")).rows[0].value;
  const e = (await c.query("select subject,grade,note,image from errors order by created_at desc limit 1")).rows[0];
  await c.end();

  const imgPath = path.join('/Users/dingrc/work/project/wrongbook/uploads', path.basename(e.image));
  const dataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(imgPath).toString('base64');

  let upstreamCalls = 0;
  const sandbox2 = {
    console, setTimeout, clearTimeout,
    document: { getElementById: () => null, createElement: () => ({ getContext: () => ({}), toDataURL: () => '' }) },
    Store: { getSettings: () => st, gradeName: (g) => ({ '7': '七年级', '8': '八年级', '9': '九年级' }[String(g)] || '初中') },
    fetch: async (url, opt) => {
      const b = JSON.parse(opt.body);
      upstreamCalls++;
      const r = await fetch(b.apiBase.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + b.apiKey },
        body: JSON.stringify({
          model: b.model, messages: b.messages, max_tokens: b.max_tokens,
          temperature: b.temperature, enable_thinking: b.enable_thinking
        }),
        signal: AbortSignal.timeout(240000)
      });
      const t = await r.text();
      return { ok: r.ok, status: r.status, text: async () => t };
    },
  };
  sandbox2.window = sandbox2;
  vm.createContext(sandbox2);
  vm.runInContext(fs.readFileSync(base + 'ai.js', 'utf8'), sandbox2, { filename: 'ai.js' });

  const t0 = Date.now();
  const res = await sandbox2.AI.analyze(dataUrl, e.subject, e.grade, e.note);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('    耗时 ' + dt + 's | finish=' + res.finishReason + ' | quality=' + res.quality + ' | 上游调用 ' + upstreamCalls + ' 次');
  console.log('    字段: answer=' + JSON.stringify(res.answer) + ' student=' + JSON.stringify(res.studentAnswer) +
    ' cause=' + JSON.stringify(res.causeType) + ' uncertain=' + res.uncertain + ' reviewDays=' + res.reviewDays);
  console.log('    warnings=' + JSON.stringify(res.warnings));
  console.log('    steps(' + res.steps.length + '):');
  res.steps.forEach((s, i) => console.log('      ' + (i + 1) + '. ' + s));

  ok('返回结构完整', !!res && res.schema === 'v2' && Array.isArray(res.steps));
  ok('quality 有值', ['good', 'partial', 'low'].indexOf(res.quality) >= 0, res.quality);
  ok('answer 不是 JSON 原文（未退化）', !/^\s*\{\s*"?question/.test(String(res.answer)), String(res.answer).slice(0, 60));
  ok('answer 非空 或 quality=low', /[A-Za-z0-9\u4e00-\u9fa5]/.test(String(res.answer)) || res.quality === 'low');
  ok('steps 不含自我怀疑', !res.steps.some(s => /(让我|等等|不对|重新看|假设|尝试|修正)/.test(s)));
  ok('steps 条数 <=6', res.steps.length <= 6, String(res.steps.length));
  ok('steps 每条 <=121 字', res.steps.every(s => s.length <= 121));
  ok('非 good 必有 warning', res.quality === 'good' || (res.warnings || []).length > 0, JSON.stringify(res.warnings));
  ok('uncertain 为布尔', typeof res.uncertain === 'boolean');
  ok('noteUsed 已记录', res.noteUsed === (e.note || ''));
  ok('上游调用 1-2 次', upstreamCalls >= 1 && upstreamCalls <= 2, String(upstreamCalls));
  const retryP = sandbox2.AI.buildRetryPrompt(e.subject, e.grade, e.note);
  ok('二次识别提示词只要 5 个字段', retryP.indexOf('不要解题步骤') >= 0 && retryP.indexOf('"steps"') < 0);

  fs.writeFileSync('/tmp/wb_e2e_result.json', JSON.stringify(res, null, 2));
  console.log('\n==============================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
