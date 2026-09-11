/* 一次性迁移：把 enStudy 数据库里已配置的大模型服务商（providers）搬到错题本
 *
 * 用法：node migrate_providers.js [--dry]
 *
 * 做什么：
 *   1) 连 enStudy 的库（默认 postuser），扫所有 wordweek.v1.* 记录，收集 settings.providers
 *   2) 合并同名服务商（多份数据取非空的那份）
 *   3) 写入错题本库 wrongbook 的 kv.settings：providers / currentProvider / apiBase / apiKey / model
 *   4) 保留错题本原有的 defaultSubject / defaultGrade
 *
 * 注意：只搬配置，不动错题数据；Key 只搬运不打印（日志里只显示前后几位）。
 */
const { Client } = require('pg');

const SRC = { // enStudy 所在库
  host: process.env.SRC_PGHOST || 'localhost',
  port: Number(process.env.SRC_PGPORT || 5432),
  user: process.env.SRC_PGUSER || 'postuser',
  password: process.env.SRC_PGPASSWORD || 'postuser',
  database: process.env.SRC_PGDATABASE || 'postuser',
};
const DST = { // 错题本所在库
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postuser',
  password: process.env.PGPASSWORD || 'postuser',
  database: process.env.PGDATABASE || 'wrongbook',
};
const DRY = process.argv.includes('--dry');

function mask(k) {
  k = String(k || '');
  if (!k) return '(空)';
  return k.slice(0, 6) + '…' + k.slice(-4) + '（长度 ' + k.length + '）';
}

(async () => {
  const src = new Client(SRC);
  const dst = new Client(DST);
  const merged = {};          // 服务商配置合并结果
  let currentProvider = '';
  let lastSettings = null;    // 最近一次更新的那份设置（用它作为「当前生效」）

  try {
    await src.connect();
    const keys = await src.query("SELECT key, updated_at FROM kv WHERE key LIKE 'wordweek.v1%' ORDER BY updated_at");
    console.log('enStudy 中找到 ' + keys.rows.length + ' 份用户数据');

    for (const row of keys.rows) {
      const r = await src.query('SELECT value FROM kv WHERE key=$1', [row.key]);
      const s = (r.rows[0] && r.rows[0].value && r.rows[0].value.settings) || {};
      if (!s.providers || !Object.keys(s.providers).length) continue;
      console.log('  从 ' + row.key + ' 收集到 ' + Object.keys(s.providers).length + ' 个服务商');
      for (const p of Object.keys(s.providers)) {
        const cfg = s.providers[p] || {};
        if (!merged[p]) merged[p] = { apiKey: '', model: '' };
        if (cfg.apiKey) merged[p].apiKey = cfg.apiKey;
        if (cfg.model) merged[p].model = cfg.model;
      }
      if (s.currentProvider) currentProvider = s.currentProvider;
      lastSettings = s;
    }
  } catch (e) {
    console.error('❌ 读取 enStudy 数据失败:', e.message);
    await src.end().catch(() => { });
    process.exit(1);
  }
  await src.end();

  if (!Object.keys(merged).length) {
    console.log('ℹ️  enStudy 中没有任何服务商配置，无需迁移');
    await dst.end().catch(() => { });
    return;
  }

  console.log('\n收集到的服务商：');
  for (const p of Object.keys(merged)) {
    console.log('  · ' + p + '  model=' + (merged[p].model || '(空)') + '  key=' + mask(merged[p].apiKey));
  }
  console.log('当前服务商: ' + (currentProvider || '(未指定)'));

  if (DRY) { console.log('\n--dry 模式，未写入'); return; }

  try {
    await dst.connect();
    const cur = await dst.query('SELECT value FROM kv WHERE key=$1', ['settings']);
    const old = (cur.rows.length && cur.rows[0].value) || {};
    // 保留错题本自己的默认科目/年级，其余用 enStudy 的服务商数据覆盖
    const next = Object.assign({}, old, {
      providers: merged,
      currentProvider: currentProvider || 'siliconflow',
      apiBase: (lastSettings && lastSettings.apiBase) || old.apiBase || 'https://api.siliconflow.cn/v1',
      apiKey: (lastSettings && lastSettings.apiKey) || '',
      model: (lastSettings && lastSettings.model) || old.model || '',
    });
    await dst.query(
      'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      ['settings', next]
    );
    console.log('\n✅ 已写入错题本设置');
    console.log('   currentProvider = ' + next.currentProvider);
    console.log('   apiBase         = ' + next.apiBase);
    console.log('   model           = ' + next.model);
    console.log('   apiKey          = ' + mask(next.apiKey));
    console.log('   默认科目/年级保持不变: ' + next.defaultSubject + ' / ' + next.defaultGrade);
  } catch (e) {
    console.error('❌ 写入失败:', e.message);
    process.exitCode = 1;
  } finally {
    await dst.end().catch(() => { });
  }
})();
