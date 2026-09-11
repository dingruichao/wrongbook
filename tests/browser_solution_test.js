/* 真浏览器端到端验证：他人正确解答（拍照 → 框选 → 上传 → 展示 → 改说明 → 删除）
 * 用本机 Chromium + CDP 驱动真实页面，连真实服务与数据库。
 * 分步执行、分步截图 —— 每一步都在"那一刻"抓图，而不是最后统一抓。
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const CHROME = process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const CDP_PORT = 9334;
const BASE = 'http://127.0.0.1:8322';
const SHOTS = '/Users/dingrc/work/project/wrongbook/screenshots';
const UPLOADS = '/Users/dingrc/work/project/wrongbook/uploads';
const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const UPLOAD_FILE = '/tmp/sol_upload_test.jpg';

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
  /* 等条件成立再断言，别靠固定 sleep 赌渲染速度（否则机器一忙就假失败） */
  const waitFor = async (fn, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { } await sleep(120); }
    return !!fn();
  };
  const items = () => Array.from(document.querySelectorAll('#solBox .sol-item'));
  const bd = () => document.querySelector('#sheetRoot .sheet-bd');
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
    console.log('测试图片: ' + UPLOAD_FILE + ' (' + Math.round(fs.statSync(UPLOAD_FILE).size / 1024) + ' KB)');

    const ding = await db.query("SELECT id FROM users WHERE username='ding'");
    if (!ding.rows.length) throw new Error('找不到 ding 账号');
    sid = 'solbr-' + crypto.randomBytes(8).toString('hex');
    await db.query('INSERT INTO sessions (sid, user_id) VALUES ($1,$2)', [sid, ding.rows[0].id]);

    const e = await api('POST', '/api/errors', { sid, body: { subject: 'physics', grade: '9', image: TINY, note: '解答功能浏览器验证' } });
    if (!e.body.ok) throw new Error('建错题失败: ' + JSON.stringify(e.body));
    eid = e.body.item.id;
    const realJpg = 'data:image/jpeg;base64,' + fs.readFileSync(UPLOAD_FILE).toString('base64');
    await api('POST', '/api/errors/' + eid + '/solutions', { sid, body: { image: realJpg, note: '张老师的解法' } });
    await api('POST', '/api/errors/' + eid + '/solutions', { sid, body: { image: realJpg } });
    console.log('已造数据: 错题 ' + eid + ' + 2 张真实图片解答\n');

    /* ---------- 启动 Chromium ---------- */
    proc = spawn(CHROME, [
      '--headless=new', '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=/tmp/cdp-sol-profile', '--no-first-run', '--no-default-browser-check',
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
      if (!v) throw new Error('脚本无返回值: ' + JSON.stringify(r.result).slice(0, 500));
      return v;
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, 'wb_sol_' + name + '.png'), Buffer.from(s.result.data, 'base64'));
      console.log('   📸 screenshots/wb_sol_' + name + '.png');
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await send('Network.enable');
    await send('Page.setInterceptFileChooserDialog', { enabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Network.setCookie', { name: 'sid', value: sid, domain: '127.0.0.1', path: '/' });
    await send('Page.navigate', { url: BASE + '/' });

    let ready = false;
    for (let i = 0; i < 60; i++) {
      const r = await send('Runtime.evaluate', {
        expression: 'document.readyState === "complete" && typeof Views !== "undefined" && !document.querySelector(".auth-wrap")',
        returnByValue: true,
      });
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

    /* ================= 第 1 步：详情页里的「他人正确解答」区块 ================= */
    console.log('=== 1. 详情页区块（位置 / 缩略图 / 编号 / 说明）===');
    report((await evalJS(`(async () => {
      ${HELPER}
      App.go('book'); await sleep(250);
      Views.openDetail('${eid}');
      await waitFor(() => !!document.querySelector('#solBox') && items().length === 2);

      ok('详情弹层已打开', !!bd());
      const solBox = document.querySelector('#solBox');
      ok('备注下方出现了「他人正确解答」区块', !!solBox);
      ok('区块带 👥 图标与完整文案', !!bd().innerHTML.match(/👥 他人正确解答（拍同学或老师写的正确解法，可多张）/));
      const rNote = bd().querySelector('#noteInput').getBoundingClientRect();
      const rSol = solBox.getBoundingClientRect();
      ok('区块确实在备注输入框下方', rSol.top >= rNote.bottom - 1,
         '备注底 ' + Math.round(rNote.bottom) + ' / 区块顶 ' + Math.round(rSol.top));
      ok('懒加载出 2 张他人解答', items().length === 2, items().length);
      ok('缩略图按顺序编号 1,2', items().map(el => el.querySelector('.sol-badge').textContent).join(',') === '1,2',
         items().map(el => el.querySelector('.sol-badge').textContent).join(','));
      ok('第 1 张显示说明文字', items()[0].textContent.indexOf('张老师的解法') >= 0);
      // 缩略图带 loading="lazy"，headless 里可能一直不进视口而不加载 → 强制加载 + 等解码，避免假失败
      const thumbs = items().map(el => el.querySelector('img'));
      thumbs.forEach(im => { im.loading = 'eager'; });
      solBox.scrollIntoView({ block: 'center' });
      await Promise.all(thumbs.map(im => im.decode().catch(() => { })));
      ok('缩略图真的加载出了图片', thumbs.every(im => im.complete && im.naturalWidth > 0),
         thumbs.map(im => im.naturalWidth).join(','));
      ok('每张都有删除按钮', document.querySelectorAll('#solBox [data-delsol]').length === 2);
      ok('拍照 / 相册两个按钮都在', !!bd().querySelector('#solPick') && !!bd().querySelector('#solAlbum'));
      ok('提示文案说明可多张', /可多张/.test(bd().innerHTML));
      return R;
    })()`)));
    await shot('detail');

    /* ================= 第 2 步：点缩略图看大图 + 改说明 ================= */
    console.log('\n=== 2. 大图查看 / 改说明 ===');
    report((await evalJS(`(async () => {
      ${HELPER}
      items()[0].querySelector('img').click();
      await sleep(200);
      const viewer = document.querySelector('.sol-viewer');
      ok('点缩略图打开大图', !!viewer);
      ok('大图盖在详情弹层之上', +getComputedStyle(viewer).zIndex > +getComputedStyle(document.querySelector('.mask')).zIndex,
         'viewer z=' + getComputedStyle(viewer).zIndex + ' / mask z=' + getComputedStyle(document.querySelector('.mask')).zIndex);
      const vi = viewer.querySelector('img');
      // decode() 会等到图片真正可呈现，比轮询尺寸稳（图片没解码时宽度就是 0）
      vi.loading = 'eager';
      await vi.decode().catch(() => { });
      ok('大图显示尺寸正常', vi.getBoundingClientRect().width > 200, Math.round(vi.getBoundingClientRect().width));
      ok('大图遮罩是深色（聚焦看图）', getComputedStyle(viewer).backgroundColor.indexOf('rgba(9, 11, 20') === 0,
         getComputedStyle(viewer).backgroundColor);
      ok('顶部标题是白字，在深底上可读', getComputedStyle(viewer.querySelector('.sol-viewer-hd')).color === 'rgb(255, 255, 255)',
         getComputedStyle(viewer.querySelector('.sol-viewer-hd')).color);
      ok('关闭按钮也是白字', getComputedStyle(viewer.querySelector('.sol-x')).color === 'rgb(255, 255, 255)',
         getComputedStyle(viewer.querySelector('.sol-x')).color);
      const ne = viewer.querySelector('#solNoteEdit');
      ok('说明回显原文', ne && ne.value === '张老师的解法', ne && ne.value);
      ok('大图自带提示占位文案', /加个说明/.test(ne.placeholder), ne.placeholder);
      return R;
    })()`)));
    await shot('viewer');

    report((await evalJS(`(async () => {
      ${HELPER}
      const ne = document.querySelector('#solNoteEdit');
      ne.value = '张老师板书：先并联再算总电阻';
      ne.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => items()[0].textContent.indexOf('先并联再算总电阻') >= 0);
      const j = await fetch('/api/errors/${eid}/solutions', { credentials: 'same-origin' }).then(r => r.json());
      ok('改说明后服务端已更新', j.items[0].note === '张老师板书：先并联再算总电阻', JSON.stringify(j.items.map(x => x.note)));
      ok('缩略图说明同步刷新', items()[0].textContent.indexOf('先并联再算总电阻') >= 0, items()[0].textContent.slice(0, 40));
      document.querySelector('.sol-viewer [data-act="close"]').click();
      await sleep(250);
      ok('关闭大图后浮层被移除', !document.querySelector('.sol-viewer'));
      return R;
    })()`)));

    /* ================= 第 3 步：删除（点两次才真删）================= */
    console.log('\n=== 3. 删除一张（防手滑：要点两次）===');
    report((await evalJS(`(async () => {
      ${HELPER}
      const del0 = document.querySelectorAll('#solBox [data-delsol]')[0];
      del0.click(); await sleep(200);
      ok('第一次点只是变成「再点一次会删除」', document.querySelectorAll('#solBox [data-delsol]').length === 2 && del0.textContent.trim() === '再点一次会删除',
         del0.textContent.trim());
      const itemBox = del0.closest('.sol-item').getBoundingClientRect();
      const btnBox = del0.getBoundingClientRect();
      ok('按钮不超出缩略图（文案没被裁掉）', btnBox.left >= itemBox.left - 0.5 && btnBox.right <= itemBox.right + 0.5,
         '钮 ' + Math.round(btnBox.width) + 'px / 图 ' + Math.round(itemBox.width) + 'px');
      return R;
    })()`)));
    await shot('armed-delete');

    report((await evalJS(`(async () => {
      ${HELPER}
      const b = document.querySelectorAll('#solBox [data-delsol]')[0];
      // 截图耗时可能让「待删」状态超过 3 秒自动失效，这里重新点一次进入待删态
      if (b.textContent.trim() !== '再点一次会删除') { b.click(); await sleep(250); }
      b.click();
      await waitFor(() => items().length === 1);
      ok('第二次点才真的删掉', items().length === 1, items().length);
      const j = await fetch('/api/errors/${eid}/solutions', { credentials: 'same-origin' }).then(r => r.json());
      ok('服务端也只剩 1 张', j.items.length === 1, j.items.length);
      return R;
    })()`)));

    /* ================= 第 4 步：拍照（真实文件 → 框选编辑器）================= */
    console.log('\n=== 4. 点「拍照」→ 真实选图 → 框选编辑器 ===');
    await evalJS(`(async () => {
      const btn = document.querySelector('#solPick');
      App.go('book'); await new Promise(r => setTimeout(r, 200));
      btn.click();                       // 置好回调并唤起文件选择
      await new Promise(r => setTimeout(r, 300));
      return { ok: 1 };
    })()`);
    const doc = await send('DOM.getDocument', { depth: -1 });
    const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInputSol' });
    await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [UPLOAD_FILE] });
    await new Promise(r => setTimeout(r, 1500));

    report((await evalJS(`(async () => {
      ${HELPER}
      const cr = document.querySelector('.crop-root');
      ok('选到图后框选编辑器自动打开', !!cr);
      ok('编辑器层级 200，稳在详情弹层(50)与大图(150)之上', cr && +getComputedStyle(cr).zIndex === 200,
         cr ? getComputedStyle(cr).zIndex : '未打开');
      ok('编辑器已渲染源图', !!document.querySelector('.crop-stage canvas.crop-img'));
      ok('编辑器文案按用途改成了「正确解法」', /只框住正确解法那部分/.test((document.querySelector('.crop-hd-t') || {}).textContent || ''),
         (document.querySelector('.crop-hd-t') || {}).textContent);
      ok('没有跳到录入页（tab 仍是错题本）', document.querySelector('.tab.is-active').dataset.tab === 'book',
         document.querySelector('.tab.is-active').dataset.tab);
      ok('详情弹层还在下面', !!bd());
      return R;
    })()`)));
    await shot('crop-over-sheet');

    /* ================= 第 5 步：确认框选 → 上传 → 列表刷新 ================= */
    console.log('\n=== 5. 确认框选 → 上传 → 列表刷新 ===');
    report((await evalJS(`(async () => {
      ${HELPER}
      document.querySelector('[data-act="full"]').click();     // 整页确认
      await waitFor(() => !document.querySelector('.crop-root') && items().length === 2, 8000);
      ok('确认后编辑器收起', !document.querySelector('.crop-root'));
      ok('详情弹层仍在（没被关掉）', !!bd());
      ok('解答变成 2 张', items().length === 2, items().length);
      ok('新图排在最后一张', /^\\/uploads\\//.test((document.querySelectorAll('#solBox .sol-item img')[1] || {}).getAttribute('src') || ''),
         (document.querySelectorAll('#solBox .sol-item img')[1] || {}).getAttribute('src'));
      const ni = items()[1].querySelector('img');
      ni.loading = 'eager';
      await ni.decode().catch(() => { });
      ok('新缩略图能正常显示', ni.naturalWidth > 0, ni.naturalWidth);
      ok('框选的原图缓存已清掉（录入页不会被污染）', Crop.hasSource() === false);
      const j = await fetch('/api/errors/${eid}/solutions', { credentials: 'same-origin' }).then(r => r.json());
      ok('服务端确认 2 张', j.items.length === 2, j.items.length);
      ok('新图是 .jpg 文件路径', /\\.jpg$/.test(j.items[1].image), j.items[1].image);
      return R;
    })()`)));
    await shot('after-add');

    /* ================= 第 6 步：错题本网格上的标记 ================= */
    console.log('\n=== 6. 错题本网格小标记 ===');
    report((await evalJS(`(async () => {
      ${HELPER}
      Views.closeSheet();
      App.go('book');
      await waitFor(() => !!document.querySelector('.grid-item[data-id="${eid}"]'));
      const cell = document.querySelector('.grid-item[data-id="${eid}"]');
      ok('网格里能找到这条错题', !!cell);
      const badge = cell && cell.querySelector('.badge.sol');
      ok('缩略图上有 👥 张数标记', !!badge, badge && badge.textContent);
      ok('标记数字 = 2', badge && /2/.test(badge.textContent), badge && badge.textContent);
      return R;
    })()`)));
    await shot('grid-badge');

    console.log('\n' + '='.repeat(46));
    console.log('真浏览器验证：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail) process.exitCode = 1;

  } catch (e) {
    console.log('ERR ' + e.message);
    process.exitCode = 1;
  } finally {
    try {
      if (eid) await api('DELETE', '/api/errors/' + eid, { sid });
      if (eid) {
        // 兜底：接口没删干净（或返回非 2xx）时直接清库，并把图片文件一并删掉，
        // 保证任何失败路径下都不给用户的库和 uploads/ 留测试垃圾
        const files = [];
        (await db.query('SELECT image FROM errors    WHERE id=$1', [eid])).rows.forEach(r => r.image && files.push(r.image));
        (await db.query('SELECT image FROM solutions WHERE error_id=$1', [eid])).rows.forEach(r => r.image && files.push(r.image));
        await db.query('DELETE FROM solutions WHERE error_id=$1', [eid]);
        await db.query('DELETE FROM errors    WHERE id=$1', [eid]);
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
