# M1 剩余施工单 · 交接给 SGAI+

> 定位：本文是 **M1 的执行口径**。方向以 `plan-ai-master.md` 为准，但 M1 这一段
> 「做什么、按什么顺序、怎么算做完」以本文为准——两边不一致时，**以本文为准**。
>
> 编写时间：2026-09-20 ｜ 编写时的代码基线：`main` @ `18f0bd0`
>
> 读者：SGAI+（执行方）。本文默认你**看不到**本轮对话，所以把背景、已踩的坑、
> 不许碰的东西全部写进来了。

---

## 0. 先读这三段，能省你半天

**① 不要重新发明地基。** M1 的第 1 步、第 2 步**已经做完并提交**（见第 4 节）。
你现在要做的是第 3 步和第 4 步，不是从零开始。动手前先 `git log --oneline -5` 看一眼。

**② 平台现状是「登录已就绪，但默认关着」。** 代码写完了、测过了、提交了，
但线上部署没打开开关，所以你现在访问平台仍然是「不用登录」的老样子。
**这是刻意的**，不是没做完。

**③ 有一条铁律：`data/iteration/state.json` 里是真实工时数据，绝不能提交。**
它已经被 git 跟踪了，所以 `git add .` 会把它带走。**永远显式 add 文件**。
详见第 7 节。

---

## 1. M1 到底要解决什么（一句话版）

不是「换数据库」，是补 **身份 + 权限 + 审计** 三件事。

根因链条：

```
身份是假的
  → 权限没意义（不知道拦谁）
  → 审计只是自娱自乐（记录里的「谁改的」可以随手伪造）
  → 不敢让 AI Agent 自主执行（出了事追不到人）
```

M1 就是把这个链条从根上打断。做完 M1，平台才算「系统」，才敢往 M2 接数据、M3 接 Agent。

---

## 2. 对 `plan-ai-master.md` 的修正（请按这里改）

方向没问题，但有几处口径要改。改完这两份文档才是自洽的。

### 2.1 必改：M1 任务表不是 6 条，是 5 条 + 1 条拆走

`plan-ai-master.md` **第 310-317 行**（11. 路线图 → M1 表格）：

| 行号 | 原写法 | 问题 | 改成 |
|---|---|---|---|
| 312 | `1 \| 上数据库 \| fs.writeFileSync 写独立 JSON \| SQLite` | **会误导**。真实理由不是性能，是「查询与留痕」 | `1 \| 系统库（身份/权限/审计） \| 各模块独立 JSON \| SQLite 只接管身份/权限/审计；业务数据仍留 JSON（混合存储）` |
| 313 | `2 \| 真实登录 \| localStorage 字符串 \| 账号+密码，或钉钉扫码` | 「或」字让范围含糊，钉钉扫码依赖 M2 凭据 | `2 \| 真实登录 \| localStorage 字符串 \| 账号+口令+会话 Cookie（钉钉扫码留到 M2，`users.dingtalk_id` 字段已预留）` |
| 314 | `3 \| 权限矩阵 \| 全平台一个 ACCESS_TOKEN \| 角色 = PM / 研发 / 只读` | 角色名对不上代码 | `3 \| 权限矩阵 \| 全平台一个 ACCESS_TOKEN \| 角色 = admin / pm / dev / viewer，`permissions` 表 role×resource 判定` |
| 316 | `5 \| 审计加厚 \| 全量重写 + 只留 200 条 \| 追加写 + 长期留存 + 按人/模块可查` | **已经做完了**，还挂在 M1 待办里 | 挪到「已完成」，或标注 ✅ |
| 317 | `6 \| 脱敏规范发布` | 这是文档活，不阻塞 M1 代码 | 保留，但标注「不阻塞 M1 验收」 |

### 2.2 必改：缺口 1 的影响描述夸大了

`plan-ai-master.md` **第 45 行**：

> 原文：`无法细粒度查询与权限；并发写靠乐观锁硬扛；数据量大全量读写`

**「数据量大全量读写」这半句站不住。** 实测：280KB 的 `state.json` 全量读+改+写 = **约 7ms**。
涨到 5MB 也还是几十毫秒级，用户感知不到。

改成：

> `无法按人/按条件查询；无法追加写与长期留存；并发写靠乐观锁硬扛（乐观锁只解决并发，不解决身份）`

**为什么必须改**：留着这句话，下一个执行者会以「性能」为由去把业务数据也迁进数据库，
那是一次没必要的、有风险的大重构。**真实理由只有一个：JSON 做不了「查询」和「留痕」。**

### 2.3 建议改：M1 验收标准太弱

`plan-ai-master.md` **第 319 行**：

> 原文：`验收：两个人同时登录、各看各的视图、改的数据互不覆盖。注意：乐观锁只解决并发写，没解决身份。`

后半句判断是对的（赞），但前半句作为验收标准不够——它测不出「权限是不是真的生效」。
建议替换为 `plan-ai-m1-foundation.md` 第 226-231 行那 6 条（可直接抄）：

- [ ] 两个不同账号同时登录，各自看到自己的名字（不是 localStorage 里的）
- [ ] 用 `dev` 角色账号尝试改计划 → **被拒绝**（服务端拒绝，不是前端藏按钮）
- [ ] 手工把浏览器 Cookie 里的 token 改掉 → 请求被拒
- [ ] 审计日志能查到「谁在什么时候改了什么」，且**超过 200 条后不丢**
- [ ] 现有 8 个模块的读写功能**全部不受影响**
- [ ] `data/iteration/state.json` 的真实工时数据**未被触碰**

### 2.4 笔误

`plan-ai-m1-foundation.md` **第 28 行**：

> 原文：`身份是假的 → 权限没意义 → 权限没意义 → 审计只是自娱自乐 → 审计不可信 → 不敢让 Agent 自主执行。`

「权限没意义」重复了一次，删掉一个。

### 2.5 施工顺序已过时，按第 3 节走

`plan-ai-m1-foundation.md` **第 235-247 行** 的「分四步走」里，第 3 步描述为
「动到所有模块的写路径，真正有风险」——**实际实现比这个描述干净得多**。

真实做法是在 `server.js` 里加了一道 `gate()` 门禁（按 URL 前缀判权限），
**没有改任何模块的写路径**。所以第 3 步的风险等级要从「高」降到「中」。

---

## 3. 你现在要做的（M1 剩余任务）

### 步骤 3 · 权限矩阵接进模块加载器（**小**）

**现状**：权限判定在 `server.js` 的 `gate()` 里，靠一张手维护的 `PREFIX_RESOURCE` 映射表
（`server.js:209-221`）。新增模块时**必须记得在这张表里补一行，否则该模块默认拒绝**——
这是个容易踩的坑。

**目标**：让权限判定跟着模块自己走，而不是靠 `server.js` 里一张平行表。

**建议做法**：`modules/<id>/routes.js` 导出里增加一个可选字段：

```js
module.exports = {
  id: 'plan',
  prefix: '/api/plan',
  resource: 'plan',        // ← 新增：本模块的权限资源名，不写则默认取 id
  handle, ensureData
};
```

然后 `module-loader.js` 在 `loadAll()` 时把这个 `resource` 收进注册表，
`server.js` 的 `resourceOf()` 改为查注册表，`PREFIX_RESOURCE` 常量删掉。

**为什么值得做**：M2 要加 `modules/dingtalk`，那会儿没人会记得去改 `server.js` 里的表。

**验收**：删掉 `PREFIX_RESOURCE` 后，第 2 步那套端到端测试仍然全绿。

---

### 步骤 4 · 部署 + 备份 + 运行手册（**中**）

**目标**：从「本机 `node server.js`」变成「内网服务器上能长期跑、能备份、出问题能查」。

需要产出：

1. **启动脚本**：Windows `.bat` + Linux `.sh` 各一份，含 `AUTH_REQUIRED=1`、`PORT`、`DATA_DIR` 的设置位。
2. **备份脚本**：`data/` 整个目录打包（`platform.db` + 各模块 `state.json` 一起），
   **必须带日期**，保留最近 N 份。注意 `platform.db` 开了 WAL，
   备份要么用 `VACUUM INTO`，要么停服后拷——**别直接 `cp` 正在写的 WAL 库**。
3. **运行手册**（`docs/runbook.md`）：至少覆盖
   - 怎么首次启动、去哪找 admin 口令（**只打印一次**，见第 5 节）
   - 忘了 admin 口令怎么重置
   - 怎么加人、改角色、停用人
   - `data/platform.db` 损坏了怎么办（重建 + 审计日志不可恢复，要写清楚）
   - 端口被占用怎么换
4. **`ACCESS_TOKEN` 与 `AUTH_REQUIRED` 的关系写清楚**：两者同时开时是「先过口令，再登账号」双层。

---

### 步骤 4.5 · 收尾（**小，但别漏**）

- `platform.js` 的 `refreshIdentity()` 目前只在 `init()` 时拉一次 `/api/auth/me`。
  **登录态过期（30 天）后前端不会自知**，会以「未登录」状态继续渲染。
  建议：任何 API 返回 401 且带 `login` 字段时，统一跳登录页。
  **这是目前唯一已知的行为缺口。**
- 前端权限（`Platform.can('plan:write')`）已经能用，但**没有任何地方在用它**。
  建议先只做一个：权限不足时把「保存」按钮置灰。
  **注意**：前端置灰只是体验，服务端 `gate()` 才是真正的拦截，两者都要有。

---

## 4. 已完成的部分（别重做）

基线：`main` 分支，最新提交 `18f0bd0`。

| 提交 | 内容 | 涉及文件 |
|---|---|---|
| `d69a5c4` | **M1 步骤 1**：身份/权限/审计的系统库 | 新增 `db.js`、`_db-test.js`；重写 `audit.js`；改 `.gitignore`、`handoff.md` |
| `18f0bd0` | **M1 步骤 2**：真登录 + 服务端权限门禁 | 新增 `modules/auth/routes.js`、`login.html`；改 `server.js`、`platform.js`、`sync.js` |

### 4.1 已交付的能力

**系统库（`db.js`）**
- 选型 `node:sqlite`（Node v24 内置，零依赖、免原生编译）。启动会有 `ExperimentalWarning`，**正常噪音，别去消除它**。
- 5 张表：`users` / `sessions` / `audit_log` / `permissions` / `meta`
- 口令用 `scrypt` + 随机盐 + `timingSafeEqual` 比对
- **所有 SQL 都收敛在 `db.js` 内**。将来若要换 `better-sqlite3`，只改这一个文件。
- 已从旧 `audit-log.json` 迁移 200 条历史记录（**顺序已验证正确**，见第 5 节坑 #9）

**身份（`modules/auth/routes.js`）**
- 端点：登录 / 登出 / `me` / 改口令 / 用户列表 / 建用户 / 改角色 / 启用停用 / 重置口令 / 查权限
- 会话 Cookie `wb_session`，30 天，`HttpOnly; SameSite=Lax`
- 登录失败**统一**回「账号或口令不正确」——不透露账号是否存在
- 导出 `currentUser(req)` / `can(user, resource)` 供 `server.js` 复用

**门禁（`server.js`）**
- `AUTH_REQUIRED` 环境变量，取值 `/^(1|true|yes)$/i`，**默认关闭**
- 未登录：API 回 401 JSON（带 `login` 字段），页面 302 到 `/login.html?next=...`
- 越权：403，错误信息里带所需权限名（如 `plan:write`）
- `GET`/`HEAD` 记为读，其余一律按写处理（保守）
- 启动时 `purgeExpiredSessions()` 清理过期会话

**默认权限矩阵**（`db.js` 的 `DEFAULT_PERMISSIONS`）

| 角色 | 读 | 写 | AI |
|---|---|---|---|
| `admin` | 全部 | 全部 | 全部（**不在表里判定，一律放行**） |
| `pm` | plan/iteration/project/csenergy/budget/token/dashboard/archive | plan/iteration/project/csenergy/archive | `ai:doc` `ai:risk` `ai:report` |
| `dev` | plan/iteration/project/csenergy/dashboard/token | 无 | 无 |
| `viewer` | plan/iteration/project/csenergy/budget/token/dashboard | 无 | 无 |

**刻意不给 `pm` 的**：`budget:write` 和 `ai:finance`——用户原话是
「项目经理可以调用文档 Agent，但不能调用财务 Agent 修改预算基准」。

> `dev` 角色**没有**任何 write 权限。研发改自己的任务状态需要行级权限，
> 预留的通道是 `task:write`，**这块还没做，别以为已经能用了**。

### 4.2 验收记录（31 项全过）

用临时 `DATA_DIR` 起真服务端跑端到端，覆盖：
未登录 401/302 → 登录 → Cookie 会话 → viewer 写 plan 撞 403 → pm 写 budget 撞 403
→ 停用用户后旧会话失效 → 登出清 Cookie → 伪造 Cookie 按未登录处理。
**另逐项确认 `AUTH_REQUIRED` 未设置时行为与升级前一字不变。**

---

## 5. 踩过的坑（**这一节最重要，请完整读**）

### #8 块注释里的 `*/` 会提前闭合注释

`db.js` 顶部注释里写了 `modules/*/routes.js`，其中 `*/` 结束了块注释，
后面的中文被当成代码解析，报 `SyntaxError: Unexpected identifier '的'`。

**结论**：写注释时别用 `/*` 这种通配符写法。已改成 `各模块 routes.js`。

### #9 迁移数据时要对齐「顺序语义」，不只是「内容」

旧 `audit-log.json` 是**新的在前**（倒序），但 SQLite 表用自增 `id` + `ORDER BY id DESC`。
如果按文件顺序正序插入，最新的会落在最后，查出来的第一条就错了。

**结论**：迁移前先确认两边对「哪条是最新的」理解一致。
本次修复是 `old.slice().reverse()`，并加了断言验证首尾两条。

### #10 `node:sqlite` 的实验性警告

`ExperimentalWarning: SQLite is an experimental feature`。**正常，别去消除。**

### #11 Git Bash 在 Windows 上会把命令行参数重新编码成 GBK

用 `curl -d '{"by":"中文"}'` 测中文写入，落库变成乱码。
**这是测试方法的问题，不是代码的 bug。**

**结论**：测中文一律用 `node -e` 发请求，**别用 curl**。

### #12 起点测试脚本会占着端口

起服务端测完要 `child.kill()`，且杀完之后**要等约 600ms 再起下一个**，
否则新服务抢不到端口，表现为「连不上」而不是报错。

---

## 6. 关于 Git：分支、进度、怎么接

### 6.1 分支策略（重要）

**全部在 `main` 上做，不要开新分支。**

这是用户的明确要求，原话：

> 「我建议不要搞这么多分支，既然都是你在写代码你都在一个分支就好」

仓库里现存一堆 `feat/*` `fix/*` `codex/*` 分支是历史遗留，**不要基于它们工作，也不要清理它们**。

### 6.2 当前状态

```
当前分支：main
最新提交：18f0bd0  feat(auth): M1 步骤2 —— 真登录（账号/口令/会话）+ 服务端权限门禁
远程：    origin/main（是的，main 是要推到远端的）
```

### 6.3 提交规范

- 提交信息用中文，格式 `type(scope): 中文说明`
- `type` 取值沿用仓库习惯：`feat` / `fix` / `docs` / `chore`
- **每条提交末尾加**：`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

### 6.4 怎么确认自己接对了

```bash
git log --oneline -5        # 应该能看到 18f0bd0 和 d69a5c4
git status --short          # 应该能看到 data/iteration/state.json 是 M（已修改）
```

**看到 `state.json` 显示 `M` 是正常的**——那是用户本地跑出来的真实工时数据，
不是你改的，**也不要提交它**。

---

## 7. 安全铁律（违反会造成不可逆损失）

### 7.1 绝不能提交的文件

| 文件 | 为什么 | 状态 |
|---|---|---|
| `data/iteration/state.json` | **含有真实工时数据** | **已被 git 跟踪**，所以最危险 |
| `data/platform.db` | 含口令哈希 + 审计记录 | 已在 `.gitignore` |
| `data/**/secret.json` | 钉钉 / TB 的 API 凭据 | 已在 `.gitignore` |

### 7.2 因此：**永远不要执行 `git add .`**

`data/iteration/state.json` 被 git 跟踪着，`git add .` 会把它带上。
**一律显式指名文件**：

```bash
git add server.js module-loader.js modules/plan/routes.js
```

提交前用 `git diff --cached --name-only` 再确认一遍暂存区里没有 `data/` 下的东西。

### 7.3 顺带一提

`data/platform.db` 用了 WAL 模式，会同时存在 `-wal` 和 `-shm` 两个附属文件。
`.gitignore` 里三个都已经忽略了，新增备份脚本时注意别只备主文件。

---

## 8. 与钉钉打通的关系（**当前冻结，不要动**）

钉钉那条线**目前暂停**，等用户提供凭据（权限点名称、应用凭据、文档链接、网络连通性确认）。
**不要在 M1 里顺手推进钉钉相关代码。**

两条线本来就互不阻塞：
- 钉钉（M2）在 `modules/dingtalk` 下加 adapter，不碰平台骨架
- M1 改的是平台骨架，不碰 adapter

**唯一交汇点**：钉钉的 `operatorId` 将来对上 `users.dingtalk_id`，
实现钉钉扫码登录。`dingtalk_id` 字段**已经在 `users` 表里预留好了**，
M1 不需要为它做任何额外的事。

---

## 9. 相关文档索引

| 文档 | 定位 |
|---|---|
| `plan-ai-master.md` | **唯一主线**（方向、架构、M1-M4 路线图）。本文第 2 节列了要改的几行 |
| `plan-ai-m1-foundation.md` | M1 的详细论证与实测数据（为什么是混合存储、7ms 基准怎么来的）。第 2.4、2.5 节列了要改的地方 |
| **本文（`plan-ai-m1-tasks.md`）** | **M1 的执行口径**。与上面两份冲突时以本文为准 |
| `plan-ai-roadmap.md` | 早期版本，已被 master 吸收，**仅作历史参考，不要照它做** |
| `plan-dingtalk-checklist.md` | 钉钉打通的凭据清单（当前冻结） |
| `handoff.md` | 逐轮交接记录，含「踩过的坑」累计清单 |

---

## 10. 建议的开工顺序

1. 读第 0 节 + 第 5 节（坑）+ 第 7 节（铁律）——**这三节读完再动手**
2. `git log --oneline -5` 确认基线是 `18f0bd0`
3. 做**步骤 3**（权限矩阵接进模块加载器），跑通第 2 步那套验收
4. 做**步骤 4**（部署 + 备份 + 运行手册）
5. 做**步骤 4.5**（401 跳登录页 + 保存按钮置灰）
6. 按第 2 节修正 `plan-ai-master.md` 和 `plan-ai-m1-foundation.md`
7. 更新 `handoff.md`，把这轮新踩的坑追加进去

**M1 做完的标志**：`plan-ai-m1-foundation.md` 第 226-231 行那 6 条验收全部打勾，
且线上以 `AUTH_REQUIRED=1` 跑起来之后，多账号能正常登录取用。
