/* 错题本数据库初始化：创建独立库 wrongbook + 建表 + 连通性自检
 *
 * 用法：node db_setup.js
 *
 * 说明：
 *   1) 先用默认管理库（postuser）连上，CREATE DATABASE wrongbook（已存在则跳过）
 *   2) 再连到 wrongbook 库，创建 users / sessions / errors / solutions / kv 表与索引
 *   3) 最后做一次「写一条再读回来」的自检，确认真的可读写
 *
 * 表结构（与参照项目 enStudy 保持一致的用户体系）：
 *   users     用户账号，密码用 scrypt 存为 "salt:hash"（绝不存明文）
 *   sessions  登录会话，sid 存在 HttpOnly Cookie 里，30 天有效
 *   errors    错题记录，user_id 关联到 users（错题按用户隔离）；mastered 标记是否已会
 *   solutions 他人正确解答的照片，error_id 关联到 errors（一条错题多张）
 *   kv        应用设置，key 采用「settings.<userId>」命名空间实现按用户隔离
 *
 * 连接参数可用环境变量覆盖：PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
 */
const { Client } = require('pg');

const ADMIN_DB = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postuser',
  password: process.env.PGPASSWORD || 'postuser',
  database: process.env.PGADMINDB || 'postuser',
};
const APP_DB = (process.env.PGDATABASE || 'wrongbook');

const DDL = `
/* ---------- 用户与会话（与 enStudy 同构，密码哈希可直接复用） ---------- */
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
-- 老库缺 role 列时补上，并把 admin 提为管理员
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
UPDATE users SET role='admin' WHERE username='admin';

/* ---------- 错题（新增 user_id 归属列） ---------- */
CREATE TABLE IF NOT EXISTS errors (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  grade       TEXT NOT NULL,
  image       TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  analysis    JSONB,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  user_id     INT REFERENCES users(id) ON DELETE CASCADE,
  mastered    BOOLEAN NOT NULL DEFAULT FALSE     -- 是否已会（错题本可按此筛选）
);
-- 已存在的表补列 + 外键（历史数据 user_id 为空，迁移脚本会补归属）
ALTER TABLE errors ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE errors ADD COLUMN IF NOT EXISTS mastered BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_errors_created       ON errors (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_subject_grade ON errors (subject, grade);
CREATE INDEX IF NOT EXISTS idx_errors_user_created  ON errors (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_user_mastered ON errors (user_id, mastered, created_at DESC);

/* ---------- 他人正确解答（一条错题 N 张，删错题时级联清理） ---------- */
CREATE TABLE IF NOT EXISTS solutions (
  id         TEXT PRIMARY KEY,
  error_id   TEXT NOT NULL REFERENCES errors(id) ON DELETE CASCADE,
  user_id    INT REFERENCES users(id) ON DELETE CASCADE,
  image      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_solutions_error ON solutions (error_id, created_at);
CREATE INDEX IF NOT EXISTS idx_solutions_user  ON solutions (user_id, created_at DESC);

/* ---------- 设置 KV（key 用 settings.<userId> 做命名空间） ---------- */
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

(async () => {
  const admin = new Client(ADMIN_DB);
  try {
    await admin.connect();
    const v = await admin.query('select version()');
    console.log('✅ 连接成功');
    console.log('   PostgreSQL:', v.rows[0].version.split(' ').slice(0, 2).join(' '));

    // CREATE DATABASE 不能带参数绑定，库名是代码内固定常量，这里做一次合法性校验后拼接
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(APP_DB)) throw new Error('库名不合法: ' + APP_DB);
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [APP_DB]);
    if (exists.rows.length) {
      console.log('ℹ️  数据库已存在，跳过创建: ' + APP_DB);
    } else {
      await admin.query('CREATE DATABASE ' + APP_DB + ' OWNER ' + (process.env.PGUSER || 'postuser'));
      console.log('✅ 已创建数据库: ' + APP_DB);
    }
  } catch (e) {
    console.error('❌ 创建数据库失败:', e.message);
    try { await admin.end(); } catch (_) { }
    process.exit(1);
  }
  await admin.end();

  const app = new Client(Object.assign({}, ADMIN_DB, { database: APP_DB }));
  try {
    await app.connect();
    await app.query(DDL);
    console.log('✅ 已确保表 users / sessions / errors / solutions / kv 存在');

    // 自检：写一条再读回来
    await app.query(
      'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      ['__selfcheck__', { ok: true, ts: Date.now() }]
    );
    const r = await app.query('SELECT value FROM kv WHERE key=$1', ['__selfcheck__']);
    console.log('✅ 读写自检:', JSON.stringify(r.rows[0].value));
    await app.query('DELETE FROM kv WHERE key=$1', ['__selfcheck__']);
    console.log('✅ 清理自检数据完成');

    const c = await app.query('SELECT count(*)::int AS n FROM errors');
    const u = await app.query('SELECT count(*)::int AS n FROM users');
    console.log('✅ 当前记录数: users=' + u.rows[0].n + ' / errors=' + c.rows[0].n);
    const orphan = await app.query('SELECT count(*)::int AS n FROM errors WHERE user_id IS NULL');
    if (orphan.rows[0].n) {
      console.log('ℹ️  有 ' + orphan.rows[0].n + ' 条错题还没有归属用户，可执行 node migrate_users_from_enstudy.js 补上');
    }
  } catch (e) {
    console.error('❌ 建表失败:', e.message);
    process.exitCode = 1;
  } finally {
    try { await app.end(); } catch (_) { }
  }
})();
