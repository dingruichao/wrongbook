/* 错题本 H5 - 轻量服务器（仅用 Node 内置模块 + pg 驱动）
 *
 * 存储设计：
 *   - 错题元数据：PostgreSQL 独立库 wrongbook 的 errors 表（analysis 字段用 JSONB）
 *   - 他人解答  ：同库 solutions 表（一条错题对应 N 张「同学/老师写的正确解法」照片）
 *   - 应用设置  ：同库 kv 表（key / value JSONB），目前只存 settings
 *   - 错题图片  ：uploads/<uuid>.jpg（静态托管，浏览器直接 /uploads/xxx.jpg 访问）
 *     图片仍是文件系统存储——PG 里只存路径，避免把大二进制塞进数据库
 *
 * 数据库不可用时的行为：
 *   启动时连不上（或查询超时）-> 接口快速返回 503，前端 Store 自动退化为浏览器
 *   localStorage 兜底，页面依然可用（离线模式）。绝不挂起请求。
 *
 * 账号与数据隔离（参考 enStudy 实现）：
 *   - 密码用 crypto.scryptSync 加盐哈希存成 "salt:hash"，绝不存明文
 *   - 登录态是随机 sid 存在 HttpOnly + SameSite=Lax 的 Cookie 里，服务端 sessions 表可查可撤
 *   - 除 /api/auth/register|login|me 外，所有接口都要求已登录
 *   - 错题按 errors.user_id 归属：列表只返回自己的，改/删按 id + user_id 双条件，越权一律 404
 *   - 设置按 kv key 命名空间隔离：客户端传 settings，服务端存成 settings.<userId>
 *
 * 接口：
 *   POST   /api/auth/register           注册并自动登录
 *   POST   /api/auth/login              登录
 *   POST   /api/auth/logout             登出（删会话 + 清 Cookie）
 *   GET    /api/auth/me                 当前登录用户（401 = 未登录）
 *   POST   /api/auth/change-password    修改自己的密码（需原密码）
 *   GET    /api/auth/users              管理员：用户列表
 *   POST   /api/auth/reset-password     管理员：重置他人密码
 *   GET    /api/errors?subject=&grade=&mastered=  错题列表（只含自己的；科目/年级/已会状态可选筛选）
 *   POST   /api/errors                  新增错题（body: subject, grade, image=dataURL, note）
 *   GET    /api/errors/:id              单条详情（非本人返回 404）
 *   PATCH  /api/errors/:id              更新（主要用于保存 AI 分析结果）
 *   DELETE /api/errors/:id              删除（同时删除图片文件）
 *   GET    /api/kv/:key                 读取自己的设置
 *   PUT    /api/kv/:key                 写入自己的设置
 *   POST   /api/ai/chat                 代理转发 OpenAI 兼容接口（需登录，避免沦为开放代理）
 *   其它                                静态文件（项目根目录）
 *
 * 用法：node server.js   （默认 http://127.0.0.1:8322）
 * 首次使用请先执行：node db_setup.js   （创建 wrongbook 库与表）
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');

const PORT = process.env.PORT || 8322;
const HOST = process.env.HOST || '0.0.0.0';

/* ---------------- 数据库配置 ---------------- */
const DB = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postuser',
  password: process.env.PGPASSWORD || 'postuser',
  database: process.env.PGDATABASE || 'wrongbook',
  max: 5,                        // 家庭/单机使用，连接池给 5 足够
  connectionTimeoutMillis: 3000, // 连不上时 3s 内失败，而非永久挂起
  idleTimeoutMillis: 30000,
};

// 给每个数据库调用套一层硬超时，保证任何请求都必然在有限时间内返回
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error((label || 'db') + ' timeout')); }, ms);
  });
  return Promise.race([promise, guard]).finally(function () { clearTimeout(timer); });
}

// 常量：科目与年级（前端也维护一份用于渲染，这里做服务端校验）
const SUBJECTS = { math: '数学', physics: '物理' };
const GRADES = { '7': '七年级', '8': '八年级', '9': '九年级' };

// 允许转发的大模型服务商（防止把本服务当成任意网站的代理）
// 与前端「服务商下拉」一一对应，新增服务商需同时改这里和 js/views.js 的 PROVIDERS
const ALLOWED_HOST_SUFFIXES = [
  'dashscope.aliyuncs.com', '.maas.aliyuncs.com',
  'api.siliconflow.cn', 'api.openai.com',
  'open.bigmodel.cn', '.bigmodel.cn',
  'api.deepseek.com', 'api.moonshot.cn',
  'generativelanguage.googleapis.com',
  'developer.amd.com.cn',   // AMD Radeon Cloud
  '120.25.204.182',         // 自建 LiteLLM 代理（http，内网/公网 IP）
];
function hostAllowed(h) {
  h = String(h || '').split(':')[0];  // 去掉端口，避免 host=ip:port 时精确匹配失败
  return ALLOWED_HOST_SUFFIXES.some(s => h === s || h.endsWith(s));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------- 通用工具 ---------------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limitBytes = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let aborted = false;
    req.on('data', d => {
      body += d;
      if (body.length > limitBytes) {
        aborted = true;
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('error', reject);
    req.on('end', () => { if (!aborted) resolve(body); });
  });
}

async function ensureDirs() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
}

/* 把 data:image/...;base64 落盘，返回 { name, url }。
 * 不合法 / 过大时抛错，err.status 带上该返回的 HTTP 状态码（错题图与解答图共用）。 */
async function saveDataImage(img, maxBytes) {
  const m = String(img || '').trim().match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) { const e = new Error('缺少图片（期望 data:image/*;base64,...）'); e.status = 400; throw e; }
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) {
    const e = new Error('图片过大（上限 ' + Math.round(maxBytes / 1048576) + 'MB）');
    e.status = 413; throw e;
  }
  const name = crypto.randomUUID() + '.' + ext;
  await fsp.writeFile(path.join(UPLOAD_DIR, name), buf);
  return { name, url: '/uploads/' + name };
}

/* 删除 uploads 下的图片文件（只取 basename，防路径穿越；失败不影响接口返回） */
/* 删除 uploads/ 下的图片文件。
 * 这里刻意「等删除完成」再回响应：不然客户端拿到 200 时文件其实还在，
 * 出现「刚删掉、刷新又看见」的错觉（也会让自动化测试偶发失败）。
 * 文件本来就不在（ENOENT）等情况不报错，返回 false。 */
async function unlinkUpload(imgUrl) {
  if (!imgUrl) return false;
  try {
    await fsp.unlink(path.join(UPLOAD_DIR, path.basename(imgUrl)));
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- 数据库连接 ---------------- */
let pool = null;      // PG 连接池；连不上时为 null
let dbReady = false;  // PG 是否可用；不可用时数据类接口快速返回，前端走本地兜底

async function initSchema(client) {
  // 启动时自愈：库存在但表缺失时自动补建（正常情况由 db_setup.js 建好）
  await client.query(`
    /* 账号与会话（与 enStudy 同构，密码哈希可直接复用） */
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
    UPDATE users SET role='admin' WHERE username='admin';

    /* 错题：user_id 关联到 users，实现按用户隔离 */
    CREATE TABLE IF NOT EXISTS errors (
      id          TEXT PRIMARY KEY,
      subject     TEXT NOT NULL,
      grade       TEXT NOT NULL,
      image       TEXT NOT NULL,
      note        TEXT NOT NULL DEFAULT '',
      analysis    JSONB,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL,
      user_id     INT REFERENCES users(id) ON DELETE CASCADE
    );
    ALTER TABLE errors ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE;
    /* 是否已会：错题本可按「已会 / 还需要复习」筛选，详情页改 */
    ALTER TABLE errors ADD COLUMN IF NOT EXISTS mastered BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_errors_created       ON errors (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_errors_subject_grade ON errors (subject, grade);
    CREATE INDEX IF NOT EXISTS idx_errors_user_created  ON errors (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_errors_user_mastered ON errors (user_id, mastered, created_at DESC);

    /* 他人正确解答：一条错题可以有多张（同学/老师写的正确解法照片）。
     * 单独一张表存，与 errors 一对多；删错题时由外键级联清掉，不会留下孤儿行。 */
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
    CREATE INDEX IF NOT EXISTS idx_solutions_error  ON solutions (error_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_solutions_user   ON solutions (user_id, created_at DESC);

    /* 设置：key 采用 settings.<userId> 命名空间即可按用户隔离，表结构无需改动 */
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// 数据库行 -> 前端期望的对象（snake_case -> camelCase）
function rowToItem(r) {
  return {
    id: r.id,
    subject: r.subject,
    grade: r.grade,
    image: r.image,
    note: r.note,
    analysis: r.analysis,     // JSONB 已被 pg 自动解析为对象
    mastered: !!r.mastered,   // 是否已会（false = 还需要复习）
    solutionCount: Number(r.solution_count || 0),   // 他人正确解答张数（列表页用它显示小标记）
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

// 他人解答行 -> 前端对象
function rowToSolution(r) {
  return {
    id: r.id,
    errorId: r.error_id,
    image: r.image,
    note: r.note || '',
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

async function initDB() {
  pool = new Pool(DB);
  try {
    const client = await withTimeout(pool.connect(), 3000, 'pg-connect');
    try {
      await initSchema(client);
      dbReady = true;
      const c = await client.query('SELECT count(*)::int AS n FROM errors');
      const u = await client.query('SELECT count(*)::int AS n FROM users');
      console.log('✅ 已连接 PostgreSQL (' + DB.user + '@' + DB.host + ':' + DB.port + ' / db: ' + DB.database +
        ')，当前用户 ' + u.rows[0].n + ' 个 / 错题 ' + c.rows[0].n + ' 条');
      if (!u.rows[0].n) {
        console.log('   提示：还没有任何账号。可执行 node migrate_users_from_enstudy.js 从 enStudy 搬账号，');
        console.log('         或直接在登录页点「注册」创建新账号。');
      }
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('⚠️  无法连接 PostgreSQL（将只使用浏览器本地存储，无法持久化）：', e.message);
    try { await pool.end(); } catch (_) { }
    pool = null;
    dbReady = false;
  }
}

/* ---------------- 账号与会话（实现参考 enStudy，逻辑保持一致） ---------------- */
// 用户名规则：3-31 位，必须以英文字母开头，仅含字母/数字/下划线
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,30}$/;
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + derived;
}
function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const parts = stored.split(':');
  const salt = parts[0], expected = parts[1];
  if (!salt || !expected) return false;
  const got = crypto.scryptSync(password, salt, 64);
  const exp = Buffer.from(expected, 'hex');
  if (got.length !== exp.length) return false;
  return crypto.timingSafeEqual(got, exp);
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach(function (c) {
    const i = c.indexOf('=');
    if (i >= 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, days) {
  const exp = new Date(Date.now() + (days || SESSION_DAYS) * 864e5).toUTCString();
  res.setHeader('Set-Cookie', name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Expires=' + exp);
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', name + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
// 从 Cookie 里的 sid 反查当前用户；未登录 / 会话失效一律返回 null
async function getCurrentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid || !pool) return null;
  try {
    const r = await withTimeout(pool.query(
      'SELECT u.id, u.username, u.created_at, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = $1',
      [sid]
    ), 3000, 'auth-me');
    return r.rows[0] || null;
  } catch (e) { return null; }
}
function publicUser(u) {
  return { userId: u.id, username: u.username, createdAt: u.created_at, role: u.role };
}
// 统一的登录校验：通过返回用户对象，否则已写好 401 响应
async function requireUser(req, res) {
  if (!dbReady) { sendJSON(res, 503, { ok: false, error: '数据库不可用，无法校验登录状态' }); return null; }
  const u = await getCurrentUser(req);
  if (!u) { sendJSON(res, 401, { ok: false, error: '未登录或登录已过期，请重新登录' }); return null; }
  return u;
}
// 建会话并写 Cookie
async function startSession(res, userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  await withTimeout(pool.query('INSERT INTO sessions (sid, user_id) VALUES ($1, $2)', [sid, userId]), 3000, 'auth-session');
  setCookie(res, 'sid', sid, SESSION_DAYS);
}

async function handleAuthRegister(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username)) return sendJSON(res, 400, { ok: false, error: '用户名 3-31 位，必须以英文字母开头，仅含字母/数字/下划线' });
  if (password.length < 4 || password.length > 64) return sendJSON(res, 400, { ok: false, error: '密码 4-64 位' });
  if (!dbReady) return sendJSON(res, 503, { ok: false, error: '数据库不可用' });
  try {
    const existed = await withTimeout(pool.query('SELECT id FROM users WHERE username=$1', [username]), 3000, 'auth-check');
    if (existed.rows.length) return sendJSON(res, 409, { ok: false, error: '用户名已被占用' });
    const ins = await withTimeout(pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at, role',
      [username, hashPassword(password)]
    ), 3000, 'auth-insert');
    await startSession(res, ins.rows[0].id);
    return sendJSON(res, 200, Object.assign({ ok: true }, publicUser(ins.rows[0])));
  } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
}

async function handleAuthLogin(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return sendJSON(res, 400, { ok: false, error: '请输入用户名和密码' });
  if (!dbReady) return sendJSON(res, 503, { ok: false, error: '数据库不可用' });
  try {
    const r = await withTimeout(pool.query('SELECT id, username, password_hash, role FROM users WHERE username=$1', [username]), 3000, 'auth-login');
    if (!r.rows.length) return sendJSON(res, 401, { ok: false, error: '用户名或密码错误' });
    const u = r.rows[0];
    // 用户名不存在与密码错误返回同一句话，避免被用来枚举账号
    if (!verifyPassword(password, u.password_hash)) return sendJSON(res, 401, { ok: false, error: '用户名或密码错误' });
    await startSession(res, u.id);
    return sendJSON(res, 200, Object.assign({ ok: true }, publicUser(u)));
  } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
}

async function handleAuthLogout(req, res) {
  const sid = parseCookies(req).sid;
  if (sid && dbReady) {
    try { await withTimeout(pool.query('DELETE FROM sessions WHERE sid=$1', [sid]), 3000, 'auth-logout'); } catch (e) { }
  }
  clearCookie(res, 'sid');
  return sendJSON(res, 200, { ok: true });
}

async function handleAuthMe(req, res) {
  const u = await getCurrentUser(req);
  if (!u) return sendJSON(res, 401, { ok: false, error: 'not authenticated' });
  return sendJSON(res, 200, Object.assign({ ok: true }, publicUser(u)));
}

async function handleAuthChangePassword(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  const u = await requireUser(req, res);
  if (!u) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (!oldPassword) return sendJSON(res, 400, { ok: false, error: '请输入当前密码' });
  if (newPassword.length < 4 || newPassword.length > 64) return sendJSON(res, 400, { ok: false, error: '新密码需 4-64 位' });
  try {
    const r = await withTimeout(pool.query('SELECT password_hash FROM users WHERE id=$1', [u.id]), 3000, 'auth-cp');
    if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: '用户不存在' });
    if (!verifyPassword(oldPassword, r.rows[0].password_hash)) return sendJSON(res, 401, { ok: false, error: '当前密码错误' });
    await withTimeout(pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(newPassword), u.id]), 3000, 'auth-cp-up');
    return sendJSON(res, 200, { ok: true });
  } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
}

// 管理员：用户列表（供「重置密码」下拉使用）
async function handleAuthUsers(req, res) {
  const u = await requireUser(req, res);
  if (!u) return;
  if (u.role !== 'admin') return sendJSON(res, 403, { ok: false, error: '需要管理员权限' });
  try {
    const r = await withTimeout(pool.query('SELECT id, username, role FROM users ORDER BY id'), 3000, 'auth-users');
    return sendJSON(res, 200, { ok: true, users: r.rows });
  } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
}

// 管理员：重置他人密码（无需原密码）
async function handleAuthResetPassword(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  const u = await requireUser(req, res);
  if (!u) return;
  if (u.role !== 'admin') return sendJSON(res, 403, { ok: false, error: '需要管理员权限' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
  const targetUserId = Number(body.targetUserId);
  const newPassword = String(body.newPassword || '');
  if (!targetUserId || isNaN(targetUserId)) return sendJSON(res, 400, { ok: false, error: '请选择要重置的用户' });
  if (newPassword.length < 4 || newPassword.length > 64) return sendJSON(res, 400, { ok: false, error: '新密码需 4-64 位' });
  try {
    const t = await withTimeout(pool.query('SELECT id FROM users WHERE id=$1', [targetUserId]), 3000, 'auth-rp');
    if (!t.rows.length) return sendJSON(res, 404, { ok: false, error: '目标用户不存在' });
    await withTimeout(pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(newPassword), targetUserId]), 3000, 'auth-rp-up');
    return sendJSON(res, 200, { ok: true });
  } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
}

/* ---------------- 错题接口（全部按登录用户隔离） ---------------- */
async function handleListErrors(req, res, u, me) {
  const subject = u.searchParams.get('subject') || '';
  const grade = u.searchParams.get('grade') || '';
  const mastered = u.searchParams.get('mastered');   // '' = 全部 / '1' = 已会 / '0' = 还需要复习
  try {
    // 第一条件恒为 user_id，确保只能看到自己的错题；其余条件按需追加（值全部参数绑定，避免注入）
    const where = ['e.user_id = $1'];
    const params = [me.id];
    if (subject) { params.push(subject); where.push('e.subject = $' + params.length); }
    if (grade) { params.push(String(grade)); where.push('e.grade = $' + params.length); }
    if (mastered === '1' || mastered === '0') {
      params.push(mastered === '1');
      where.push('e.mastered = $' + params.length);
    }
    // 顺带带上「他人解答」张数：错题本网格上能直接看到哪些题有别人的正确解法
    const sql = 'SELECT e.*, COALESCE(s.n, 0) AS solution_count FROM errors e ' +
      'LEFT JOIN (SELECT error_id, count(*) AS n FROM solutions GROUP BY error_id) s ON s.error_id = e.id ' +
      'WHERE ' + where.join(' AND ') + ' ORDER BY e.created_at DESC';
    const r = await withTimeout(pool.query(sql, params), 5000, 'errors-list');
    sendJSON(res, 200, { ok: true, items: r.rows.map(rowToItem) });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: '查询失败：' + e.message });
  }
}

async function handleCreateError(req, res, me) {
  if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: 'invalid json: ' + e.message });
  }
  const subject = String(body.subject || '');
  const grade = String(body.grade || '');
  if (!SUBJECTS[subject]) return sendJSON(res, 400, { ok: false, error: '科目不合法（仅支持 math/physics）' });
  if (!GRADES[grade]) return sendJSON(res, 400, { ok: false, error: '年级不合法（仅支持 7/8/9）' });

  // 图片落盘（先拿到路径再写库：避免库里有记录但图片不存在）
  let saved;
  try {
    saved = await saveDataImage(body.image, 12 * 1024 * 1024);
  } catch (e) {
    return sendJSON(res, e.status || 500, { ok: false, error: e.status === 500 ? ('图片保存失败：' + e.message) : e.message });
  }
  const name = saved.name;

  const item = {
    id: crypto.randomUUID(),
    subject,
    grade,
    image: saved.url,
    note: String(body.note || '').slice(0, 500),
    analysis: null,          // AI 分析结果：{ question, answer, steps, knowledge, tip, raw }
    mastered: false,         // 新录入默认「还需要复习」
    solutionCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  try {
    await withTimeout(pool.query(
      'INSERT INTO errors (id, subject, grade, image, note, analysis, created_at, updated_at, user_id) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [item.id, item.subject, item.grade, item.image, item.note, item.analysis, item.createdAt, item.updatedAt, me.id]
    ), 5000, 'errors-insert');
    sendJSON(res, 200, { ok: true, item });
  } catch (e) {
    // 入库失败则删掉刚写的图片，避免产生孤儿文件
    await fsp.unlink(path.join(UPLOAD_DIR, name)).catch(() => { });
    sendJSON(res, 500, { ok: false, error: '保存失败：' + e.message });
  }
}

async function handleGetError(req, res, id, me) {
  try {
    const r = await withTimeout(pool.query('SELECT * FROM errors WHERE id=$1 AND user_id=$2', [id, me.id]), 5000, 'errors-get');
    if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: 'not found' });
    sendJSON(res, 200, { ok: true, item: rowToItem(r.rows[0]) });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: '查询失败：' + e.message });
  }
}

async function handleUpdateError(req, res, id, me) {
  if (req.method !== 'PATCH' && req.method !== 'PUT') {
    return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  }
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) {
    return sendJSON(res, 400, { ok: false, error: 'invalid json' });
  }

  // 只允许更新这几个字段，避免被塞入任意内容
  const sets = [];
  const params = [];
  if (body.note !== undefined) { params.push(String(body.note).slice(0, 500)); sets.push('note = $' + params.length); }
  if (body.analysis !== undefined) { params.push(JSON.stringify(body.analysis)); sets.push('analysis = $' + params.length + '::jsonb'); }
  if (body.subject !== undefined && SUBJECTS[body.subject]) { params.push(body.subject); sets.push('subject = $' + params.length); }
  if (body.grade !== undefined && GRADES[String(body.grade)]) { params.push(String(body.grade)); sets.push('grade = $' + params.length); }
  if (body.mastered !== undefined) { params.push(!!body.mastered); sets.push('mastered = $' + params.length); }
  if (!sets.length) return sendJSON(res, 400, { ok: false, error: '没有可更新的字段' });

  params.push(Date.now()); sets.push('updated_at = $' + params.length);
  params.push(id); const pId = params.length;
  params.push(me.id); const pMe = params.length;

  try {
    // id + user_id 双条件：改别人的错题会命中 0 行，返回 404 而不是泄漏存在性
    const r = await withTimeout(pool.query(
      'UPDATE errors SET ' + sets.join(', ') + ' WHERE id = $' + pId + ' AND user_id = $' + pMe + ' RETURNING *',
      params
    ), 5000, 'errors-update');
    if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: 'not found' });
    sendJSON(res, 200, { ok: true, item: rowToItem(r.rows[0]) });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: '更新失败：' + e.message });
  }
}

async function handleDeleteError(req, res, id, me) {
  if (req.method !== 'DELETE') return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  try {
    // 先把「他人解答」的图片路径取出来：外键级联删行后路径就查不到了，文件会变成孤儿
    const sols = await withTimeout(
      pool.query('SELECT image FROM solutions WHERE error_id=$1 AND user_id=$2', [id, me.id]),
      5000, 'solutions-of-error'
    );
    const r = await withTimeout(pool.query('DELETE FROM errors WHERE id=$1 AND user_id=$2 RETURNING image', [id, me.id]), 5000, 'errors-delete');
    if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: 'not found' });
    // 删除对应图片文件（失败不影响接口返回，但要等删完再回）
    await Promise.all([unlinkUpload(r.rows[0].image)].concat(sols.rows.map(function (s) { return unlinkUpload(s.image); })));
    sendJSON(res, 200, { ok: true, deletedSolutions: sols.rows.length });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: '删除失败：' + e.message });
  }
}

/* ---------------- 他人正确解答（一条错题 N 张，按登录用户隔离） ---------------- */
/* 我校验「这条错题是不是你的」，只有本人才能往下面挂解答 / 看解答。
 * 判定逻辑与错题一致：查不到一律 404，不泄漏「存在但不属于你」。 */
async function ownError(id, me) {
  const r = await withTimeout(pool.query('SELECT id FROM errors WHERE id=$1 AND user_id=$2', [id, me.id]), 5000, 'errors-own');
  return r.rows.length > 0;
}

async function handleListSolutions(req, res, id, me) {
  try {
    if (!await ownError(id, me)) return sendJSON(res, 404, { ok: false, error: 'not found' });
    const r = await withTimeout(pool.query(
      'SELECT * FROM solutions WHERE error_id=$1 AND user_id=$2 ORDER BY created_at ASC', [id, me.id]
    ), 5000, 'solutions-list');
    sendJSON(res, 200, { ok: true, items: r.rows.map(rowToSolution) });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: '查询失败：' + e.message });
  }
}

async function handleCreateSolution(req, res, id, me) {
  if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) {
    return sendJSON(res, 400, { ok: false, error: 'invalid json' });
  }
  try {
    if (!await ownError(id, me)) return sendJSON(res, 404, { ok: false, error: 'not found' });

    // 上限保护：单条错题的解答照片最多 20 张，避免被当成相册用
    const cnt = await withTimeout(pool.query('SELECT count(*)::int AS n FROM solutions WHERE error_id=$1', [id]), 5000, 'solutions-count');
    if (cnt.rows[0].n >= 20) return sendJSON(res, 400, { ok: false, error: '这道题的他人解答最多 20 张' });

    let saved;
    try {
      saved = await saveDataImage(body.image, 12 * 1024 * 1024);
    } catch (e) {
      return sendJSON(res, e.status || 500, { ok: false, error: e.status === 500 ? ('图片保存失败：' + e.message) : e.message });
    }

    const item = {
      id: crypto.randomUUID(),
      errorId: id,
      image: saved.url,
      note: String(body.note || '').slice(0, 200),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      await withTimeout(pool.query(
        'INSERT INTO solutions (id, error_id, user_id, image, note, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [item.id, item.errorId, me.id, item.image, item.note, item.createdAt, item.updatedAt]
      ), 5000, 'solutions-insert');
    } catch (e) {
      await unlinkUpload(item.image);   // 入库失败就删掉刚写的文件，别留孤儿
      throw e;
    }
    sendJSON(res, 200, { ok: true, item });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: '保存失败：' + e.message });
  }
}

async function handleUpdateSolution(req, res, sid, me) {
  if (req.method !== 'PATCH' && req.method !== 'PUT') return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) {
    return sendJSON(res, 400, { ok: false, error: 'invalid json' });
  }
  if (body.note === undefined) return sendJSON(res, 400, { ok: false, error: '没有可更新的字段' });
  try {
    const r = await withTimeout(pool.query(
      'UPDATE solutions SET note=$1, updated_at=$2 WHERE id=$3 AND user_id=$4 RETURNING *',
      [String(body.note).slice(0, 200), Date.now(), sid, me.id]
    ), 5000, 'solutions-update');
    if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: 'not found' });
    sendJSON(res, 200, { ok: true, item: rowToSolution(r.rows[0]) });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: '更新失败：' + e.message });
  }
}

async function handleDeleteSolution(req, res, sid, me) {
  if (req.method !== 'DELETE') return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  try {
    const r = await withTimeout(pool.query(
      'DELETE FROM solutions WHERE id=$1 AND user_id=$2 RETURNING image', [sid, me.id]
    ), 5000, 'solutions-delete');
    if (!r.rows.length) return sendJSON(res, 404, { ok: false, error: 'not found' });
    unlinkUpload(r.rows[0].image);
    sendJSON(res, 200, { ok: true });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: '删除失败：' + e.message });
  }
}

/* ---------------- 设置 KV（key 按用户加命名空间，实现设置隔离） ---------------- */
function scopedKey(key, userId) { return key + '.' + userId; }

async function handleKV(req, res, key, me) {
  const k = scopedKey(key, me.id);
  try {
    if (req.method === 'GET') {
      const r = await withTimeout(pool.query('SELECT value FROM kv WHERE key=$1', [k]), 5000, 'kv-get');
      return sendJSON(res, 200, { ok: true, value: r.rows.length ? r.rows[0].value : null });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      let val;
      try { val = JSON.parse(await readBody(req)); } catch (e) {
        return sendJSON(res, 400, { ok: false, error: 'invalid json' });
      }
      await withTimeout(pool.query(
        'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        [k, val]
      ), 5000, 'kv-put');
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      await withTimeout(pool.query('DELETE FROM kv WHERE key=$1', [k]), 5000, 'kv-del');
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: '设置读写失败：' + e.message });
  }
}

/* ---------------- AI 代理（OpenAI 兼容 /chat/completions） ----------------
 * 视觉大模型分析错题时，前端会把图片以 data:image/*;base64 放进 messages，
 * 这里原样转发给上游，因此支持任意 OpenAI 兼容的多模态模型。
 */
async function handleAiChat(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) {
    return sendJSON(res, 400, { ok: false, error: 'invalid json' });
  }
  const apiBase = String(body.apiBase || '').trim();
  const apiKey = String(body.apiKey || '').trim();
  const messages = body.messages;
  if (!apiBase || !apiKey || !Array.isArray(messages)) {
    return sendJSON(res, 400, { ok: false, error: '缺少 apiBase / apiKey / messages' });
  }
  let ub;
  try { ub = new URL(apiBase); } catch (e) {
    return sendJSON(res, 400, { ok: false, error: 'apiBase 不是合法 URL' });
  }
  // 默认要求 https；但白名单中明确列出的服务商（如自建 LiteLLM 代理用 http）例外放行，
  // 仍受 hostAllowed 约束，不会沦为开放代理（SSRF 防护）
  if (ub.protocol !== 'https:' && !hostAllowed(ub.host)) {
    return sendJSON(res, 400, { ok: false, error: '仅支持 https 端点' });
  }
  if (!hostAllowed(ub.host)) {
    return sendJSON(res, 403, { ok: false, error: '该 apiBase 不在允许的服务商列表内：' + ub.host });
  }

  const payload = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens || 2048,
    temperature: body.temperature != null ? body.temperature : 0.2,
  };
  // 推理模型（qwen3.x-max/plus 等）默认会先"想"几十秒才回答，读图时很容易顶穿超时。
  // 前端传 enable_thinking:false 即关闭思考，实测响应从 40s+ 降到 2s 以内，读图能力不受影响。
  if (body.enable_thinking === false) payload.enable_thinking = false;

  const target = ub.origin + ub.pathname.replace(/\/+$/, '') + '/chat/completions';
  const UPSTREAM_TIMEOUT = 240000;   // 留着「开着思考」的口子，给足时间
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return sendJSON(res, 504, { ok: false, error: '上游响应超时（240 秒）。该模型可能在长时间思考，可在设置里关闭「深度思考」后重试' });
    }
    return sendJSON(res, 502, { ok: false, error: '代理转发失败：' + e.message });
  }
}

/* ---------------- 静态文件 ---------------- */
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  // 防目录穿越
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      const idx = path.join(ROOT, 'index.html');
      return fs.readFile(idx, (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(d2);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    // 图片可缓存，其它一律 no-store
    const cache = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? 'public, max-age=3600' : 'no-store';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------- 启动 ---------------- */
async function main() {
  await ensureDirs();
  await initDB();

  const server = http.createServer(async (req, res) => {
    const urlRaw = req.url.split('?')[0];
    const u = new URL(req.url, 'http://localhost');
    try {
      /* --- 账号接口：login / register / me 未登录也可访问（各自内部再校验权限） --- */
      if (urlRaw === '/api/auth/register') return await handleAuthRegister(req, res);
      if (urlRaw === '/api/auth/login') return await handleAuthLogin(req, res);
      if (urlRaw === '/api/auth/logout') return await handleAuthLogout(req, res);
      if (urlRaw === '/api/auth/me') return await handleAuthMe(req, res);
      if (urlRaw === '/api/auth/change-password') return await handleAuthChangePassword(req, res);
      if (urlRaw === '/api/auth/users') return await handleAuthUsers(req, res);
      if (urlRaw === '/api/auth/reset-password') return await handleAuthResetPassword(req, res);

      /* --- 其余接口一律要求登录：未登录直接 401，不泄漏任何数据 --- */
      if (urlRaw.startsWith('/api/')) {
        const me = await requireUser(req, res);
        if (!me) return;   // requireUser 已写好 401 / 503 响应

        if (urlRaw === '/api/errors' && req.method === 'GET') return await handleListErrors(req, res, u, me);
        if (urlRaw === '/api/errors' && req.method === 'POST') return await handleCreateError(req, res, me);
        if (urlRaw === '/api/ai/chat') return await handleAiChat(req, res);

        const mSol = urlRaw.match(/^\/api\/errors\/([A-Za-z0-9-]+)\/solutions$/);
        if (mSol) {
          if (req.method === 'GET') return await handleListSolutions(req, res, mSol[1], me);
          if (req.method === 'POST') return await handleCreateSolution(req, res, mSol[1], me);
          return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
        }
        const mErr = urlRaw.match(/^\/api\/errors\/([A-Za-z0-9-]+)$/);
        if (mErr) {
          const id = mErr[1];
          if (req.method === 'GET') return await handleGetError(req, res, id, me);
          if (req.method === 'DELETE') return await handleDeleteError(req, res, id, me);
          if (req.method === 'PATCH' || req.method === 'PUT') return await handleUpdateError(req, res, id, me);
        }
        const mOneSol = urlRaw.match(/^\/api\/solutions\/([A-Za-z0-9-]+)$/);
        if (mOneSol) {
          const sid = mOneSol[1];
          if (req.method === 'DELETE') return await handleDeleteSolution(req, res, sid, me);
          if (req.method === 'PATCH' || req.method === 'PUT') return await handleUpdateSolution(req, res, sid, me);
          return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
        }
        const mKV = urlRaw.match(/^\/api\/kv\/(.+)$/);
        if (mKV) return await handleKV(req, res, decodeURIComponent(mKV[1]), me);

        return sendJSON(res, 404, { ok: false, error: '未知接口：' + urlRaw });
      }

      return serveStatic(req, res);
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: '服务器内部错误：' + e.message });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log('🚀 错题本已启动: http://127.0.0.1:' + PORT);
    const os = require('os');
    const nets = os.networkInterfaces();
    let lan = '';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) { lan = net.address; break; }
      }
      if (lan) break;
    }
    if (lan) console.log('   手机访问（同一 WiFi）: http://' + lan + ':' + PORT);
    console.log('   图片目录: ' + UPLOAD_DIR);
    console.log('   数据存储: PostgreSQL ' + DB.host + ':' + DB.port + '/' + DB.database +
      (dbReady ? '（已连接）' : '（未连接，仅浏览器本地存储）'));
  });
}

main();
