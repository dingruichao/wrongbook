# 错题本 H5（数学 · 物理）

初中错题本，手机浏览器直接用。拍照上传错题 → 按科目年级归类 → 点开让大模型讲解。

## 特点

- **轻量**：只用 Node 内置模块 + `pg` 驱动，无需框架
- **手机可用**：服务绑定 `0.0.0.0`，同一 WiFi 下手机直接访问电脑 IP
- **多用户隔离**：注册登录（密码 scrypt 加盐哈希 + HttpOnly Cookie 会话），每个账号只看到自己的错题，连大模型 Key 也是各存各的
- **框选单题**：拍整页卷子后拖取景框只框住一道题，AI 不被同页其它题带偏
- **他人正确解答**：详情页可拍下同学/老师的正确解法挂在同一道题下（可多张），和自己的作答对照
- **数据持久化**：错题元数据存 PostgreSQL 独立库 `wrongbook`，图片存 `uploads/` 目录
- **离线兜底**：数据库连不上时接口快速返回 503，前端自动退化为浏览器本地存储，页面仍可用

## 快速开始

### 1. 初始化数据库（首次使用）

需要一台可访问的 PostgreSQL（默认 `postuser/postuser@localhost:5432`）：

```bash
node db_setup.js    # 创建 wrongbook 库 + users / sessions / errors / kv 表 + 读写自检
```

可用环境变量覆盖连接：`PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE`。

从 enStudy 搬账号（可选，一次性）：

```bash
node migrate_users_from_enstudy.js --dry           # 先预演，看会拿到哪些账号
node migrate_users_from_enstudy.js                 # 正式迁移（含历史错题归属）
node migrate_users_from_enstudy.js --only=ding,admin   # 只搬指定账号
```

> 密码哈希格式与 enStudy 完全一致（都是 `salt:hash` 的 scrypt），所以**搬过来后原密码照样能登录**，
> 不用重置。忘了密码可用 `node reset_password.js <用户名> <新口令>` 重置。

从旧版 JSON 存储迁移（可选，一次性）：

```bash
node migrate_json_to_pg.js        # 把 data/errors.json、data/kv.json 导入 PG
```

从 enStudy 搬大模型服务商配置（可选，一次性）：

```bash
node migrate_providers.js --dry   # 先预演，看会拿到哪些服务商
node migrate_providers.js         # 正式写入（保留错题本自己的默认科目/年级）
```

### 2. 启动服务

```bash
./start.sh          # 启动（默认 http://127.0.0.1:8322）
./stop.sh           # 停止
./restart.sh        # 重启
```

启动后会打印局域网地址，手机浏览器打开即可（与电脑同一 WiFi）。

## 账号与多用户隔离

启动后先看到登录页（未登录时底部 tab 是隐藏的），右上角胶囊显示当前账号，点开可改密码 / 退出登录。

实现照参照项目 enStudy：密码用 `crypto.scryptSync` 加盐哈希存成 `salt:hash`（**不存明文**），
登录态是随机 `sid` 存在 **HttpOnly + SameSite=Lax** 的 Cookie 里（前端脚本读不到），
服务端 `sessions` 表可查可撤，有效期 30 天。

隔离规则：

| 对象 | 隔离方式 |
|---|---|
| 错题 | `errors.user_id` 归属。列表只查 `user_id = 当前用户`；改 / 删按 `id + user_id` 双条件，**动别人的题会返回 404**（不泄漏"这条存在"） |
| 设置 | kv 的 key 服务端自动加命名空间：客户端传 `settings`，实际存成 `settings.<userId>` |
| AI 代理 | 必须登录才能调，避免服务变成任人可用的开放代理 |
| 本地兜底缓存 | `localStorage` 也按用户分目录（`wrongbook.v1.errors.<userId>`），换账号不会看到上个账号的残留 |

其他：

- 用户名规则：3-31 位，英文字母开头，仅含字母 / 数字 / 下划线
- 口令 4-64 位；「用户名不存在」和「密码错误」返回同一句提示，防止被用来枚举账号
- `admin` 账号是管理员，右上角菜单里多一项「重置他人密码」（无需知道对方原密码）
- 会话过期时前端会自动退回登录页并提示，不会出现"点什么都没反应"
- 忘了口令：`node reset_password.js <用户名> <新口令>`（列出全部账号直接跑 `node reset_password.js`）

> ⚠️ 图片仍是静态文件托管（`/uploads/xxx.jpg`），未做登录校验——文件名是 128 位随机 uuid，
> 不知道 URL 就访问不到；但如果需要严格隔离，可以再给图片加一层鉴权路由。

## 页面

| Tab | 功能 |
|-----|------|
| 录入 | 拍/选一张卷子 → **框选单道题** → 选科目年级 → 保存（可连框多题一起存） |
| 错题本 | 按科目、年级、**掌握情况（全部 / 还需要复习 / 已会）**筛选，网格浏览，点开看详情 |
| 掌握标记 | 详情页删除按钮下一行可一键「标记为已会」（可取消）；已会的卡片淡化 + 右上角 `✓ 已会` |
| 统计 | 错题分布，以及大模型接口配置 |

### 拍照框选（像小猿搜题那样）

「录入」页点 **📷 拍照**（手机直接开相机）或 **🖼 相册**，拿到照片后会进入全屏框选编辑器：

- 默认取景框落在图片中间偏上的一条横带上，**拖框内移动、拖 8 个白色手柄改大小**
- **双指捏合缩放图片**、拖框外平移图片，桌面端滚轮也能缩放；配 3×3 网格辅助对齐
- **旋转**（90° 一档，照片拍倒了用它）、**整页**（不框了，直接用整张）、**重置**、**重拍**
- 点「完成」保存的**就是取景框里看到的那块**（所见即所得，旋转也一样生效）

三个好处：单题区域按原图分辨率导出（上限 1600px），不再被整页缩到 1280 而糊掉；
AI 不会被同页其它题干扰；一张卷子可以**连续框多道题**排队后一起保存
（「＋ 继续框这张卷子上的下一道题」），预览里每张都能单独删掉。

> 为什么不做"相机画面上的实时取景框"：手机浏览器给系统相机叠框必须用 `getUserMedia` 自己画预览，
> 而它只在 **https / localhost** 下可用 —— 手机经局域网 `http://192.168.x.x:8322` 访问时会被浏览器禁用摄像头。
> 所以这里做等价的"先拍照、再框选"。真想要实时取景，给服务配个 HTTPS 证书即可。

点开任意错题 → **AI 分析** → 默认 3-15 秒出结果（详见下方「深度思考开关」）→ 模型按四步处理图片：

1. **锁定题目** · 2. **识题** · 3. **讲思路**（条件→目标→方法→步骤）· 4. **判错因 + 给巩固题**

返回结果分两块：

| 讲题 | 复盘 |
|---|---|
| 题目、学生原答案、正确答案、解题步骤、知识点、易错点 | 错因分类 + 依据、一句话订正、同类变式题、复习安排（几天后重做） |

提示词融合了两个教育 skill 的方法论：`photo-question-tutor`（拍照答疑）的四步讲解与
"不得只输出答案 / 讲解匹配年级 / 不确定要标注"，以及 `agent-mistake-review`（错题复盘）的
"错因必须基于学生原答案的差异 / 不许一律归为粗心 / 复习动作要可执行"。

**备注会一起发给大模型**，一句话能当两用：

- 写「第 3 题」「第(2)问」→ 图中有多题时，模型只处理备注所指的那道
- 写「我答的是 36」→ 模型据此对比正确解法判断错因，比只看作答痕迹准

备注在录入页和详情页都能改，点分析时会先存再发；结果里会记录本次使用的备注（`analysis.noteUsed`）。
分辨不出的地方模型会把 `uncertain` 置为 true，页面顶部会提示结论仅供参考。

### 他人正确解答（2026-09-11 加）

详情页**备注下面**多了一块「👥 他人正确解答」：拍下同学或老师写的正确解法，挂在同一道错题下面，
和自己的作答对照看差在哪一步。

- **可多张**：一条错题对应 N 张，缩略图按 1、2、3… 编号，一张张往后加
- **拍照方式与录入完全一致**：点「📷 拍照 / 🖼 相册」→ 全屏框选编辑器 → **只框住正确解法那部分**（字迹更清楚）
- **点缩略图看大图**，在大图里可以给这张补一句说明（「张老师课上的解法」「第 2 步不一样」），失焦即保存
- **删除要点两次**（第一次变成「再点一次会删除」）—— 防手滑，也避免再叠一层确认弹层把详情页盖掉
- 错题本网格里，有他人解答的题会在缩略图左上角标 `👥 N`

存储上是**独立的一张表**（`solutions`，一对多挂在 `errors` 上），不是塞进错题记录里：

- 解答图片单独存文件，与错题图共用 `uploads/` 目录
- 删单张只删那一张；**删错题会连解答和所有图片一起清掉**（外键级联 + 先取路径再删，不留孤儿文件）
- 与错题一样**按登录用户隔离**：别人的题下面既看不到也挂不上解答（一律 404）

> 拍照入口用的是**独立的一组文件输入**（`#fileInputSol` / `#fileInputSolAlbum`），不复用录入页那两个。
> 否则详情页拍的图会混进「待录入」队列，而且框选里的「重拍」会串到录入流程去。
> 框选编辑器的顶部文案也会按用途切换（录入是「只框住这一道题」，解答是「只框住正确解法那部分」）。

## 大模型配置

「统计」页顶部是**服务商下拉**（与 enStudy 一致的做法）：选一个服务商 → 自动带出它的 API Base 和
**它自己那份** Key 与模型，切换服务商互不干扰（`settings.providers` 按服务商分别保存）。

内置服务商（定义在 `js/views.js` 的 `PROVIDERS`）：

| 服务商 | API Base | 默认模型 |
|--------|----------|---------|
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-32B-Instruct` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| 阿里百炼（通义千问） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max-latest` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash` |
| 阿里百炼 Token Plan | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `qwen3.7-plus` |
| AMD Radeon Cloud | `https://developer.amd.com.cn/radeon/api/v1` | `Qwen3.8-Flash-Next` |
| LiteLLM（自建代理） | `http://120.25.204.182:14000/v1` | 自定义 |
| 自定义 | 自己填 | 自己填 |

- 选**阿里百炼**或**Token Plan**时会多出一个「模型 / 计划」下拉（不同档位额度与单价不同）。
- 填完可点「**测试连接**」立刻验证 base / key / 模型是否可用（只发一条 `hi`，几乎不耗额度）。
- 错题分析必须用**支持图片输入**的多模态模型，模型名下方会给出判断提示。

### Token Plan 各模型的看图能力（2026-09-10 逐个实测）

用同一张错题图问「图里能看到哪几个题号」（正确答案 `12、13、14`）：

| 模型 | 结果 | 结论 |
|------|------|------|
| `qwen3.8-max` | 答「12、13、14」 | ✅ 能看图 |
| `qwen3.7-plus` | 答「12、13、14」 | ✅ 能看图 |
| `qwen3.8-flash` | 答「12、13、14」 | ✅ 能看图 |
| `qwen3.6-flash` | 答「12、13、14」 | ✅ 能看图 |
| `qwen3.7-max` | HTTP 400 invalid_parameter_error | ❌ 不支持图片 |
| `glm-5.2` | 答「无」 | ❌ 看不到图 |
| `deepseek-v4-pro` | 编造「36、37、38…」 | ❌ 看不到图，会瞎编 |
| `deepseek-v4-flash-0731` | 答「无」 | ❌ 看不到图 |

⚠️ 从模型名判断并不靠谱（`qwen3.8-max` 名字里没有 `vl` 却能看图）——以实测为准。

### 深度思考开关（重要）

`qwen3.x-max / plus` 这类**推理模型默认会先"想"几十秒**：实测用同一张图出结果要 **40 秒以上**，
完整的 v2 提示词更容易顶穿服务端超时，表现为「上游响应超时」。

设置页的「**深度思考**」开关默认**关闭**，前端会给代理带 `enable_thinking: false`：

| | 关闭（默认） | 开启 |
|---|---|---|
| 单题分析耗时 | **15–45 秒**（题目清晰时实测 15–26s） | 60–180 秒+ |
| 读图能力 | 不受影响，照样能看图 | 不受影响 |
| `max_tokens` | 4000 | 8000（思考过程也占额度） |

只有遇到确实需要长推演的难题再打开。服务端上游超时已放宽到 240 秒兜底。

### 模型「跑飞」时的自保（2026-09-11 加）

推理模型读到**看不清的电路图/几何图**时会陷入「让我再看看 → 不对 → 再假设」的死循环：
实测一张九年级电路题，模型把 4000 token 全部用于自我推翻，输出被截断，
`steps` 里塞了 17 条自我怀疑的句子，`similar.hint` 里甚至写着「哎呀，我上面的答案写错了」。
这类结果以前会被当成"分析完成"存进库。现在的四层防护：

1. **提示词铁律**（`js/ai.js buildPrompt`）：`最多复核一次`；自算结果与图中标注答案不一致时
   直接标 `uncertain: true` 而不是反复重算；禁止「让我/等等/不对」这类字句；`steps` 限 3 步 45 字。
2. **字段顺序**：`steps` 排在 JSON **最后**——万一还是被截断，丢掉的只是步骤，不会丢答案。
3. **抢救解析**（`salvageJSON`）：截断导致整段 JSON 不合法时，按字段逐个正则救回
   question/answer/similar/steps 等，而不是让用户看到一片空白。
4. **二次快速识别**（`buildRetryPrompt`）：第一次不完美时，再发一次**只要 5 个字段、不要步骤**的请求
   （`max_tokens: 800`）。输出短就没有自我推翻的空间，用来校正题目/答案/知识点；
   步骤仍用第一次抢救回来的内容。

步骤还会过一遍 `sanitizeSteps`：剥掉模型重复写了一遍的行首序号（`1. ` / `第三步：`）、
丢掉自我怀疑的句子、超长截断、最多 6 条。

分析结果里带两个诊断字段，界面会据此弹提示：

| 字段 | 取值 | 含义 |
|---|---|---|
| `quality` | `good` / `partial` / `low` | good=干净；partial=有截断/步骤被过滤/没读出答案，界面提示"仅供参考"；low=完全解析失败，界面提示"这次分析没成功"并建议重拍（画面只留这一道题、对准、避免反光和斜拍） |
| `warnings` | 字符串数组 | 具体问题，例如「模型输出被长度上限截断」「已自动过滤 3 条模型的思考过程」 |

> 实测：同一张九年级电路图，旧提示词 4000 token 全烧光且输出无法解析；
> 加固后 26 秒正常收敛（`finish_reason=stop`），并主动标 `uncertain: true`。

Key 存在服务端数据库 `kv` 表（**按用户隔离**，实际键名 `settings.<userId>`）与浏览器本地，
请求经 `/api/ai/chat` 由服务端转发（需登录）。每个账号各配各的 Key，互不影响。

**新增服务商**需改两处，否则会被服务端拒绝转发：
1. `js/views.js` 的 `PROVIDERS` 加一项
2. `server.js` 的 `ALLOWED_HOST_SUFFIXES` 加白名单（防代理滥用；白名单内的 http 端点也放行）

## 数据结构

### users / sessions 表（账号与会话）

```sql
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- "salt:hash"（scrypt，salt 16 字节 / 派生 64 字节）
  role          TEXT NOT NULL DEFAULT 'user',   -- user | admin
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE TABLE sessions (
  sid        TEXT PRIMARY KEY,          -- 随机 32 字节 hex，存在 HttpOnly Cookie 里
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### errors 表（错题）

```sql
CREATE TABLE errors (
  id          TEXT PRIMARY KEY,   -- uuid
  subject     TEXT NOT NULL,      -- math | physics
  grade       TEXT NOT NULL,      -- 7 | 8 | 9
  image       TEXT NOT NULL,      -- '/uploads/xxx.jpg'，图片本体在文件系统
  note        TEXT NOT NULL DEFAULT '',
  analysis    JSONB,              -- AI 分析结果，未分析时为 NULL
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  user_id     INT REFERENCES users(id) ON DELETE CASCADE   -- 归属用户，删号时错题一并删
);
```

`analysis` 的 JSON 结构：

```json
{
  "schema": "v2",
  "question": "识别出的题目内容",
  "studentAnswer": "学生原答案（看不出来则空）",
  "answer": "最终答案",
  "steps": ["第一步...", "第二步..."],
  "knowledge": "考查知识点",
  "causeType": "概念不清 | 公式用错 | 计算失误 | 审题漏条件 | 步骤跳步 | 单位换算 | 其它",
  "causeDetail": "错因判断依据",
  "fixOneLine": "一句话订正",
  "tip": "易错点提示",
  "similar": { "q": "同类变式题", "a": "参考答案", "hint": "提示" },
  "reviewDays": 3,
  "reviewFocus": "重做时的注意点",
  "uncertain": false,
  "raw": "模型原始输出",
  "model": "模型名",
  "noteUsed": "本次分析用的备注",
  "analyzedAt": 0
}
```

> `schema: "v2"` 是加了错因 / 同类题 / 复习建议之后的版本；老记录（无该字段）只显示题目、
> 答案、步骤、知识点、易错点，前端对两种结构都兼容。

### solutions 表（他人正确解答）

```sql
CREATE TABLE solutions (
  id         TEXT PRIMARY KEY,
  error_id   TEXT NOT NULL REFERENCES errors(id) ON DELETE CASCADE,  -- 挂在哪道错题下
  user_id    INT  REFERENCES users(id)  ON DELETE CASCADE,           -- 归属用户（隔离用）
  image      TEXT NOT NULL,                                          -- /uploads/<uuid>.jpg
  note       TEXT NOT NULL DEFAULT '',                               -- 一句说明（可空）
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
```

> 一条错题最多 20 张（服务端限制）；列表按 `created_at ASC` 返回，所以缩略图顺序稳定。
> 删错题时外键级联清行，服务端会**先取出图片路径再删**，否则级联之后路径就查不到、文件会变成孤儿。

### kv 表（设置）
```sql
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,   -- 'settings.<userId>'，如 settings.5 表示 5 号用户的设置
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

> 客户端永远只传逻辑键 `settings`，`.<userId>` 由服务端按当前登录会话补上，
> 这样一套代码天然按用户隔离，表结构也不用为多用户改。
>
> 旧版使用的 `data/errors.json` / `data/kv.json` 已不再读写，仅作历史备份保留。

## 接口

```
POST   /api/auth/register            注册并自动登录（username, password）
POST   /api/auth/login               登录
POST   /api/auth/logout              登出（删会话 + 清 Cookie）
GET    /api/auth/me                  当前登录用户（401 = 未登录）
POST   /api/auth/change-password     改自己的密码（oldPassword, newPassword）
GET    /api/auth/users               管理员：用户列表
POST   /api/auth/reset-password      管理员：重置他人密码（targetUserId, newPassword）

GET    /api/errors?subject=&grade=&mastered=  列表（只含自己的；mastered=1 已会 / =0 还需要复习；带 solutionCount）
POST   /api/errors                   新增（subject, grade, image=dataURL, note；新题默认 mastered=false）
GET    /api/errors/:id               详情（非本人 404）
PATCH  /api/errors/:id               更新（保存分析结果 / 备注 / mastered 是否已会）
DELETE /api/errors/:id               删除（同时删除错题图与全部他人解答图）
GET    /api/errors/:id/solutions     他人正确解答列表（非本人 404）
POST   /api/errors/:id/solutions     新增他人解答（image=dataURL, note；单题上限 20 张）
PATCH  /api/solutions/:sid           改这张解答的说明
DELETE /api/solutions/:sid           删除这张解答（同时删图片文件）
GET/PUT /api/kv/:key                 设置读写（服务端按用户加命名空间）
POST   /api/ai/chat                  大模型代理转发（需登录）
```

> 除 `register` / `login` / `me` / `logout` 外，**所有接口未登录一律 401**。

## 代码结构

```
server.js                      手写 HTTP 服务：静态托管 + 上述接口 + 账号会话 + AI 代理（pg 连接池）
db_setup.js                    初始化 wrongbook 库与表（首次使用执行一次）
migrate_users_from_enstudy.js  一次性迁移：从 enStudy 库搬账号 + 补历史错题归属
migrate_json_to_pg.js          一次性迁移：旧的 data/*.json -> PostgreSQL
migrate_providers.js           一次性迁移：从 enStudy 库搬大模型服务商配置
reset_password.js              忘了口令时重置某个账号的口令
index.html                     手机端 H5 骨架
style.css                      样式（含登录页、账号胶囊）
js/auth.js                     账号模块：me / login / signup / logout / changePassword
js/store.js                    数据层：错题 CRUD、他人解答读写、科目年级定义、服务商配置、本地兜底（按用户隔离）
js/ai.js                       大模型分析：构造多模态请求、容错解析 JSON、测试连接
js/crop.js                     拍照框选编辑器：缩放/平移/旋转 + 取景框，导出选中区域（文案可按用途改写）
js/views.js                    UI 层：三个页面 + 详情弹层（含他人解答区块与大图查看）+ 登录页 + 账号菜单 + 图片压缩
js/app.js                      路由与启动（先探登录态再进应用）；拍照/相册两组文件入口
uploads/                       错题图片与他人解答图片（PG 里只存相对路径）
tests/                         回归测试（见下）
```

### tests/ 回归测试

| 脚本 | 覆盖 | 跑法 |
|---|---|---|
| `detail_test.js` | 详情页渲染（v2 分析字段、质量提示条、他人解答区块、XSS 转义）+ 提示词内容 | `node tests/detail_test.js` |
| `capture_test.js` / `crop_test.js` | 录入页多图队列、框选编辑器手势与导出 | 同上 |
| `render_test.js` | 统计页服务商下拉 / 模板渲染 | 同上 |
| `ai_logic_test.js` | 分析跑飞时的自保逻辑（假 fetch，零额度） | 同上 |
| `wb_solution_test.js` | **他人解答接口**真 HTTP 集成：401/404 越权、增删改查、文件落盘与清理、级联删除 | 需服务已启动 |
| `browser_crop_test.js` / `browser_solution_test.js` | 真 Chromium（CDP）端到端 + 像素校验 + 分步截图 | 需服务已启动 |
| `mastered_test.js` | **已会 / 还需要复习**：store 筛选与标记、错题本分段、详情页按钮位置与点击行为（沙箱） | `node tests/mastered_test.js` |
| `browser_mastered_test.js` | 已会功能真 Chromium 端到端：筛选切换、详情页标记、刷新后持久化、取消标记 | 需服务已启动 |
| `ai_e2e_test.js` | 真调上游大模型（**会消耗额度**） | 需服务已启动 |

前四个是纯沙箱测试（`Store`/`DOM` 用桩），不需要起服务；后三个需要 `./start.sh` 且用 `NODE_PATH=...` 运行（见 `start.sh`）。

`pg` 驱动装在隔离的 node 工作区（`/Users/dingrc/.workbuddy/binaries/node/workspace/node_modules`），
项目目录保持零 `npm install`，`start.sh` 已自动设置 `NODE_PATH`。

## 扩展科目

目前只有数学、物理。加科目只需：

1. `js/store.js` 的 `SUBJECTS` 数组加一项（含 id / 名称 / 图标 / 颜色）
2. `server.js` 的 `SUBJECTS` 常量加同样的 id

年级同理改 `GRADES`。
