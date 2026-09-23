# M1 · 地基改造清单

> 状态：改造方案 v1 ｜ 2026-09-20
> 定位：把平台从「个人工具」改造为「多人协同系统」的具体施工清单
> 前置：无（可立即开工，与钉钉打通并行不冲突）

---

## 结论先行

**M1 的核心不是换数据库，是补「身份 + 权限 + 审计」三件事。**

我原本以为要换数据库，实测之后**推翻了这个结论**——见第二节。正确的是**混合方案**：
只在**必须被查询、必须被审计**的地方引入 SQLite，模块业务数据继续留在 JSON（它够快）。

---

## 一、先说清楚 M1 到底解决什么问题

你终局要的是「**AI 可以自主执行，但不能自主负责**」。这句话翻译成技术要求是三样东西：

| 要求 | 依赖 | 现状 |
|---|---|---|
| 知道「谁」在操作 | 真实身份认证 | ❌ 假的 |
| 管住「谁能干什么」 | 角色权限矩阵 | ❌ 只有全平台一个密码 |
| 记下「谁干了什么、采纳与否」 | 长期可查的审计 | ⚠️ 只留 200 条，且全量重写 |

**身份是假的 → 权限没意义 → 审计只是自娱自乐 → 审计不可信 → 不敢让 Agent 自主执行。**

这就是 M1 要打断的链条。

---

## 二、关键实测：数据库这件事，我改了结论

### 2.1 实测结果

| 实测项 | 结果 |
|---|---|
| `data/iteration/state.json` 大小 | 280 KB（最大的一张，含 997 条 board / 272 条 totals） |
| 全量读 + 改 + 全量写 ×1 | **约 7 毫秒** |
| `node:sqlite` 内置模块 | **可用**（Node v24.12.0 自带，零依赖，免编译） |
| `better-sqlite3` | 未安装，需要 npm install + 原生编译 |

### 2.2 结论：性能不是换数据库的理由

**7 毫秒的全量读写，对当前数据规模完全够用。** 别说 280KB，就是涨到 5MB 也还是几十毫秒级，用户感知不到。

**所以「上 SQLite」不能以「JSON 太慢」为理由——那是站不住的。** 我之前按经验假设了性能瓶颈，实测证明没有。

### 2.3 那为什么要上数据库？因为有 JSON 真做不了的事

| 需求 | JSON 文件 | 数据库 |
|---|---|---|
| 按人查「张三这周改了什么」 | 遍历全部日志文件 | 一条 SQL |
| 审计日志追加写（不能丢） | 每次全量重写 + 只留 200 条 | 追加一行，永久留存 |
| 用户 / 会话 / 角色 | 只能再开一个 JSON，无并发保障 | 天然支持，带约束 |
| 跨模块关联查询（PR ↔ 任务 ↔ 项目） | 手工 join，代码里拼 | SQL join |
| 知识库全文检索 | 自己实现 | FTS 扩展 |

**一句话：不是为了快，是为了「查询」和「留痕」。** 这两件事 M2/M3 一定会用到，现在建好省后患。

---

## 三、推荐方案：混合存储（不是全量迁移）

### 3.1 方案对比

| 方案 | 做法 | 风险 | 工作量 | 评价 |
|---|---|---|---|---|
| **A. 全量迁移 SQLite** | 所有模块 state 全进表 | 🔴 高：8 个模块 + 280KB 真实工时数据，迁移出错代价大 | 大 | ❌ 不建议，收益不匹配风险 |
| **B. 保持 JSON 不动** | 只加登录 + 权限 | 🟡 中：审计和查询能力补不上，M2/M3 会卡 | 小 | ❌ 治标不治本 |
| **C. 混合存储** ⭐ | **身份/权限/审计/映射 → SQLite**<br>**模块业务 state → 继续 JSON** | 🟢 低：不碰现有数据，增量引入 | 中 | ✅ **推荐** |

### 3.2 为什么 C 是对的

- **模块业务数据**（迭代/计划/预算…）是「整体读、整体写」的模式，JSON 天然合适，**而且已经在稳定运行，没有理由去动它**。符合「只改必要部分」的原则。
- **身份、权限、审计、映射关系**是「按行查、按条件筛、要长期累积」的模式，JSON 根本不适合，**这才是数据库该上场的地方**。
- **两边的边界清晰**：`data/*.json` 是业务数据，`data/platform.db` 是系统数据。互不干扰，随时可回退。

---

## 四、施工清单

### 4.1 数据库选型：`node:sqlite`（Node 内置）

**理由：**
- **零依赖**——不用 npm install，不用原生编译，没有 `better-sqlite3` 那种「换台机器就编译失败」的坑；
- Node v24.12.0 已内置，实测可用；
- ⚠️ 目前标记为 experimental，会有 `ExperimentalWarning`。**这是唯一缺点，但可接受**——API 稳定，且用一层薄封装隔离，将来要换 `better-sqlite3` 只改一个文件。

新建 `db.js`（数据库连接 + 建表），落盘到 `data/platform.db`（**记得加进 `.gitignore`**）。

**要建的表：**

```sql
-- 用户
CREATE TABLE users (
  id TEXT PRIMARY KEY,          -- 用户 ID
  name TEXT NOT NULL,           -- 显示名
  dingtalk_id TEXT,             -- 钉钉 userId（将来扫码登录用）
  password_hash TEXT,           -- 密码哈希（加盐），钉钉登录用户可空
  role TEXT NOT NULL,           -- 角色：pm | dev | viewer | admin
  enabled INTEGER DEFAULT 1,
  created_at TEXT, updated_at TEXT
);

-- 会话（登录态）
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,       -- 随机 token，存 HttpOnly Cookie
  user_id TEXT NOT NULL,
  created_at TEXT, expires_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 审计日志（追加写，永不全量重写，永不截断）
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id TEXT,                 -- 现在是字符串「谁」，将来是真实用户 ID
  module TEXT, action TEXT, details TEXT,
  ai_triggered INTEGER DEFAULT 0,   -- 是否由 AI 触发
  ai_adopted INTEGER                 -- AI 建议是否被采纳（NULL=非 AI 操作）
);

-- 权限矩阵（角色 → 能做什么）
CREATE TABLE permissions (
  role TEXT NOT NULL,
  resource TEXT NOT NULL,       -- 如 'plan:write'、'budget:write'、'ai:doc'
  allowed INTEGER DEFAULT 0
);
```

> **注意 `audit_log` 里那两个 AI 字段**：`ai_triggered` 和 `ai_adopted` 现在看起来没用，但它们是 Harness 审计层「**AI 建议被采纳还是被拒绝**」的落点。
> **现在建好，将来直接写**，不用改表——而这张表一旦有了历史数据，改表就麻烦了。

### 4.2 身份改造：干掉假 `whoami()`

**现状（`platform.js:316`）：**
```js
function whoami() {
  let name = localStorage.getItem(USER_KEY) || '';   // ← 任何人改一下就是别人
  ...
}
```

**改造：**
1. 服务端新增 `modules/auth/routes.js`：`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`；
2. 登录成功 → 生成随机 token → 写 `sessions` 表 → `Set-Cookie: session=xxx; HttpOnly; SameSite=Lax`；
3. 服务端每个写请求校验 session → 拿到真实 `user_id`；
4. **客户端 `whoami()` 改为从 `/api/auth/me` 拿**，localStorage 那套彻底删掉。

**这一步会连带影响**：所有模块写数据时 `by: whoami()` 传的是浏览器字符串——
改造后要改成**服务端从 session 里取**，不再信任客户端传来的身份。

> ⚠️ **这是最重要的一条安全改动。** 现在客户端能自报身份，等于审计日志可以随便伪造。

### 4.3 权限矩阵：从「一个密码」到「按角色」

**现状（`server.js:232`）：** 全平台一个 `ACCESS_TOKEN`，有密码就能读写一切。

**改造：**
- 保留 `ACCESS_TOKEN` 作为**访问门禁**（能进门），新增**角色**决定「进门后能干什么」；
- 服务端在模块分发前统一校验：`resource = moduleId + ':' + (读/写)`，查 `permissions` 表；
- 默认角色：

| 角色 | 能看 | 能改 | 能调 AI |
|---|---|---|---|
| `admin` | 全部 | 全部 | 全部 |
| `pm` | 全部 | 计划/迭代/资源 | 文档、风险、周报 Agent |
| `dev` | 自己相关的 | 自己的任务状态 | ❌ |
| `viewer` | 只读 | ❌ | ❌ |

**注意**：你原话「项目经理可以调用文档 Agent，但不能调用财务 Agent 修改预算基准」——这个区分靠的就是 `permissions` 表里 `ai:doc` 和 `budget:write` 的粒度。

### 4.4 审计加厚：从 200 条到长期留存

**现状（`audit.js`）：**
```js
let logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));  // 全量读
logs.unshift({...});
if (logs.length > MAX_ENTRIES) logs = logs.slice(0, MAX_ENTRIES);  // 只留 200 条
fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));  // 全量重写
```

**三个问题：**
1. **全量重写**——日志越长越慢，且写入过程中崩溃会全丢；
2. **只留 200 条**——Harness 要求「可追溯」，200 条撑不了几天；
3. **无查询**——想查「张三上个月改了什么」只能肉眼翻。

**改造：** `audit.log()` 改为 `INSERT INTO audit_log`。已有的 200 条 JSON 日志**一次性导入**，老文件保留归档。

**接口保持兼容**：`audit.log({user, module, action, details})` 签名不变，模块代码不用改——**这是刻意的，减少改动面**。

### 4.5 部署

| # | 任务 |
|---|---|
| 1 | 启动脚本（Windows 批处理 + Linux shell 各一份） |
| 2 | `DATA_DIR` 指向服务器持久化路径（已有支持，见 `server.js:36`） |
| 3 | 备份脚本：定时打包 `data/` 目录 |
| 4 | 说明文档：怎么启动、怎么看日志、怎么重置密码 |

---

## 五、改动面评估（哪些文件会动）

| 文件 | 改动 | 风险 |
|---|---|---|
| `db.js` | **新建** | — |
| `modules/auth/routes.js` | **新建** | — |
| `audit.js` | 改为写库，**接口签名不变** | 🟢 低 |
| `platform.js` | `whoami()` 改为读 `/api/auth/me` | 🟡 中（前端多处依赖） |
| `server.js` | 加 session 校验 + 权限校验中间件 | 🟡 中 |
| `module-loader.js` | dispatch 前加权限钩子 | 🟡 中 |
| `modules/*/routes.js` | **只有取 `by` 的地方要改**（从客户端传 → 服务端 session 取） | 🟢 低 |
| `data/*.json` | **完全不动** | 🟢 无 |
| `.gitignore` | 加 `data/platform.db` | 🟢 低 |

**核心结论：模块业务数据完全不动，改动集中在「平台骨架 + 新增 auth 模块」。** 这是把风险控制住的关键。

---

## 六、验收标准

- [ ] 两个不同账号同时登录，各自看到自己的名字（不是 localStorage 里的）
- [ ] 用 `dev` 角色账号尝试改计划 → **被拒绝**（服务端拒绝，不是前端藏按钮）
- [ ] 手工把浏览器 Cookie 里的 token 改掉 → 请求被拒
- [ ] 审计日志能查到「谁在什么时候改了什么」，且**超过 200 条后不丢**
- [ ] 现有 8 个模块的读写功能**全部不受影响**
- [ ] `data/iteration/state.json` 的真实工时数据**未被触碰**

---

## 七、建议的施工顺序

**分四步走，每步独立可验证，随时可停：**

| 步骤 | 内容 | 产出 | 状态 |
|---|---|---|---|
| **1** | `db.js` + 建表 + 把老审计日志导入 | 数据库跑起来，审计已迁移 | ✅ `d69a5c4` |
| **2** | `modules/auth` + 登录页 + session | 能真登录，`/api/auth/me` 可用 | ✅ `18f0bd0` |
| **3** | `whoami()` 切换 + 权限矩阵 | 身份真实，权限生效 | 🔶 已生效，还差接进模块加载器 |
| **4** | 部署脚本 + 备份 + 说明文档 | 可发布 | ⬜ 待做 |

**第 1、2、3 步已完成**（`main` @ `18f0bd0`）。剩余工作与执行口径见 `plan-ai-m1-tasks.md`。

**一处修正**：原先估计「第 3 步动到所有模块的写路径，风险最高」——
实际实现是在 `server.js` 加了一道按 URL 前缀判权限的 `gate()` 门禁，
**没有改任何模块的写路径**。风险等级从「高」降到「中」。

---

## 附：与钉钉打通的关系

**两条线并行，互不阻塞：**

- 钉钉打通（M2）在 `modules/dingtalk` 下新增 adapter，不碰平台骨架；
- M1 改的是平台骨架，不碰 adapter。

**唯一交汇点**：钉钉的 `operatorId` 将来可以和 `users.dingtalk_id` 对上，实现**钉钉扫码登录**——这正好是 M1 第 2 步的自然延伸。

---

## 附：相关文档

- 总体路线图：[`plan-ai-roadmap.md`](./plan-ai-roadmap.md)
- 钉钉打通待办：[`plan-dingtalk-checklist.md`](./plan-dingtalk-checklist.md)
