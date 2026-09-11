/* 一次性迁移：把旧的 data/errors.json 与 data/kv.json 导入 PostgreSQL
 *
 * 用法：node migrate_json_to_pg.js
 *
 * 行为：
 *   - 读取 data/errors.json（错题数组）和 data/kv.json（设置对象）
 *   - 以 id 为主键 upsert 进 errors 表；kv 表同样按 key upsert
 *   - 已存在同 id 的记录不会覆盖（除非加 --force）
 *   - 图片文件不迁移：仍在 uploads/ 目录，errors.image 存的就是相对路径
 *
 * 迁移完成后旧的 data/*.json 会被保留（不删除），确认无误后可自行归档。
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = __dirname;
const ERRORS_FILE = path.join(ROOT, 'data', 'errors.json');
const KV_FILE = path.join(ROOT, 'data', 'kv.json');
const FORCE = process.argv.includes('--force');

const DB = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postuser',
  password: process.env.PGPASSWORD || 'postuser',
  database: process.env.PGDATABASE || 'wrongbook',
};

function readJSON(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return def;
  }
}

(async () => {
  const errors = readJSON(ERRORS_FILE, []);
  const kv = readJSON(KV_FILE, {});
  if (!Array.isArray(errors) || !errors.length) {
    console.log('ℹ️  data/errors.json 为空或不存在，无需迁移错题');
  }
  if (!Object.keys(kv).length) {
    console.log('ℹ️  data/kv.json 为空或不存在，无需迁移设置');
  }

  const pool = new Pool(DB);
  let errCount = 0;
  try {
    const client = await pool.connect();
    try {
      let inserted = 0, skipped = 0;
      for (const it of errors) {
        if (!it || !it.id) { console.log('⚠️  跳过无 id 的记录'); continue; }
        const exist = await client.query('SELECT 1 FROM errors WHERE id=$1', [it.id]);
        if (exist.rows.length && !FORCE) { skipped++; continue; }
        await client.query(
          `INSERT INTO errors (id, subject, grade, image, note, analysis, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET
             subject = EXCLUDED.subject, grade = EXCLUDED.grade, image = EXCLUDED.image,
             note = EXCLUDED.note, analysis = EXCLUDED.analysis,
             created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
          [
            it.id,
            String(it.subject || 'math'),
            String(it.grade || '7'),
            String(it.image || ''),
            String(it.note || '').slice(0, 500),
            it.analysis ? JSON.stringify(it.analysis) : null,
            Number(it.createdAt) || Date.now(),
            Number(it.updatedAt) || Date.now(),
          ]
        );
        inserted++;
      }
      console.log('✅ 错题迁移完成：新增/更新 ' + inserted + ' 条，跳过已存在 ' + skipped + ' 条');

      for (const key of Object.keys(kv)) {
        await client.query(
          'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
          [key, kv[key]]
        );
        console.log('✅ 设置已迁移: ' + key);
      }

      const c = await client.query('SELECT count(*)::int AS n FROM errors');
      console.log('✅ 当前数据库错题总数: ' + c.rows[0].n);
    } finally {
      client.release();
    }
  } catch (e) {
    errCount++;
    console.error('❌ 迁移失败:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
  if (errCount) process.exit(1);
})();
