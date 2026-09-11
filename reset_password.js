/* 重置某个账号的登录口令（忘了口令时的兜底手段）
 *
 * 用法：
 *   node reset_password.js                     # 列出所有账号
 *   node reset_password.js <用户名> <新口令>     # 重置指定账号
 *
 * 说明：口令用与 enStudy 同样的 scrypt 加盐哈希写入，不存明文。
 *       如果连管理员账号的口令也忘了，用本脚本重置 admin 即可。
 */
const crypto = require('crypto');
const { Client } = require('pg');

const DB = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postuser',
  password: process.env.PGPASSWORD || 'postuser',
  database: process.env.PGDATABASE || 'wrongbook',
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + derived;
}

(async () => {
  const username = process.argv[2];
  const newPassword = process.argv[3];
  const c = new Client(DB);
  await c.connect();
  try {
    const users = await c.query('SELECT id, username, role, created_at FROM users ORDER BY id');

    if (!username) {
      console.log('当前账号（共 ' + users.rowCount + ' 个）：');
      users.rows.forEach(u => console.log('  #' + u.id + '  ' + u.username +
        (u.role === 'admin' ? '  [管理员]' : '') +
        '  注册于 ' + new Date(u.created_at).toLocaleDateString('zh-CN')));
      console.log('\n用法：node reset_password.js <用户名> <新口令>');
      return;
    }

    if (!newPassword) {
      console.error('❌ 请提供新口令：node reset_password.js ' + username + ' <新口令>');
      process.exitCode = 1;
      return;
    }
    if (newPassword.length < 4 || newPassword.length > 64) {
      console.error('❌ 口令需 4-64 位');
      process.exitCode = 1;
      return;
    }

    const hit = users.rows.filter(u => u.username === username);
    if (!hit.length) {
      console.error('❌ 没有这个账号：' + username + '（可用 node reset_password.js 查看全部账号）');
      process.exitCode = 1;
      return;
    }

    await c.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(newPassword), hit[0].id]);
    // 该用户原有的登录会话全部作废，避免旧设备还留着登录态
    const killed = await c.query('DELETE FROM sessions WHERE user_id=$1', [hit[0].id]);
    console.log('✅ 已重置「' + username + '」的口令，并作废其 ' + killed.rowCount + ' 个登录会话。');
    console.log('   现在可以用新口令在登录页登录。');
  } catch (e) {
    console.error('❌ 重置失败：', e.message);
    process.exitCode = 1;
  } finally {
    try { await c.end(); } catch (_) { }
  }
})();
