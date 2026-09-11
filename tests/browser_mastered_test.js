/* 真浏览器端到端验证：「已会 / 还需要复习」
 *   错题本多出「掌握情况」筛选（全部 / 还需要复习 / 已会）
 *   详情页在删除按钮下面一行有「是否已会」按钮
 * 用本机 Chromium + CDP 驱动真实页面，连真实服务与数据库；分步截图。
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const CHROME = process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const CDP_PORT = 9335;
const BASE = 'http://127.0.0.1:8322';
const SHOTS = '/Users/dingrc/work/project/wrongbook/screenshots';
const UPLOADS = '/Users/dingrc/work/project/wrongbook/uploads';
const UPLOAD_FILE = '/tmp/mst_upload_test.jpg';
const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pass = 0, fail = 0;
function report(res) {
  const checks = (res && res.checks) || res || [];
  checks.forEach(c => c.pass
    ? (pass++, console.log('  ✅ ' + c.n + (c.extra ? '  [' + c.extra + ']' : '')))
    : (fail++, console.log('  ❌ ' + c.n + (c.extra ? '  → ' + c.extra : ''))));
}

const HELPER = `
  const R = { checks: [] };
  const ok = (n, pass, extra) => R.checks.push({ n, pass: !!pass, extra: extra == null ? '' : String(extra) });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { } await sleep(120); }
    return !!fn();
  };
  const bd = () => document.querySelector('#sheetRoot .sheet-bd');
  const cellOf = id => document.querySelector('.grid-item[data-id="' + id + '"]');
  const tapFilter = v => document.querySelector('.seg [data-mastered="' + v + '"]').click();
`;

async function api(method, url, { sid, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (sid) headers['Cookie'] = 'sid=' + sid;
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

(async () => {
  const db = new Client({ host: 'localhost', port: 5432, user: 'postuser', password: 'postuser', database: 'wrongbook' });
  await db.connect();
  let sid = null, eid = null;
  let proc = null, ws = null;

  try {
    const seed = fs.readdirSync(UPLOADS).filter(f => /\.jpe?g$/.test(f))[0];
    if (!seed) throw new Error('uploads 里没有 jpg 可用');
    execSync('/usr/bin/sips --resampleWidth 700 "' + path.join(UPLOADS, seed) + '" --out ' + UPLOAD_FILE + ' >/dev/null 2>&1');

    const ding = await db.query("SELECT id FROM users WHERE username='ding'");
    if (!ding.rows.length) throw new Error('找不到 ding 账号');
    sid = 'mstbr-' + crypto.randomBytes(8).toString('hex');
    await db.query('INSERT INTO sessions (sid, user_id) VALUES ($1,$2)', [sid, ding.rows[0].id]);

    const realJpg = 'data:image/jpeg;base64,' + fs.readFileSync(UPLOAD_FILE).toString('base64');
    const e = await api('POST', '/api/errors', { sid, body: { subject: 'physics', grade: '9', image: realJpg, note: '已会功能浏览器验证' } });
    if (!e.body.ok) throw new Error('建错题失败: ' + JSON.stringify(e.body));
    eid = e.body.item.id;
    // 顺便塞个分析结果：这样卡片上会同时出现「已分析」和「已会」两个标记，能验证它们不叠在一起
    await api('PATCH', '/api/errors/' + eid, { sid, body: { analysis: { schema: 'v2', question: '测试题', answer: '42' } } });
    console.log('已造数据: 错题 ' + eid + '（默认「还需要复习」，带一条分析结果）\n');

    /* ---------- 启动 Chromium ---------- */
    proc = spawn(CHROME, [
      '--headless=new', '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=/tmp/cdp-mst-profile', '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--no-sandbox', 'about:blank',
    ], { stdio: 'ignore' });

    let targets = null;
    for (let i = 0; i < 80; i++) {
      try {
        targets = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
        if (targets && targets.some(t => t.type === 'page')) break;
      } catch (e) { }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!targets) throw new Error('无法连接 Chromium');
    const page = targets.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

    let id = 0; const waiting = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    });
    const send = (method, params) => new Promise(res => {
      const mid = ++id; waiting.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
    const evalJS = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      const v = r.result && r.result.result && r.result.result.value;
      if (!v) throw new Error('脚本无返回值: ' + JSON.stringify(r).slice(0, 600));
      if (!Array.isArray(v.checks)) throw new Error('返回值里没有 checks: ' + JSON.stringify(r).slice(0, 600));
      return v;
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, 'wb_mst_' + name + '.png'), Buffer.from(s.result.data, 'base64'));
      console.log('   📸 screenshots/wb_mst_' + name + '.png');
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Network.setCookie', { name: 'sid', value: sid, domain: '127.0.0.1', path: '/' });
    await send('Page.navigate', { url: BASE + '/' });

    /* 就绪判定必须等到 `#pane-capture.on`：它是 mountAfterLogin → go('capture') 的产物。
     * 只等「没有 .auth-wrap」是不够的——已登录时 .auth-wrap 压根不会出现，
     * 那一瞬间 App 的 booted 还是 false，App.go('book') 会直接 return（页面什么都不渲染）。*/
    const READY_EXPR = 'document.readyState === "complete" && typeof Views !== "undefined" && !document.querySelector(".auth-wrap") && !!document.querySelector("#pane-capture.on")';
    let ready = false;
    for (let i = 0; i < 60; i++) {
      const r = await send('Runtime.evaluate', { expression: READY_EXPR, returnByValue: true });
      if (r.result && r.result.result && r.result.result.value === true) { ready = true; break; }
      await new Promise(r2 => setTimeout(r2, 250));
    }
    if (!ready) throw new Error('页面未完成登录初始化');
    let loaded = false;
    for (let i = 0; i < 40; i++) {
      const r = await send('Runtime.evaluate', {
        expression: "(function(){try{return !!(window.Store && Store.get('" + eid + "'))}catch(e){return false}})()",
        returnByValue: true,
      });
      if (r.result && r.result.result && r.result.result.value === true) { loaded = true; break; }
      await new Promise(r2 => setTimeout(r2, 250));
    }
    if (!loaded) throw new Error('Store 没拉到这条错题');

    /* ============ 第 1 步：错题本的「掌握情况」筛选栏 ============ */
    console.log('=== 1. 错题本「掌握情况」筛选 ===');
    report((await evalJS(`(async () => {
      ${HELPER}
      App.go('book');
      await waitFor(() => !!cellOf('${eid}'));
      ok('筛选栏有「掌握情况」', /掌握情况/.test(document.body.innerHTML));
      ok('三个选项都在（全部 / 还需要复习 / 已会）',
         ['all','0','1'].every(v => !!document.querySelector('.seg [data-mastered="' + v + '"]')));
      const labels = Array.from(document.querySelectorAll('.seg [data-mastered]')).map(b => b.textContent.trim()).join(' | ');
      ok('文案写的是「还需要复习」和「已会」', /还需要复习/.test(labels) && /已会/.test(labels), labels);
      ok('默认选中「全部」', document.querySelector('.seg [data-mastered="all"]').classList.contains('on'));
      ok('小结写明各状态数量', /共 \\d+ 道错题/.test(document.body.innerHTML) && /还需要复习 \\d+ 道/.test(document.body.innerHTML),
         (document.body.innerHTML.match(/共 \\d+ 道错题[^<]*/) || [])[0]);

      const cell = cellOf('${eid}');
      ok('新错题默认在「还需要复习」里（不带已会标记）',
         !cell.querySelector('.badge.mastered') && !cell.classList.contains('is-mastered'));

      tapFilter('0'); await sleep(200);
      ok('切到「还需要复习」能看见它', !!cellOf('${eid}'));
      ok('切筛选后高亮跟着走', document.querySelector('.seg [data-mastered="0"]').classList.contains('on'));

      tapFilter('1'); await sleep(200);
      ok('切到「已会」就看不见它了', !cellOf('${eid}'));
      tapFilter('0'); await sleep(200);
      ok('切回「还需要复习」又出现', !!cellOf('${eid}'));
      return R;
    })()`)));
    await shot('book-filter');

    /* ============ 第 2 步：详情页的「是否已会」按钮 ============ */
    console.log('\n=== 2. 详情页「标记为已会」（在删除按钮下面一行）===');
    report((await evalJS(`(async () => {
      ${HELPER}
      tapFilter('all'); await sleep(200);
      Views.openDetail('${eid}');
      await waitFor(() => !!bd() && !!bd().querySelector('#btnMastered'));
      const del = bd().querySelector('#btnDel');
      const an = bd().querySelector('#btnAnalyze');
      const mb = bd().querySelector('#btnMastered');
      const rc = an.getBoundingClientRect(), rd = del.getBoundingClientRect(), rm = mb.getBoundingClientRect();
      ok('详情页有「是否已会」按钮', !!mb);
      ok('它排在删除按钮的下一行', rm.top >= rd.bottom - 1,
         '删除底 ' + Math.round(rd.bottom) + ' / 标记顶 ' + Math.round(rm.top));
      ok('整行按钮，与上面的「AI 分析」左对齐', Math.abs(rm.left - rc.left) < 2 && rm.width > rc.width,
         '分析钮 ' + Math.round(rc.left) + '/' + Math.round(rc.width) + ' 标记钮 ' + Math.round(rm.left) + '/' + Math.round(rm.width));
      ok('默认文案「标记为已会」', mb.textContent.trim() === '标记为已会', mb.textContent.trim());
      ok('默认是描边样式（不抢眼）', mb.className === 'btn full line', mb.className);
      ok('按钮下方有说明（可取消）', /随时能取消/.test(bd().innerHTML));

      mb.click();
      await waitFor(() => bd().querySelector('#btnMastered').className === 'btn full ok');
      const mb2 = bd().querySelector('#btnMastered');
      ok('点一下变成已会态（绿色）', mb2.className === 'btn full ok', mb2.className);
      ok('文案变成「已会（点一下取消）」', /^✅ 已会/.test(mb2.textContent.trim()), mb2.textContent.trim());
      ok('按钮可用（没卡在 loading）', mb2.disabled === false);
      mb2.scrollIntoView({ block: 'center' });   // 让截图看得见这排按钮
      return R;
    })()`)));
    await shot('detail-mastered');

    /* ============ 第 3 步：标记后错题本出现 ✓ 已会 ============ */
    console.log('\n=== 3. 标记后回到错题本看效果 ===');
    report((await evalJS(`(async () => {
      ${HELPER}
      document.querySelector('[data-act="close-sheet"]').click();
      await waitFor(() => !document.querySelector('.mask'));
      await waitFor(() => { const c = cellOf('${eid}'); return c && !!c.querySelector('.badge.mastered'); });
      const cell = cellOf('${eid}');
      ok('卡片右上角出现 ✓ 已会 标记',
         !!cell.querySelector('.badge.mastered') && /已会/.test(cell.querySelector('.badge.mastered').textContent),
         cell.querySelector('.badge.mastered') && cell.querySelector('.badge.mastered').textContent);
      ok('卡片带 is-mastered（缩略图淡化 + 绿描边）', cell.classList.contains('is-mastered'));
      ok('卡片日期行也标了已会', /✓ 已会/.test(cell.querySelector('.dt').textContent), cell.querySelector('.dt').textContent);

      // 这条题同时有「已分析」和「已会」，两个标记必须竖着排、不能互相盖住
      const badges = Array.from(cell.querySelectorAll('.badges .badge'));
      ok('同时显示「已分析」和「已会」两个标记', badges.length === 2 && badges.map(b => /已分析|已会/.test(b.textContent)).every(Boolean),
         badges.map(b => b.textContent).join(' / '));
      if (badges.length === 2) {
        const b1 = badges[0].getBoundingClientRect(), b2 = badges[1].getBoundingClientRect();
        const overlap = !(b1.bottom <= b2.top + 0.5 || b2.bottom <= b1.top + 0.5 || b1.right <= b2.left + 0.5 || b2.right <= b1.left + 0.5);
        ok('两个标记不重叠', !overlap,
           '上 ' + Math.round(b1.top) + '~' + Math.round(b1.bottom) + ' / 下 ' + Math.round(b2.top) + '~' + Math.round(b2.bottom));
      }

      tapFilter('1'); await sleep(250);
      ok('「已会」筛选里能找到它', !!cellOf('${eid}'));
      tapFilter('0'); await sleep(250);
      ok('「还需要复习」里已经没有它', !cellOf('${eid}'));
      tapFilter('1'); await sleep(200);
      return R;
    })()`)));
    await shot('book-mastered');

    /* ============ 第 4 步：刷新页面后仍在（真的存到服务端）============ */
    console.log('\n=== 4. 刷新页面后状态还在（确认写进了库）===');
    await send('Page.navigate', { url: BASE + '/' });
    let ready2 = false;
    for (let i = 0; i < 60; i++) {
      const r = await send('Runtime.evaluate', { expression: READY_EXPR, returnByValue: true });
      if (r.result && r.result.result && r.result.result.value === true) { ready2 = true; break; }
      await new Promise(r2 => setTimeout(r2, 250));
    }
    if (!ready2) throw new Error('刷新后页面未就绪');
    report(await evalJS(`(async () => {
      ${HELPER}
      App.go('book');
      await waitFor(() => !!cellOf('${eid}'));
      const cell = cellOf('${eid}');
      ok('刷新后仍带 ✓ 已会 标记', !!cell.querySelector('.badge.mastered'));
      ok('刷新后仍带 is-mastered', cell.classList.contains('is-mastered'));
      return R;
    })()`));

    const srv = await api('GET', '/api/errors?mastered=1', { sid });
    const inDone = srv.body.items.some(x => x.id === eid);
    console.log((inDone ? '  ✅' : '  ❌') + ' 服务端「已会」列表里能查到它' + (inDone ? '' : '（接口没存上）'));
    inDone ? pass++ : fail++;

    /* ============ 第 5 步：再点一次可以取消 ============ */
    console.log('\n=== 5. 再点一次取消标记 ===');
    report((await evalJS(`(async () => {
      ${HELPER}
      Views.openDetail('${eid}');
      await waitFor(() => !!bd() && !!bd().querySelector('#btnMastered'));
      const mb = bd().querySelector('#btnMastered');
      ok('打开就是已会态', mb.className === 'btn full ok', mb.className);
      mb.click();
      await waitFor(() => bd().querySelector('#btnMastered').className === 'btn full line');
      ok('再点一下回到「标记为已会」', bd().querySelector('#btnMastered').textContent.trim() === '标记为已会');
      document.querySelector('[data-act="close-sheet"]').click();
      await waitFor(() => !document.querySelector('.mask'));
      await waitFor(() => { const c = cellOf('${eid}'); return c && !c.querySelector('.badge.mastered'); });
      ok('错题本里的 ✓ 已会 标记消失', !cellOf('${eid}').querySelector('.badge.mastered'));
      ok('卡片不再带 is-mastered', !cellOf('${eid}').classList.contains('is-mastered'));
      return R;
    })()`)));

    const srv2 = await api('GET', '/api/errors?mastered=0', { sid });
    const backToTodo = srv2.body.items.some(x => x.id === eid);
    console.log((backToTodo ? '  ✅' : '  ❌') + ' 服务端「还需要复习」列表里又能查到它');
    backToTodo ? pass++ : fail++;

    console.log('\n' + '='.repeat(46));
    console.log('已会功能真浏览器验证：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) process.exitCode = 1;

  } catch (e) {
    console.log('ERR ' + e.message + '\n' + (e.stack || ''));
    process.exitCode = 1;
  } finally {
    try {
      if (eid) await api('DELETE', '/api/errors/' + eid, { sid });
      if (eid) {
        const files = [];
        (await db.query('SELECT image FROM errors WHERE id=$1', [eid])).rows.forEach(r => r.image && files.push(r.image));
        await db.query('DELETE FROM errors WHERE id=$1', [eid]);
        files.forEach(u => { try { fs.unlinkSync(path.join(UPLOADS, path.basename(u))); } catch (_) { } });
      }
      if (sid) await db.query('DELETE FROM sessions WHERE sid=$1', [sid]);
    } catch (_) { }
    await db.end();
    try { if (ws) ws.close(); } catch (_) { }
    try { if (proc) proc.kill(); } catch (_) { }
    setTimeout(() => process.exit(process.exitCode || 0), 400);
  }
})();
