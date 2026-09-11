/* 把 enStudy 的用户账号迁移到错题本的 wrongbook 库，并给历史错题补上归属
 *
 * 背景：错题本原先没有用户体系，所有错题是"无主"的。加上登录后错题要按用户隔离，
 *       所以需要（1）把参照项目 enStudy 的账号搬过来，（2）把已有数据挂到一个主人名下。
 *
 * 密码为什么能直接用：两个项目都用 Node crypto.scryptSync 存成 "salt:hash"（salt 16 字节、
 * 派生 64 字节），格式完全一致，因此复制 password_hash 后原密码照常可登录，无需重置。
 *
 * 用法：
 *   node migrate_users_from_enstudy.js            # 正式迁移
 *   node migrate_users_from_enstudy.js --dry      # 只预演，不改数据库
 *   node migrate_users_from_enstudy.js --owner=ding        # 指定历史错题的归属账号（默认 ding）
 *   node migrate_users_from_enstudy.js --only=ding,alice   # 只迁移指定账号
 *
 * 幂等：重复执行不会产生重复用户，也不会重复改归属。
 */
const { Client } = require('pg');

const PG = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postuser',
  password: process.env.PGPASSWORD || 'postuser',
};
const SRC_DB = process.env.SRC_DATABASE || 'postuser';    // enStudy 的库
const DST_DB = process.env.PGDATABASE || 'wrongbook';     // 错题本的库

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
function argVal(name, def) {
  const hit = args.filter(a => a.startsWith('--' + name + '='))[0];
  return hit ? hit.slice(name.length + 3) : def;
}
const OWNER = argVal('owner', 'ding');
const ONLY = argVal('only', '').split(',').map(s => s.trim()).filter(Boolean);

// 明显是自动化测试留下的账号，迁移时标出来，方便事后清理
const TESTY = /(_test_|^test|^final_|_demo$|^tmp)/i;

(async () => {
  const src = new Client(Object.assign({}, PG, { database: SRC_DB }));
  const dst = new Client(Object.assign({}, PG, { database: DST_DB }));
  try {
    await src.connect();
    await dst.connect();
    console.log('源库(enStudy): ' + SRC_DB + '  →  目标库(错题本): ' + DST_DB + (DRY ? '   [预演模式，不写库]' : ''));

    /* ---------- 1. 读源用户 ---------- */
    const rs = await src.query('SELECT id, username, password_hash, role, created_at FROM users ORDER BY id');
    let users = rs.rows;
    if (ONLY.length) users = users.filter(u => ONLY.indexOf(u.username) >= 0);
    console.log('\n[1/3] 源库用户 ' + rs.rows.length + ' 个' + (ONLY.length ? '，按 --only 筛选后 ' + users.length + ' 个' : ''));
    users.forEach(u => {
      console.log('   #' + u.id + ' ' + u.username + (u.role === 'admin' ? '（管理员）' : '') +
        (TESTY.test(u.username) ? '   ← 疑似测试账号' : ''));
    });

    /* ---------- 2. 迁入目标库 ---------- */
    let added = 0, updated = 0, skipped = 0;
    const idMap = {};   // 源 id -> 目标 id（若目标库已有同名用户、id 不同，需要按用户名对齐）
    for (const u of users) {
      const byName = await dst.query('SELECT id, username FROM users WHERE username=$1', [u.username]);
      if (byName.rows.length) {
        idMap[u.id] = byName.rows[0].id;
        if (DRY) { skipped++; continue; }
        // 已存在同名账号：同步密码与角色（这样改了密码重跑也能生效）
        await dst.query('UPDATE users SET password_hash=$1, role=$2 WHERE id=$3',
          [u.password_hash, u.role, byName.rows[0].id]);
        updated++;
        continue;
      }
      const idTaken = await dst.query('SELECT 1 FROM users WHERE id=$1', [u.id]);
      if (DRY) {
        added++;
        idMap[u.id] = idTaken.rows.length ? '(自增)' : u.id;
        continue;
      }
      const sql = idTaken.rows.length
        // 目标库该 id 已被占用（少见）：让数据库自增分配，用户名仍然唯一
        ? 'INSERT INTO users (username, password_hash, role, created_at) VALUES ($1,$2,$3,$4) RETURNING id'
        : 'INSERT INTO users (id, username, password_hash, role, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id';
      const params = idTaken.rows.length
        ? [u.username, u.password_hash, u.role, u.created_at]
        : [u.id, u.username, u.password_hash, u.role, u.created_at];
      const ins = await dst.query(sql, params);
      idMap[u.id] = ins.rows[0].id;
      added++;
    }
    console.log('\n[2/3] 用户写入：新增 ' + added + ' 个，更新 ' + updated + ' 个，已存在跳过 ' + skipped + ' 个');
    if (!DRY && added) {
      // 显式插入过 id，序列要跟上，否则后续注册会主键冲突
      await dst.query("SELECT setval('users_id_seq', GREATEST((SELECT COALESCE(MAX(id),1) FROM users), 1))");
      console.log('   已同步 users_id_seq 序列');
    }

    /* ---------- 3. 既有数据补归属 ---------- */
    let owner = await dst.query('SELECT id, username FROM users WHERE username=$1', [OWNER]);
    if (!owner.rows.length) {
      // 指定的归属账号不存在（比如没迁它）时，退回目标库里的第一个用户
      owner = await dst.query('SELECT id, username FROM users ORDER BY id LIMIT 1');
    }
    if (!owner.rows.length) {
      console.log('\n[3/3] ⚠️  目标库还没有任何用户，跳过归属处理；请先迁移用户再重跑一次');
    } else {
      const oid = owner.rows[0].id, oname = owner.rows[0].username;

      const orphan = await dst.query('SELECT count(*)::int AS n FROM errors WHERE user_id IS NULL');
      const oldKv = await dst.query("SELECT 1 FROM kv WHERE key='settings'");
      const newKv = await dst.query('SELECT 1 FROM kv WHERE key=$1', ['settings.' + oid]);

      console.log('\n[3/3] 历史数据归属 → ' + oname + ' (id=' + oid + ')');
      console.log('   无主错题 ' + orphan.rows[0].n + ' 条' + (DRY ? '' : ' → 归给 ' + oname));
      if (oldKv.rows.length) {
        console.log('   旧设置 kv["settings"]' +
          (newKv.rows.length ? '（目标 settings.' + oid + ' 已存在，需人工确认）' : ' → kv["settings.' + oid + '"]'));
      } else {
        console.log('   旧设置 kv["settings"] 不存在，无需迁移');
      }

      if (!DRY) {
        const r1 = await dst.query('UPDATE errors SET user_id=$1 WHERE user_id IS NULL', [oid]);
        if (r1.rowCount) console.log('   ✅ 已归属错题 ' + r1.rowCount + ' 条');
        if (oldKv.rows.length && !newKv.rows.length) {
          await dst.query("UPDATE kv SET key=$1 WHERE key='settings'", ['settings.' + oid]);
          console.log('   ✅ 设置已迁到 kv["settings.' + oid + '"]');
        }
        // 历史错题的图片仍按原路径存在 uploads/，不用动
      }
    }

    if (DRY) console.log('\n（预演结束，未修改任何数据。去掉 --dry 即为正式执行）');
    else console.log('\n✅ 迁移完成。可执行 node db_setup.js 复查记录数。');
  } catch (e) {
    console.error('❌ 迁移失败:', e.message);
    process.exitCode = 1;
  } finally {
    try { await src.end(); } catch (_) { }
    try { await dst.end(); } catch (_) { }
  }
})();
