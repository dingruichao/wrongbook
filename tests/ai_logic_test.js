/* 用假 fetch 确定性地验证 analyze() 的自保逻辑（不消耗模型额度） */
const fs = require('fs'), vm = require('vm');
const base = '/Users/dingrc/work/project/wrongbook/js/';

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

function mkSandbox(replies) {
  let i = 0;
  const calls = [];
  const sb = {
    console, setTimeout, clearTimeout,
    document: { getElementById: () => null, createElement: () => ({ getContext: () => ({}), toDataURL: () => '' }) },
    Store: { getSettings: () => ({ apiBase: 'https://fake/v1', apiKey: 'k', model: 'm' }), gradeName: g => ({ '9': '九年级' }[String(g)] || '初中') },
    fetch: (url, opt) => {
      calls.push(JSON.parse(opt.body));
      const r = replies[Math.min(i, replies.length - 1)]; i++;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(r)) });
    },
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(base + 'ai.js', 'utf8'), sb, { filename: 'ai.js' });
  return { AI: sb.AI, calls };
}

const wrap = (content, finish) => ({ choices: [{ message: { content }, finish_reason: finish || 'stop' }] });

(async () => {
  /* ---------- 1. 跑飞：178 条推敲 → 步骤整段丢弃 + 二次识别补答案 ---------- */
  console.log('用例 1：跑飞时 steps 整段丢弃、答案由二次识别补全');
  const messy = [];
  for (let k = 0; k < 175; k++) messy.push('第' + (k + 1) + '步：等等，让我重新看这里对不对。');
  messy.push('去表法：把电流表换成导线，电压表拿掉。');
  messy.push('R2、R3、R4 并联，总电阻 1Ω。');
  messy.push('干路电流 3A，电流表测其中两路共 2A。');
  const firstBody = JSON.stringify({
    question: '在图所示的电路中，已知R1=R2=R3=R4=3Ω……', studentAnswer: 'B', answer: '',
    steps: messy, knowledge: '', causeType: '', causeDetail: '', fixOneLine: '', tip: '',
    similar: { q: '', a: '', hint: '' }, reviewDays: 0, reviewFocus: '', uncertain: false
  });
  const a = mkSandbox([
    wrap(firstBody, 'length'),
    wrap('{"question":"电路题","studentAnswer":"B","answer":"B","knowledge":"并联电路与欧姆定律","uncertain":true}'),
  ]);
  const r1 = await a.AI.analyze('data:image/jpeg;base64,AA', 'physics', '9', '');
  ok('上游被调用了 2 次', a.calls.length === 2, String(a.calls.length));
  ok('steps 被整段丢弃', r1.steps.length === 0, JSON.stringify(r1.steps));
  ok('提示「已不展示」', (r1.warnings || []).some(w => w.indexOf('已不展示') >= 0), JSON.stringify(r1.warnings));
  ok('答案由二次识别补全', r1.answer === 'B', r1.answer);
  ok('题目被二次识别校正', r1.question === '电路题', r1.question);
  ok('知识点被补上', r1.knowledge === '并联电路与欧姆定律', r1.knowledge);
  ok('uncertain 取并集', r1.uncertain === true);
  ok('quality=partial', r1.quality === 'partial', r1.quality);
  ok('提示没有步骤', (r1.warnings || []).some(w => w.indexOf('没能给出解题步骤') >= 0), JSON.stringify(r1.warnings));
  ok('二次请求 max_tokens=800', a.calls[1].max_tokens === 800, String(a.calls[1].max_tokens));
  ok('二次请求段落里没有 steps 要求', a.calls[1].messages[0].content[1].text.indexOf('"steps"') < 0);

  /* ---------- 2. 干净输出：只调一次，不打补丁 ---------- */
  console.log('\n用例 2：一次到位时不重复调用');
  const cleanBody = JSON.stringify({
    question: '求长方形面积', studentAnswer: '36', answer: '40 cm²',
    steps: ['1. 面积 = 长 × 宽', '2. 8 × 5 = 40'], knowledge: '长方形面积',
    causeType: '计算失误', causeDetail: '把 8×5 算成了 36', fixOneLine: '8×5=40',
    tip: '背口诀后验算', similar: { q: '长12宽4', a: '48', hint: '同公式' },
    reviewDays: 3, reviewFocus: '先写公式再代数', uncertain: false
  });
  const b = mkSandbox([wrap(cleanBody, 'stop')]);
  const r2 = await b.AI.analyze('data:image/jpeg;base64,AA', 'math', '8', '第3题，我答的是36');
  ok('只调用 1 次', b.calls.length === 1, String(b.calls.length));
  ok('quality=good', r2.quality === 'good', r2.quality);
  ok('没有 warning', (r2.warnings || []).length === 0, JSON.stringify(r2.warnings));
  ok('steps 保留 2 条', r2.steps.length === 2, JSON.stringify(r2.steps));
  ok('steps 序号被剥掉', r2.steps[0] === '面积 = 长 × 宽', r2.steps[0]);
  ok('answer 正确', r2.answer === '40 cm²');
  ok('reviewDays=3', r2.reviewDays === 3);
  ok('similar 完整', r2.similar && r2.similar.a === '48');
  ok('noteUsed 记录', r2.noteUsed === '第3题，我答的是36');

  /* ---------- 3. 完全跑飞：靠 salvage 抢救 ---------- */
  console.log('\n用例 3：输出被截断成非法 JSON 时靠 salvage 抢救');
  const broken = '{"question":"一道电路题","studentAnswer":"B","answer":"B","causeType":"概念不清","steps":["去表法：电流表视为导线","并联部分电阻为1Ω';
  const c = mkSandbox([
    wrap(broken, 'length'),
    wrap('{"question":"一道电路题","studentAnswer":"B","answer":"B","knowledge":"并联","uncertain":false}'),
  ]);
  const r3 = await c.AI.analyze('data:image/jpeg;base64,AA', 'physics', '9', '');
  ok('救回 question', r3.question === '一道电路题', r3.question);
  ok('救回 answer', r3.answer === 'B', r3.answer);
  ok('救回 causeType', r3.causeType === '概念不清', r3.causeType);
  ok('救回部分 steps', r3.steps.length === 1 && r3.steps[0] === '去表法：电流表视为导线', JSON.stringify(r3.steps));
  ok('提示被截断', (r3.warnings || []).some(w => w.indexOf('被截断') >= 0), JSON.stringify(r3.warnings));
  ok('answer 不是 JSON 原文', !/^\{/.test(String(r3.answer)));
  ok('没有 _unparsed 标记泄漏到界面', r3._unparsed === undefined);

  /* ---------- 4. 两次都失败：安全降级 ---------- */
  console.log('\n用例 4：二次识别也读不出答案时的降级');
  const d = mkSandbox([
    wrap('{"question":"看不懂","answer":"","steps":[],"uncertain":true}', 'stop'),
    wrap('{"question":"还是看不懂","studentAnswer":"","answer":"","knowledge":"","uncertain":true}'),
  ]);
  const r4 = await d.AI.analyze('data:image/jpeg;base64,AA', 'math', '9', '');
  ok('quality=partial（有一半信息）', r4.quality === 'partial', r4.quality);
  ok('提示二次识别失败', (r4.warnings || []).some(w => w.indexOf('二次识别也没读出答案') >= 0), JSON.stringify(r4.warnings));
  ok('不抛异常（用户仍能看到东西）', !!r4 && typeof r4 === 'object');

  /* ---------- 5. 上游报错：异常向上抛，界面 toast 分析失败 ---------- */
  console.log('\n用例 5：上游报错时抛异常');
  const e = mkSandbox([]);
  e.AI.__forceErr = true;
  const sbErr = mkSandbox([]);
  sbErr.AI = null;
  const f2 = (() => {
    const s = {
      console, setTimeout, clearTimeout,
      document: { getElementById: () => null, createElement: () => ({ getContext: () => ({}), toDataURL: () => '' }) },
      Store: { getSettings: () => ({ apiBase: 'https://fake/v1', apiKey: 'k', model: 'm' }), gradeName: () => '九年级' },
      fetch: () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('{"error":{"message":"boom"}}') }),
    };
    s.window = s; vm.createContext(s);
    vm.runInContext(fs.readFileSync(base + 'ai.js', 'utf8'), s, { filename: 'ai.js' });
    return s.AI;
  })();
  let threw = '';
  try { await f2.analyze('data:image/jpeg;base64,AA', 'math', '9', ''); } catch (err) { threw = err.message; }
  ok('抛出了带状态码的错误', /500/.test(threw), threw);

  /* ---------- 6. v3：why 字段保留 / 触发隐藏的条件 ---------- */
  console.log('\n用例 6：v3 why 字段的清洗逻辑');

  // (a) 干净 why → 保留
  const g = mkSandbox([wrap(JSON.stringify({
    question: '求长方形面积', studentAnswer: '36', answer: '40 cm²',
    why: '长方形面积一定用到「长 × 宽」，从题目里的「面积」「长」「宽」就能想到',
    steps: ['写公式 S = 长 × 宽', '代入 8 × 5'], knowledge: '长方形面积公式',
    causeType: '计算失误', causeDetail: '把 8×5 算错', fixOneLine: '8×5=40',
    tip: '验算', similar: { q: '长12宽4', a: '48', hint: '同公式' },
    reviewDays: 3, reviewFocus: '先写公式再代数', uncertain: false
  }), 'stop')]);
  const r6a = await g.AI.analyze('data:image/jpeg;base64,AA', 'math', '8', '');
  ok('干净 why 被保留', r6a.why.indexOf('「长 × 宽」') >= 0, r6a.why);
  ok('quality 仍为 good', r6a.quality === 'good', r6a.quality);

  // (b) why 撞到强信号自我推翻 → 隐藏 + 警告
  const h = mkSandbox([wrap(JSON.stringify({
    question: '电路题', studentAnswer: 'B', answer: 'B',
    why: '等等，让我重新看题再想是不是对不对',     // 强：等等/让我重新/是不是
    steps: ['用欧姆定律'], knowledge: '并联',
    causeType: '概念不清', causeDetail: '', fixOneLine: '', tip: '',
    similar: { q: '', a: '', hint: '' }, reviewDays: 3, reviewFocus: '', uncertain: false
  }), 'stop')]);
  const r6b = await h.AI.analyze('data:image/jpeg;base64,AA', 'physics', '9', '');
  ok('强信号 why 被清空', r6b.why === '', r6b.why);
  ok('提示「为什么这样做」被隐藏',
    (r6b.warnings || []).some(w => w.indexOf('为什么这样做') >= 0 && w.indexOf('已隐藏') >= 0),
    JSON.stringify(r6b.warnings));

  // (c) why 弱信号撞到 3 个 → 隐藏
  const i = mkSandbox([wrap(JSON.stringify({
    question: '电路题', studentAnswer: 'B', answer: 'B',
    why: '假设是短路，如果是，则电流很大，意味着不可能是这样？',  // 假设/如果是/意味着/不/?
    steps: ['用欧姆定律'], knowledge: '并联',
    causeType: '', causeDetail: '', fixOneLine: '', tip: '',
    similar: { q: '', a: '', hint: '' }, reviewDays: 0, reviewFocus: '', uncertain: true
  }), 'stop')]);
  const r6c = await i.AI.analyze('data:image/jpeg;base64,AA', 'physics', '9', '');
  ok('弱信号成堆 why 被清空', r6c.why === '', r6c.why);

  // (d) why 单个弱信号（如「假设物体匀速」） → 保留
  const j = mkSandbox([wrap(JSON.stringify({
    question: '力学题', studentAnswer: '2', answer: '3',
    why: '假设物体做匀速直线运动，则受力平衡',
    steps: ['画受力图'], knowledge: '二力平衡',
    causeType: '公式用错', causeDetail: '', fixOneLine: '', tip: '',
    similar: { q: '', a: '', hint: '' }, reviewDays: 0, reviewFocus: '', uncertain: false
  }), 'stop')]);
  const r6d = await j.AI.analyze('data:image/jpeg;base64,AA', 'physics', '9', '');
  ok('含合法「假设」的 why 被保留', r6d.why.indexOf('假设') >= 0, r6d.why);

  /* ---------- 7. v3：steps 数量结构闸门 + 弱信号阈值 ---------- */
  console.log('\n用例 7：steps 的结构闸门与弱信号阈值');

  // (a) 给到 12 条 → 不管内容，结构闸门整段丢
  const many = [];
  for (let k = 0; k < 12; k++) many.push('干净步骤 ' + (k + 1) + '：代入求值');
  const k = mkSandbox([wrap(JSON.stringify({
    question: '求面积', studentAnswer: '36', answer: '40',
    why: '长×宽', steps: many, knowledge: '',
    causeType: '', causeDetail: '', fixOneLine: '', tip: '',
    similar: { q: '', a: '', hint: '' }, reviewDays: 0, reviewFocus: '', uncertain: false
  }), 'stop')]);
  const r7a = await k.AI.analyze('data:image/jpeg;base64,AA', 'math', '8', '');
  ok('12 条 steps 被结构闸门整段丢弃', r7a.steps.length === 0, JSON.stringify(r7a.steps));
  ok('提示含「大量自我推敲」',
    (r7a.warnings || []).some(w => w.indexOf('大量自我推敲') >= 0),
    JSON.stringify(r7a.warnings));

  // (b) 合法的「假设」「这意味着」不要被误杀
  const legit = [
    '假设物体做匀速运动 → 受力平衡',
    '这意味着合外力为零',
    '根据 F = ma，解出 a = 0'
  ];
  const l = mkSandbox([wrap(JSON.stringify({
    question: '力学', studentAnswer: '0', answer: '0',
    why: '牛顿定律', steps: legit, knowledge: '牛顿第二定律',
    causeType: '概念不清', causeDetail: '', fixOneLine: '', tip: '',
    similar: { q: '', a: '', hint: '' }, reviewDays: 0, reviewFocus: '', uncertain: false
  }), 'stop')]);
  const r7b = await l.AI.analyze('data:image/jpeg;base64,AA', 'physics', '9', '');
  ok('含「假设/这意味着」的 3 条 steps 全部保留',
    r7b.steps.length === 3, JSON.stringify(r7b.steps));

  console.log('\n==============================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
