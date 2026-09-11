/* 他人正确解答：真 HTTP 集成测试
 * 覆盖：新增 / 列表 / 张数 / 改说明 / 删单张 / 删错题级联 / 文件落盘与清理 / 越权 404 / 未登录 401
 * 用的是真实服务 (127.0.0.1:8322) + 真实数据库；测试数据用完即删。
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:8322';
const UP = '/Users/dingrc/work/project/wrongbook/uploads';
const DB = { host: 'localhost', port: 5432, user: 'postuser', password: 'postuser', database: 'wrongbook' };

// 1×1 PNG（内容不重要，只验证链路）
const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

function req(method, url, { sid, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (sid) headers['Cookie'] = 'sid=' + sid;
  return fetch(BASE + url, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(r => r.json().then(j => ({ status: r.status, body: j })));
}

const fileExists = u => fs.existsSync(path.join(UP, path.basename(u)));

(async () => {
  const db = new Client(DB);
  await db.connect();
  let tmpUid = null, sidA = null, sidB = null;

  try {
    /* ---- 准备：A 用户（ding）的会话 + B 用户（临时）的会话 ---- */
    const ding = await db.query("SELECT id, username FROM users WHERE username='ding'");
    if (!ding.rows.length) throw new Error("找不到 ding 账号，请先确认库里有用户");
    const uidA = ding.rows[0].id;

    sidA = 'soltest-a-' + crypto.randomBytes(8).toString('hex');
    await db.query('INSERT INTO sessions (sid, user_id) VALUES ($1,$2)', [sidA, uidA]);

    const uname = 'soltest_' + Date.now().toString(36);
    const insB = await db.query(
      "INSERT INTO users (username, password_hash) VALUES ($1,'x:y') RETURNING id", [uname]);
    tmpUid = insB.rows[0].id;
    sidB = 'soltest-b-' + crypto.randomBytes(8).toString('hex');
    await db.query('INSERT INTO sessions (sid, user_id) VALUES ($1,$2)', [sidB, tmpUid]);

    console.log('\n=== 1. 未登录必须 401 ===');
    let r = await req('GET', '/api/errors/whatever/solutions');
    ok('GET 解答列表 401', r.status === 401, r.status);
    r = await req('POST', '/api/errors/whatever/solutions', { body: { image: TINY } });
    ok('POST 新增解答 401', r.status === 401, r.status);
    r = await req('DELETE', '/api/solutions/whatever');
    ok('DELETE 解答 401', r.status === 401, r.status);

    console.log('\n=== 2. 造一条临时错题（A 用户） ===');
    r = await req('POST', '/api/errors', { sid: sidA, body: { subject: 'math', grade: '7', image: TINY, note: '解答功能联调' } });
    ok('创建错题 200', r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 200));
    const eid = r.body.item.id;
    const errImg = r.body.item.image;
    ok('新错题 solutionCount=0', r.body.item.solutionCount === 0, r.body.item.solutionCount);
    ok('错题图片已落盘', fileExists(errImg), errImg);

    console.log('\n=== 3. 解答列表初始为空 ===');
    r = await req('GET', '/api/errors/' + eid + '/solutions', { sid: sidA });
    ok('列表 200 且为空数组', r.status === 200 && Array.isArray(r.body.items) && r.body.items.length === 0, JSON.stringify(r.body));

    console.log('\n=== 4. 新增两张解答 ===');
    r = await req('POST', '/api/errors/' + eid + '/solutions', { sid: sidA, body: { image: TINY, note: '张老师的解法' } });
    ok('第 1 张 200', r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 200));
    const s1 = r.body.item;
    ok('返回 errorId 正确', s1.errorId === eid, s1.errorId);
    ok('解答图片已落盘', fileExists(s1.image), s1.image);
    ok('说明已保存', s1.note === '张老师的解法', s1.note);

    r = await req('POST', '/api/errors/' + eid + '/solutions', { sid: sidA, body: { image: TINY } });
    ok('第 2 张 200', r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 200));
    const s2 = r.body.item;
    ok('无说明时 note 为空串', s2.note === '', JSON.stringify(s2.note));

    console.log('\n=== 5. 列表与张数 ===');
    r = await req('GET', '/api/errors/' + eid + '/solutions', { sid: sidA });
    ok('列表返回 2 张', r.body.items.length === 2, r.body.items.length);
    ok('按创建时间升序（先第1张）', r.body.items[0].id === s1.id, r.body.items.map(x => x.id).join(','));

    r = await req('GET', '/api/errors?subject=math&grade=7', { sid: sidA });
    const hit = (r.body.items || []).filter(x => x.id === eid)[0];
    ok('列表接口带回 solutionCount=2', hit && hit.solutionCount === 2, hit && hit.solutionCount);

    console.log('\n=== 6. 不改图片，只改说明 ===');
    r = await req('PATCH', '/api/solutions/' + s1.id, { sid: sidA, body: { note: '李老师：用比例更快' } });
    ok('PATCH 200', r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 200));
    ok('note 已更新', r.body.item.note === '李老师：用比例更快', r.body.item.note);
    const dbNote = await db.query('SELECT note, image FROM solutions WHERE id=$1', [s1.id]);
    ok('库里 note 已更新', dbNote.rows[0].note === '李老师：用比例更快', dbNote.rows[0].note);
    ok('图片没被改动', dbNote.rows[0].image === s1.image);
    r = await req('PATCH', '/api/solutions/' + s1.id, { sid: sidA, body: {} });
    ok('空 patch 返回 400', r.status === 400, r.status);

    console.log('\n=== 7. 越权（B 用户碰 A 的错题/解答） ===');
    r = await req('GET', '/api/errors/' + eid + '/solutions', { sid: sidB });
    ok('别人的题看解答 → 404', r.status === 404, r.status);
    r = await req('POST', '/api/errors/' + eid + '/solutions', { sid: sidB, body: { image: TINY } });
    ok('往别人的题挂解答 → 404', r.status === 404, r.status);
    r = await req('GET', '/api/errors/' + eid, { sid: sidB });
    ok('别人的错题详情 → 404', r.status === 404, r.status);
    r = await req('PATCH', '/api/solutions/' + s1.id, { sid: sidB, body: { note: '篡改' } });
    ok('改别人的解答说明 → 404', r.status === 404, r.status);
    r = await req('DELETE', '/api/solutions/' + s1.id, { sid: sidB });
    ok('删别人的解答 → 404', r.status === 404, r.status);
    const still = await db.query('SELECT count(*)::int n FROM solutions WHERE error_id=$1', [eid]);
    ok('越权操作没有真的删掉', still.rows[0].n === 2, still.rows[0].n);

    console.log('\n=== 8. 输入校验 ===');
    r = await req('POST', '/api/errors/' + eid + '/solutions', { sid: sidA, body: { image: 'not-a-dataurl' } });
    ok('非 dataURL → 400', r.status === 400, r.status + ' ' + JSON.stringify(r.body));
    r = await req('POST', '/api/errors/' + eid + '/solutions', { sid: sidA, body: {} });
    ok('缺图片 → 400', r.status === 400, r.status);

    console.log('\n=== 9. 删单张解答（连带删文件） ===');
    ok('删除前文件在', fileExists(s2.image));
    r = await req('DELETE', '/api/solutions/' + s2.id, { sid: sidA });
    ok('DELETE 200', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    await new Promise(res => setTimeout(res, 200));
    ok('文件已删除', !fileExists(s2.image), s2.image);
    r = await req('GET', '/api/errors/' + eid + '/solutions', { sid: sidA });
    ok('列表只剩 1 张', r.body.items.length === 1, r.body.items.length);
    r = await req('DELETE', '/api/solutions/' + s2.id, { sid: sidA });
    ok('重复删除 → 404', r.status === 404, r.status);

    console.log('\n=== 9b. 已会 / 还需要复习（筛选 + 标记） ===');
    r = await req('GET', '/api/errors?mastered=0', { sid: sidA });
    ok('新错题默认进「还需要复习」', r.body.items.some(x => x.id === eid));
    const mine = r.body.items.filter(x => x.id === eid)[0];
    ok('列表项带 mastered 字段（默认 false）', !!mine && mine.mastered === false, mine && mine.mastered);
    r = await req('GET', '/api/errors?mastered=1', { sid: sidA });
    ok('「已会」里暂时没有它', !r.body.items.some(x => x.id === eid));

    r = await req('PATCH', '/api/errors/' + eid, { sid: sidA, body: { mastered: true } });
    ok('PATCH mastered 200 且回 true', r.status === 200 && r.body.item.mastered === true, JSON.stringify(r.body).slice(0, 160));
    r = await req('GET', '/api/errors?mastered=1', { sid: sidA });
    ok('标记后出现在「已会」', r.body.items.some(x => x.id === eid));
    r = await req('GET', '/api/errors?mastered=0', { sid: sidA });
    ok('标记后不在「还需要复习」', !r.body.items.some(x => x.id === eid));
    r = await req('GET', '/api/errors?mastered=1&subject=math&grade=7', { sid: sidA });
    ok('可与科目/年级叠加', r.body.items.some(x => x.id === eid));
    r = await req('GET', '/api/errors?mastered=1&grade=9', { sid: sidA });
    ok('叠加条件不匹配则不出现', !r.body.items.some(x => x.id === eid));
    r = await req('GET', '/api/errors?mastered=abc', { sid: sidA });
    ok('非法 mastered 值当「全部」处理（不报错）', r.status === 200 && r.body.items.some(x => x.id === eid), r.status);

    r = await req('PATCH', '/api/errors/' + eid, { sid: sidB, body: { mastered: true } });
    ok('改别人的已会状态 → 404', r.status === 404, r.status);
    const mv = await db.query('SELECT mastered FROM errors WHERE id=$1', [eid]);
    ok('越权不写库（仍是 true）', mv.rows[0].mastered === true, mv.rows[0].mastered);
    r = await req('PATCH', '/api/errors/' + eid, { sid: sidA, body: { mastered: false } });
    ok('可以取消标记', r.status === 200 && r.body.item.mastered === false, JSON.stringify(r.body).slice(0, 160));

    console.log('\n=== 10. 删错题 → 级联删解答 + 清理全部文件 ===');
    ok('错题图在', fileExists(errImg));
    ok('剩下那张解答图在', fileExists(s1.image));
    r = await req('DELETE', '/api/errors/' + eid, { sid: sidA });
    ok('删错题 200', r.status === 200 && r.body.ok, JSON.stringify(r.body));
    ok('返回值报告删了几张解答', r.body.deletedSolutions === 1, r.body.deletedSolutions);
    await new Promise(res => setTimeout(res, 250));
    ok('错题图已删', !fileExists(errImg));
    ok('解答图已删', !fileExists(s1.image));
    const gone = await db.query('SELECT count(*)::int n FROM solutions WHERE error_id=$1', [eid]);
    ok('库里解答行已级联清空', gone.rows[0].n === 0, gone.rows[0].n);

    console.log('\n=== 11. 真实错题不受影响（只读校验） ===');
    const cnt = await db.query('SELECT count(*)::int n FROM errors');
    const scnt = await db.query('SELECT count(*)::int n FROM solutions');
    console.log('  ℹ️  当前 errors=' + cnt.rows[0].n + ' / solutions=' + scnt.rows[0].n);

  } catch (e) {
    fail++;
    console.log('  ❌ 测试异常：' + e.message + '\n' + (e.stack || ''));
  } finally {
    // 清场：临时会话 / 临时用户（其会话与数据由外键级联清理）
    try {
      if (sidA) await db.query('DELETE FROM sessions WHERE sid=$1', [sidA]);
      if (sidB) await db.query('DELETE FROM sessions WHERE sid=$1', [sidB]);
      if (tmpUid) await db.query('DELETE FROM users WHERE id=$1', [tmpUid]);
    } catch (_) { }
    await db.end();
    console.log('\n通过 ' + pass + '，失败 ' + fail);
    process.exit(fail ? 1 : 0);
  }
})();
