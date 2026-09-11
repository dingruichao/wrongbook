/* 真浏览器验证：用 CDP 驱动本机 Chromium 打开错题本，对框选编辑器做端到端像素校验 */
const { spawn } = require('child_process');

const CHROME = process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PORT = 9333;

const PAGE_TEST = `(async () => {
  const R = { checks: [] };
  const ok = (n, pass, extra) => R.checks.push({ n, pass: !!pass, extra: extra == null ? '' : String(extra) });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* 1. 造一张 1000x800 的四象限彩图 */
  const src = document.createElement('canvas');
  src.width = 1000; src.height = 800;
  const g0 = src.getContext('2d');
  g0.fillStyle = '#ff0000'; g0.fillRect(0, 0, 500, 400);       // 左上 红
  g0.fillStyle = '#00ff00'; g0.fillRect(500, 0, 500, 400);     // 右上 绿
  g0.fillStyle = '#0000ff'; g0.fillRect(0, 400, 500, 400);     // 左下 蓝
  g0.fillStyle = '#ffff00'; g0.fillRect(500, 400, 500, 400);   // 右下 黄
  const blob = await new Promise(r => src.toBlob(r, 'image/jpeg', 0.96));
  const file = new File([blob], 'paper.jpg', { type: 'image/jpeg' });

  /* 2. 打开编辑器 */
  let promise = Crop.open(file, {});
  await sleep(600);
  ok('编辑器已挂载到页面', !!document.querySelector('.crop-root'));
  ok('源图已渲染进舞台', !!document.querySelector('.crop-stage canvas.crop-img'));
  const st = document.querySelector('.crop-stage');
  ok('舞台有可交互尺寸', st && st.getBoundingClientRect().height > 200,
     st ? Math.round(st.getBoundingClientRect().width) + 'x' + Math.round(st.getBoundingClientRect().height) : '无');

  const sr = st.getBoundingClientRect();
  const S = Math.min(sr.width * 0.94 / 1000, sr.height * 0.94 / 800);   // fitScale
  const bx = sr.left + (sr.width - 1000 * S) / 2;
  const by = sr.top + (sr.height - 800 * S) / 2;

  const pd = (el, x, y, id) => el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const pm = (x, y, id) => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: id, clientX: x, clientY: y, bubbles: true }));
  const pu = id => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: id, clientX: 0, clientY: 0, bubbles: true }));

  /* 3. 把取景框调成正好盖住左上角红块 */
  const nw = document.querySelector('.crop-h[data-h="nw"]');
  pd(nw, bx, by, 1); pm(bx, by, 1); pu(1);
  const se = document.querySelector('.crop-h[data-h="se"]');
  pd(se, bx, by, 2); pm(bx + 500 * S, by + 400 * S, 2); pu(2);
  const fr = document.querySelector('.crop-frame').getBoundingClientRect();
  ok('取景框已收缩到红块大小', Math.abs(fr.width - 500 * S) < 4 && Math.abs(fr.height - 400 * S) < 4,
     Math.round(fr.width) + 'x' + Math.round(fr.height) + ' 期望 ' + Math.round(500 * S) + 'x' + Math.round(400 * S));

  /* 4. 完成 → 解码结果，查像素 */
  document.querySelector('[data-act="ok"]').click();
  const out = await promise;
  ok('完成返回了图片数据', /^data:image\\/jpeg/.test(out || ''), (out || '').slice(0, 30));

  const img = new Image(); img.src = out; await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
  const px = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
  const rgb = a => 'rgb(' + a.join(',') + ')';

  ok('导出尺寸 ≈ 红块 500x400', Math.abs(cv.width - 500) <= 3 && Math.abs(cv.height - 400) <= 3, cv.width + 'x' + cv.height);
  const mid = px(Math.floor(cv.width / 2), Math.floor(cv.height / 2));
  ok('导出内容确实是左上红块', mid[0] > 200 && mid[1] < 70 && mid[2] < 70, rgb(mid));
  const c1 = px(25, 25), c2 = px(cv.width - 25, cv.height - 25);
  ok('四角也都是红的（没有框歪）', c1[0] > 200 && c1[2] < 70 && c2[0] > 200 && c2[2] < 70, rgb(c1) + ' / ' + rgb(c2));

  /* 5. 整页导出：应得到完整 4 象限 */
  promise = Crop.reopen();
  await sleep(350);
  document.querySelector('[data-act="full"]').click();
  const out2 = await promise;
  const img2 = new Image(); img2.src = out2; await img2.decode();
  const cv2 = document.createElement('canvas'); cv2.width = img2.naturalWidth; cv2.height = img2.naturalHeight;
  const g2 = cv2.getContext('2d'); g2.drawImage(img2, 0, 0);
  const pick = (x, y) => { const d = g2.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
  ok('整页导出 1000x800', cv2.width === 1000 && cv2.height === 800, cv2.width + 'x' + cv2.height);
  const tl = pick(250, 200), tr = pick(750, 200), bl = pick(250, 600), br = pick(750, 600);
  const isR = a => a[0] > 200 && a[1] < 70 && a[2] < 70;
  const isG = a => a[0] < 70 && a[1] > 200 && a[2] < 70;
  const isB = a => a[0] < 70 && a[1] < 70 && a[2] > 200;
  const isY = a => a[0] > 200 && a[1] > 200 && a[2] < 70;
  ok('整页四象限颜色都对', isR(tl) && isG(tr) && isB(bl) && isY(br),
     [rgb(tl), rgb(tr), rgb(bl), rgb(br)].join(' | '));

  /* 6. 旋转 90° 后整页：画面应整体转过来（左上红 → 右上红） */
  promise = Crop.reopen();
  await sleep(300);
  document.querySelector('[data-act="rotate"]').click();
  await sleep(200);
  document.querySelector('[data-act="full"]').click();
  const out3 = await promise;
  const img3 = new Image(); img3.src = out3; await img3.decode();
  const cv3 = document.createElement('canvas'); cv3.width = img3.naturalWidth; cv3.height = img3.naturalHeight;
  const g3 = cv3.getContext('2d'); g3.drawImage(img3, 0, 0);
  const pick3 = (x, y) => { const d = g3.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
  ok('旋转后整页导出 800x1000', cv3.width === 800 && cv3.height === 1000, cv3.width + 'x' + cv3.height);
  const r1 = pick3(200, 250), r2 = pick3(600, 250), r3 = pick3(200, 750), r4 = pick3(600, 750);
  ok('旋转后：原左上红块转到右上', isB(r1) && isR(r2) && isY(r3) && isG(r4),
     '左上' + rgb(r1) + ' 右上' + rgb(r2) + ' 左下' + rgb(r3) + ' 右下' + rgb(r4));

  /* 7. 取消 */
  promise = Crop.reopen();
  await sleep(300);
  document.querySelector('[data-act="cancel"]').click();
  ok('取消返回 null', (await promise) === null);
  ok('取消后编辑器已移除', !document.querySelector('.crop-root'));

  return R;
})()`;

async function main() {
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=/tmp/cdp-crop-profile', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox', 'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      targets = await r.json();
      if (targets && targets.some(t => t.type === 'page')) break;
    } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!targets) { console.log('❌ 无法连接 Chromium'); proc.kill(); process.exit(1); }

  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params) => new Promise(res => {
    const mid = ++id;
    waiting.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await send('Page.navigate', { url: 'http://127.0.0.1:8322/' });

  // 等页面与脚本就绪
  for (let i = 0; i < 40; i++) {
    const r = await send('Runtime.evaluate', {
      expression: 'document.readyState === "complete" && typeof Crop !== "undefined" && typeof Views !== "undefined"',
      returnByValue: true,
    });
    if (r.result && r.result.result && r.result.result.value === true) break;
    await new Promise(r2 => setTimeout(r2, 250));
  }

  const res = await send('Runtime.evaluate', {
    expression: PAGE_TEST, awaitPromise: true, returnByValue: true,
  });

  const val = res.result && res.result.result && res.result.result.value;
  if (!val) {
    console.log('❌ 页面内测试没有返回值');
    console.log(JSON.stringify(res.result || res, null, 1).slice(0, 1500));
  } else {
    let pass = 0, fail = 0;
    val.checks.forEach(c => {
      if (c.pass) { pass++; console.log('  ✅ ' + c.n + (c.extra ? '  [' + c.extra + ']' : '')); }
      else { fail++; console.log('  ❌ ' + c.n + (c.extra ? '  → ' + c.extra : '')); }
    });
    console.log('\n' + '='.repeat(46));
    console.log(`真浏览器验证：通过 ${pass} 项，失败 ${fail} 项`);
    if (fail) process.exitCode = 1;
  }

  ws.close();
  proc.kill();
  setTimeout(() => process.exit(process.exitCode || 0), 300);
}

main().catch(e => { console.log('ERR', e.message); process.exit(1); });
