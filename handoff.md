# 项目计划模块 — 交接文档（handoff）

> 这是长对话关闭前自动沉淀的交接文档，供下一个会话快速接续，避免重复踩坑。

## 一、当前任务

在云平台管理工作台（`iSolarCloudProjectManage`，分支 `feat/tb-sync-stage2`）中**新建「项目计划」模块**，属于阶段性需求（一）：
- 任务 WBS + 里程碑 + 资源 + 甘特 + 高管视图（本地规则）+ AI 入口预留
- 同时重设计左侧边栏，让每个功能有**唯一图标**
- 满足三条 UX 硬指标：输入框不截断、平铺完整展示、宽表/甘特横向滚动

## 二、已完成

| 文件 | 状态 |
|---|---|
| `modules/plan/routes.js` | ✅ 服务端，node --check 通过，三态测试全绿（200读/200写/400校验/409锁） |
| `modules/plan/index.js` | ✅ 客户端，node --check + CommonJS 加载断言通过 |
| `modules/plan/plan.css` | ✅ 样式，含三条 UX 硬指标实现 |
| `docs/plan-module-design.md` | ✅ 完整设计规格书（0~10 节） |
| `.gitignore` | ✅ 已加 `data/plan/state.json`、`data/plan/history/` |
| `platform.html` | ✅ 3 个集成点：CSS link / 脚本 / `Platform.init` 追加 `PlanModule`；footer 图标加 `data-fixed` |
| `router.js` | ✅ `buildBreadcrumb` 增加 `plan` 分支 |
| `platform.js` | ✅ `renderSidebarNav` 重写为按模块配色瓦片（`--nav-bg` / `--nav-shadow`） |
| `platform.css` | ✅ `.nav-icon` 改为 26×26 圆角渐变色瓦片 |
| `modules/iteration/index.js` | ✅ 模块图标 `📊` → `📚`（消除与 csenergy 的重复） |

**服务端已验证**（用临时 plan-demo 数据 POST/GET/清空，真实 HTTP 测试）：
- `/api/plan/state` GET → `{"rev":2,"plans":[]}`（已清空复位）
- `/api/plan/summary` → `agg` 与 `plans[*]` 字段完整（phases 数组、resource.load、risks 均正确）
- POST 非法 status 且 baseRev 正确 → `[400] {"error":"计划 ... 状态无效"}`
- POST 过期 baseRev → `[409] {"error":"数据已被他人更新"}`
- `data/plan/state.json` 直连 → `[403]`（静态守卫拦截，数据不泄露）

## 三、模块架构（已实现）

- **服务端自动发现**：`module-loader.js` 扫描 `modules/*/routes.js`，导出 `{id:'plan', prefix:'/api/plan', ensureData(), handle}` 即自动注册，**无需改 server.js**。
- **数据文件**：`data/plan/state.json`（含 `rev/updatedAt/updatedBy/plans[]`），`data/plan/history/plan-rev<N>.json` 快照。
- **乐观锁**：POST body `{baseRev, state, by}`；`baseRev < curRev` 返回 409。
- **客户端挂载链**：`Platform.init([..., PlanModule])` → Router `init` → `parseRoute('plan/...')` → `switchContainer` 自动建 `#module-plan` → `enter(subPath)` → `applySubPath`。

## 四、关键技术决策

1. **数据独立**：plan 用独立 `data/plan/state.json`，**不与 iteration 共享**，不触碰真实工时数据（铁律）。
2. **图标方案**：保留 emoji 作为图标核心，但每个模块用 `NAV_ICON_COLORS` 分配**唯一 emoji + 渐变底色瓦片**，避免引入 SVG 只改侧栏。
   - dashboard 🏠 蓝 / iteration 📚 青绿 / csenergy 📊 紫 / plan 🗓️ 橙 / settings ⚙ 灰 / help 📖 灰
3. **三条 UX 红线**在 CSS 里显式落实：
   - `①` 输入框：`min-width` 至少 96px（数字人天 6 位）、148px（日期）、190px（名称）；`overflow-x:auto` 不裁切
   - `②` 平铺：`.pl-card-grid` `repeat(auto-fill, minmax(340px,1fr))`，长文 `word-break:break-word` 不省略
   - `③` 横向滚动：`.table-wrapper`/`.pl-gantt-scroll` `overflow-x:auto` + `min-width`；甘特任务名列 `position:sticky; left:0`
4. **WBS 树**：客户端 `buildWbsTree` 按 `parentId` 组装 + 自动编号；父任务下拉排除自身防自引用；保存时 `buildWbsCodes` 重算 1/1.1/1.1.1。
5. **高管视图/AI 规则**：纯本地规则即时计算（`computePlanSummary`/`generateRules`），不调用外部 AI，预留 `aiConfig` 字段。

## 五、当前卡点 / 待办

- [ ] **提交并推送**到 `origin/feat/tb-sync-stage2`，让用户验收体验。
- [ ] 用户验收后，可能反馈调整项（图标配色、甘特交互、表单布局等）。
- [ ] 设计文档 §7 图标表、§8 验收清单已覆盖，可在验收时逐条对照。

## 六、踩过的坑（务必别再踩）

1. **别只说"正在写"**：曾连续 4 轮声明要写 `index.js` 却未落盘，用户明显不满。**改了文件才算交付**，写完立即汇报。
2. **`/tmp` 路径差异**：node 在 Windows 下把 `/tmp` 解析为 `E:\tmp`；git-bash 的 `curl --data @/tmp/xx.json` 用的是 git-bash 自己的 `/tmp`。混用会 ENOENT。**统一用 git-bash 的 `/tmp`，node 读取用相对路径。**
3. **`const` 在 `eval` 中不泄漏**：用 `Module._compile` 才能让 IIFE 的 `const` 导出，从而可断言。
4. **复制粘贴的变量名**：服务端曾残留 `load` 未定义（应 `resourceLoad`）、`phases` 旧形状 `{count,done,hours}` 与客户端 `{name,total,completed,sumHours}` 不一致——写入前务必 `node --check` + 真数据测一遍摘要字段。
5. **客户端 `el` 变量**：`el` 必须在顶部 `let el=null` 声明并在 `init` 里赋值 `el=el_`，否则 `el.querySelector` 报错。
6. **事件重复绑定**：tab / tree-toggle 只应在 `bindTabEvents`（或绑定一次）注册；`renderTabBody` 重刷后不能整视图 `bindEvents()` 重绑，否则 back/编辑/删除事件叠加。
7. **编号/索引类事件**：task 增删时用 `data-task-idx`（行位置）需在 `syncFormFromDom` 之后再 splice，否则索引错位。
8. **保存后 `rev` 不更新**：`saveState` 必须用服务端回传的 `result.rev` 覆盖本地 `state.rev`，否则第二次保存必 409。
9. **数值归一化**：`submitPlan` 中 `plannedHours/total/progress` 空串必须 `Number()` 成数字，否则服务端强校验 400。
10. **`.gitignore` 不漏**：新模块的 `state.json`/`history/` 必须加入，否则会 commit 真实数据。

## 七、关键文件路径

```
E:\PMWork\Project Materials\iSolarCloudProject\迭代版本\iSolarCloudProjectManage\
├── modules\plan\
│   ├── routes.js        # 服务端（/api/plan/state、/summary、POST state）
│   ├── index.js         # 客户端（list/detail 6 tab/new/edit）
│   └── plan.css         # 样式（pl- 前缀 + 三条 UX 红线）
├── docs\plan-module-design.md   # 设计规格书
├── platform.html        # 集成（CSS/脚本/init）
├── platform.js          # renderSidebarNav 图标瓦片
├── platform.css         # .nav-icon 瓦片样式
├── router.js            # buildBreadcrumb plan 分支
├── .gitignore           # data/plan/state.json、data/plan/history/
└── data\plan\state.json # 运行时数据（绝不提交）
```

## 八、整体设计思路（执行前）

按 csenergy 模块为蓝本（它是现阶段最完整的"全能"模块）：**server auto-discovered route + 客户端 ModuleDefinition IIFE + 复用的平台/组件样式类 + 本地规则引擎**。服务端负责状态存取 + 摘要计算（WBS/里程碑/资源负荷/风险），客户端负责 6 个视图渲染与表单 CRUD。坚持"数据独立、铁律约束、复用 > 新建、本地规则先行、AI 入口预留"。图标重装在 `NAV_ICON_COLORS` 一处集中管理，未来加模块只需加一行。

---

# 交接文档 v2 — 2026-09-11（钉钉/Excel 导入导出）

> 上一版（v1，项目计划模块初建）保留在上方，作为模块架构与早期踩坑记录。
> **本节才是当前会话的真实状态**，接续工作请只看本节。

## A. 当前分支与提交

- 分支：`main`（用户明确要求**不要再开分支**，所有工作都在 `main` 上）
- 最近提交：`6bcd009 feat(plan): 批1 导入钉钉/平台 Excel —— 解析内核 + 预览确认页`
- 三条原始需求：
  1. 项目计划导出 Excel —— **已完成**（`feat/plan-excel-export` 已并入 main）
  2. 上传钉钉 Excel → 平台读表 → 按平台表单格式填充 —— **批1 已完成**
  3. 与钉钉直接打通、有更新自动同步 —— **未开始**，等用户提供凭据（见 `docs/plan-dingtalk-checklist.md`）

## B. 本会话新增的文件

| 文件 | 说明 |
|---|---|
| `modules/plan/import-core.js` | 服务端解析内核，纯函数无 IO，~1310 行 |
| `modules/plan/_import-test.js` | node:test 用例 11 条，全绿 |
| `_t-import.js` | 对真实 xlsx 的端到端断言脚本 |
| `docs/plan-dingtalk-checklist.md` | **钉钉打通需要用户提供什么**（给用户看的行动清单） |
| `data/dingtalk/secret.example.json` | 凭据模板；`secret.json` 已在 .gitignore |

服务端 `POST /api/plan/import-parse`（32MB 上限），客户端导入预览/确认/三种落库模式。

## C. 关键机制（改动前必读）

1. **双来源识别**：工作簿里有 `_元信息` 表 → 平台导出（`source: 'platform-export'`，
   按 `_id`/`_parentId` 精确还原层级）；否则 → 钉钉/通用表（按表头智能映射）。
2. **`_id` 沿用**：平台导出的行带 `_id`，`idGen.prefer()` 原样沿用，
   保证「导出 → 改一改 → 导回」记录身份不变（外部关联挂在 id 上）。
   只有钉钉表/异源表才现生成 id。
3. **`linkParents`**：`_parentRow` 是 **rows 数组下标**不是行号，`-1` 表示根。
4. **表 → 表单归属打分**：信号 2/3 必须建立在 `exLead >= 2` 之上，
   否则「状态」这种通用列会让「应收账款」这类表被静默绑成参考文档。
5. **预览页字段**：`filledKeys` 在 `renderImportPreview` 内计算；
   `bindImportPreview` 的 radio 回调里需**重新调用 `importCounts()`**，
   不能引用前者（不同函数作用域）。
6. **落库三模式**：`new` / `append`（重编号后并入）/ `overwrite`（二次确认，
   逐表显示「原有 N 条 → 换成 M 条」，`confirmClass: 'danger'`）。

## D. 踩过的坑（本会话新增，务必别再踩）

1. **`linkParents` 静默丢层级**：原实现只把 `_parentRow >= 0` 的行登记进 `byRowIdx`，
   于是挂在**下标 0 的根行**下的子行找不到父，`parentId` 静默变空。
   钉钉的 `Parent Record` 第一行走的正是这个坑。修复后真实文件从 0 个子节点
   恢复为 **129 根 / 744 子，零孤儿**。**教训：下标索引表要登记每一个下标。**
2. **`renderImportPreview` 引用未定义的 `keys`**：`keys` 只在 `applyImport` 里存在。
   后果是预览页一渲染就抛 `keys is not defined`，整页白。
   这个是**用 vm 探针实跑渲染才炸出来的**，`node --check` 查不出（语法合法）。
   **教训：客户端渲染函数必须真跑一遍看输出，光做语法检查不够。**
3. **vm 沙箱探针要插在 `return` 之前**：`index.js` 末尾是
   `const PlanModule = (() => { ... return {...}; })();`，
   在 `})();` 前追加代码**永远不会执行**（在 return 之后）。
   正确做法是锚定 `if (!window._planApi) window._planApi = api;` 这一行做替换。
4. **`/tmp` 不跨 Bash 工具调用共享**：每次调用都是新的临时目录。
   需要在多次调用间传递的 fixture 要写在仓库内（用完记得删）。
5. **Git Bash 下 `curl --data-binary @/tmp/x.json` 路径翻译失败**：
   改用 `node -e` + `fetch` 发请求。
6. **服务器端口冲突**：`PORT=8791 node server.js 8791 &` 会因旧进程占用报 EADDRINUSE，
   还会连带杀掉外层 shell。改用子 shell：`(node server.js 8794 > log 2>&1 &)`。
7. **SheetJS 对某些 xlsx 会刷 `Bad uncompressed size` 警告**：无害的 zip 噪声，
   断言脚本要 `grep -v "^Bad"` 过滤，别误判为失败。

## E. 安全铁律（未变）

- `data/iteration/state.json` **已被 git 跟踪**且含真实工时数据 —— **绝不提交**。
- **永远不要用 `git add .`**，只显式 add 具体文件。
- 钉钉/TB 凭据一律放 `data/**/secret.json`（已 ignore），**绝不入库**。
- 提交前先 `git status --short` 确认 `data/iteration/state.json` 处于未暂存状态。

## F. 下一步

1. 等用户交 `docs/samples/钉钉项目计划.xlsx` 与结构说明（2a 查漏补缺）
2. 等用户拍板三个决策（同步方向 / 行匹配方式 / 冲突优先级）—— **第 10 项是硬阻塞**
3. 等用户提供应用凭据 + 权限点名称 + 文档链接 + 网络连通性结论（2b）
4. 凭据到手后**第一步只写最小连通性验证**（换 token → 解析 docUrl → 读区间打印），
   **跑通之前不写任何同步逻辑**（TB 那次的教训）

---

# 交接文档 v3 — 2026-09-20（M1 地基 · 第 1 步已落地）

## A. 本轮做了什么

平台从「个人看板」升级为「多人协同 + AI 驱动的 PMO 工作台」。设计文档在
`docs/plan-ai-master.md`（**唯一权威主线**）、`docs/plan-ai-roadmap.md`（底稿）、
`docs/plan-ai-m1-foundation.md`（M1 落地设计）。

**M1 第 1 步（身份 / 权限 / 审计的地基）代码已完成**：

| 文件 | 状态 | 说明 |
|---|---|---|
| `db.js` | 新增 | `node:sqlite` 连接 + users/sessions/audit_log/permissions/meta 五张表 |
| `audit.js` | 改写 | 底层切到 SQLite；**`log()` / `getRecent()` 签名不变**，调用方零改动 |
| `_db-test.js` | 新增 | 6 个用例，`node --test _db-test.js`，全绿 |
| `server.js` | 小改 | 启动时开库 + 迁移旧审计 + 首次打印管理员口令 |
| `.gitignore` | 小改 | 忽略 `data/platform.db*` |

**未动**：模块业务数据仍写各自 `data/<模块>/state.json`（见下面第 4 条坑）。

## B. 为什么是「混合存储」而不是全量换库

实测数据：280 KB 的 `data/iteration/state.json` 全量「读→改→写」= **约 7 ms**。
所以「JSON 慢」这个假设是错的，**性能不是换库的理由**。
真正的缺口是 JSON 做不了的：按人/按条件查询、追加写、长期留痕。
结论——**只有身份/权限/审计进库，业务状态继续用 JSON**。

## C. 本轮踩过的坑

8. **注释里的 `*/` 会提前闭合块注释**：`db.js` 开头写
   `modules/*/routes.js` 当说明，其中的 `*/` 直接终止了 `/* ... */`，
   后面整段中文被当成代码 → `SyntaxError: Unexpected identifier '的'`。
   写路径通配符时改用 `各模块 routes.js`，别在块注释里出现 `*/`。
9. **迁移「新在前」的旧文件必须倒序插入**：旧 `audit-log.json` 是倒序数组，
   而 SQLite 的 `id` 是自增、查询按 `ORDER BY id DESC`。
   若正序插入，**最新的记录会拿到最小的 id、排到列表最末**，看起来像日志错乱。
   改成 `old.slice().reverse()` 后才对齐。**教训：迁移时要同时对齐「顺序语义」，不只是「内容」。**
10. **`node:sqlite` 是 experimental**：启动会打 `ExperimentalWarning`，属正常噪声。
    所有 SQL 已收敛在 `db.js` 内，将来换 `better-sqlite3` 只改这一个文件。
11. **Git Bash 里 `curl -d '{"by":"中文"}'` 会把中文按 GBK 转码**，
    存进库是 `Ǩ����֤` 这种乱码 —— **是测试方法的问题，不是代码问题**。
    验中文写入要用 `node -e` 发 UTF-8 请求（同第 5 条）。

## D. 安全铁律（新增一条）

- `data/iteration/state.json` **已被 git 跟踪**且含真实工时数据 —— **绝不提交**。
- **永远不要用 `git add .`**，只显式 add 具体文件。
- 钉钉/TB 凭据一律放 `data/**/secret.json`（已 ignore），**绝不入库**。
- **新增：`data/platform.db` 含口令哈希与审计记录 —— 已 ignore，绝不入库。**
  首次启动打印的 admin 口令只出现一次，看到就记下来。

## E. 下一步（M1 剩余）

> **执行口径已迁到 `docs/plan-ai-m1-tasks.md`**（SGAI+ 施工单），本节只留结论。
> 那份文档里写了：给 SGAI+ 的修正意见、剩余任务、分支与提交规范、踩坑累计、安全铁律。

1. ~~`modules/auth/routes.js`：登录/登出/`/api/auth/me` + session cookie~~ ✅ `18f0bd0`
2. ~~前端登录页；`platform.js` 的 `whoami()` 改成读 `/api/auth/me`~~ ✅ `18f0bd0`
3. 权限矩阵接进 `module-loader.js`（每模块自带 `resource`，干掉 `server.js` 里的 `PREFIX_RESOURCE` 平行表）
4. 部署脚本 + 备份 + 运行手册

---

# 交接文档 v4 · M1 步骤2（真登录 + 权限门禁）

## A. 本轮做了什么

提交 `18f0bd0`（M1 步骤 2）+ `docs/plan-ai-m1-tasks.md`（SGAI+ 施工单）。

**身份不再是浏览器里的一串字符。**

新增两件：
- `modules/auth/routes.js` —— 服务端身份的唯一来源。登录/登出/改口令/用户管理/查权限；
  30 天 `HttpOnly; SameSite=Lax` 会话 Cookie；登录失败统一回「账号或口令不正确」，
  不透露账号是否存在。导出 `currentUser()` / `can()` 给 `server.js` 复用。
- `login.html` —— 独立登录页，登录成功后清掉 localStorage 里的旧假身份。

`server.js` 加了一道 `gate()` 门禁：
- `AUTH_REQUIRED` 开关，**默认关闭**——升级到这版代码时现有部署行为一字不变
- 未登录：API 回 401 JSON、页面 302 到登录页带 `next` 回跳
- 越权：403，错误信息带所需权限名
- `GET`/`HEAD` 记读，其余一律按写（保守）
- 启动时 `purgeExpiredSessions()`

`platform.js`：`whoami()` 改为以服务端身份为准，新增 `refreshIdentity()` / `currentUser()` / `can()`。
**`whoami()` 仍是同步返回**，十几处调用点零改动；未启用登录时行为与从前完全一致。
`sync.js`：署名优先取平台身份并缓存一次，避免同一次填报里署名跳变。

## B. 为什么门禁放在 `server.js` 而不是模块加载器

原计划是「权限矩阵挂到 `module-loader.js` 的 `dispatch()`」，
实际做下来发现放在 `server.js` 更干净：`gate()` 在请求进入路由之前统一判，
**没有改任何模块的写路径**——原先估计的「第 3 步风险最高」因此降级。

代价是 `server.js:209-221` 多了一张手维护的 `PREFIX_RESOURCE` 平行表，
**新增模块忘了补行 = 该模块默认拒绝**。这个坑留给了下一步（步骤 3）。
放到 `module-loader.js` 才能根治。

## C. 本轮踩过的坑

12. **起点测试脚本会占着端口。** 起服务端测完要 `child.kill()`，且杀完**要等约 600ms**
    再起下一个，否则新服务抢不到端口——表现是「连不上」而不是报错，很容易误判成代码坏了。
13. **测异步断言别只断言「成功」。** 我第一次写的断言是「重启后应重新打印 admin 口令」，
    结果判定失败——但代码是对的：`takeInitialAdmin()` 取过就清空，口令只该出现一次。
    是断言写反了。**写断言前先确认自己期望的行为是不是真的对。**
14. **`node --check` 对 `.html` 无效。** 想验证 `login.html` 里的脚本语法，
    得把 `<script>` 里的内容抠出来单独 check，或者干脆靠端到端跑。

## D. 安全铁律（未变）

15. **`git add .` 一次都不能用** —— `data/iteration/state.json` 被 git 跟踪着，会被带走。
    提交前 `git diff --cached --name-only` 确认暂存区里没有 `data/`。
16. `data/platform.db`（口令哈希 + 审计）已 ignore。首次启动打印的 admin 口令**只出现一次**。

## E. 下一步

见 `docs/plan-ai-m1-tasks.md` 第 3 节。核心是：**把权限判定从 `server.js` 挪到模块自己身上。**


---

# 交接文档 v5 · 批2（登录/身份推进 + 抖动修复 + 钉钉认知纠偏）

> 日期：2026-09-21 ｜ 分支：`main`（不建分支，见安全铁律）
> 本轮核心：把「身份」从"十几人的个人工具"重新设计成"部门几百人可用"。

## A. 本轮做了什么

| 提交 | 内容 |
|---|---|
| `492dc95` | 修专项锁定页侧栏抖动（判定改为与动画无关的几何比较） |
| `9cf6546` | 新增 `user-cli.js` —— 账号维护/口令重置的终端兜底 |
| `e020925` | 新增 `docs/plan-dingtalk-sso.md` + `check-network.js` + ops-manual 批量建号一节 |

**`docs/plan-dingtalk-sso.md` 是身份这条线的唯一权威执行依据**，决策已全部拍板（D1–D9），
分 P0/P1/P2 三阶段。**执行者读它，不用再读本文档猜。**

## B. 关键决策（已在 sso 文档拍板，此处只列结论）

| # | 结论 |
|---|---|
| D1 | 工号当 `users.id`，钉钉 userId 存 `dingtalk_id`，姓名只用于显示 |
| D2 | 默认口令 = 姓名缩写 + 固定后缀（**不按入职时间做复杂规则**） |
| D3 | **不强制改密**，只给可关闭提示（用户明确要求） |
| D4 | 口令规则放配置文件，**不写死在代码里**（代码进 git） |
| D5 | 第一阶段用纯内网 IP，域名不阻塞上线 |
| D6 | 先只做 P0（工号+口令），钉钉接口不阻塞 |
| D7 | 钉钉接入顺序：P1 通讯录 → P2 扫码 |
| D8 | 自动建号**一律 viewer**，角色只在平台里改，不被钉钉覆盖 |
| D9 | 离职对账自动停用 |

**表结构已预留**：`users.dingtalk_id` + `password_hash` 可 NULL —— **P0/P1 零 schema 改动**
（唯一例外：P0 要加 `users.pwd_is_initial` 列用于"初始口令"提示）。

## C. 本轮踩过的坑（务必别再踩）

17. **`set VAR=1` 是 cmd 语法，PowerShell 里必须写 `$env:VAR=1`。**
    PowerShell 对未知变量的 `set` **静默返回空、不报错**，于是 `set AUTH_REQUIRED=1` 看起来成功、
    实际什么都没设，`AUTH_REQUIRED` 仍是 undefined → 门禁不生效 → 用户以为"登录功能没做"。
    **这个坑让用户来回试了两轮。** 跨 shell 安全写法：
    `cmd /c "set AUTH_REQUIRED=1&& node server.js 8770"`
    **写 Windows 启动指引时，先确认对方用的是 cmd 还是 PowerShell。**

18. **别用"当前是否出现滚动条"判断拥挤 —— 那是在测量动画。**
    侧栏有 0.25s CSS 宽度过渡，过渡期间 iframe 变宽、容器 `clientWidth` 每帧都在变，
    而 `scrollWidth`（内容固有宽度）不变 → **同一张表在动画早期判"挤"、晚期判"不挤"**
    → 连续发出 `autoCollapseSidebar` / `restoreSidebar` → 侧栏可见地抖。
    **正解：量内容固有宽度（`.scroll` 容器的 `scrollWidth`），与侧栏状态无关。**

19. **恢复门限必须和收起门限用同一把尺子，否则震荡不收敛。**
    我第一版把恢复条件写成"放得下收起后的宽度"，对一张真正超宽的表
    （1240px 内容 / 1440px 视口）会出现两个判定**同时成立**：收起后放得下（1316px）、
    展开时放不下（1156px）→ 收起→恢复→又收起，**永远不收敛**。
    **实测：1440 视口下 1181~1316px 区间就是这个死循环。**
    正解：恢复 = 「当初让我收起的那条理由已经不存在了」，用同一个 `availableWidth(vw, false)`。
    **验证方式：写个纯函数模拟循环，5 视口 × 14 内容宽度全跑一遍，比在浏览器里肉眼看靠谱得多。**

20. **别把用户的手动态在每次渲染时重置。**
    `switchView()` 和 `renderAll()` 里各有一行 `noAutoCollapse = false;`，
    导致用户手动展开侧栏后，一点 Tab 就被忘掉，自动收起又来了 —— 跟用户对着干。
    **"用户手动做过选择"这类状态，只在会话/视图真正切换时才重置，不能挂在渲染路径上。**

21. **Windows/Git-Bash 下 `sed -i` 会报 `Invalid cross-device link`**，
    `node -e` 做字符串替换也可能因 **CRLF vs LF** 静默不匹配（我遇到过"removed bytes: 0"）。
    **改代码一律用编辑工具，别用 `sed -i` 或 `node -e` 拼字符串。**

22. ⭐ **钉钉「快捷应用」≠「企业内部应用」—— 这是个认知陷阱。**
    创建内部应用需要钉钉的**「开发者权限」**，普通成员只能建"快捷应用"。
    两者的关键差别：

    | | 企业内部应用 | 快捷应用 |
    |---|---|---|
    | 有 appKey/appSecret | ✅ | ❌ |
    | 能申请权限点 | ✅ | ❌ |
    | 能调 OpenAPI | ✅ | ❌ |
    | 本质 | 独立应用 | **只是个链接卡片** |

    **踩坑表现**：花时间在后台翻遍了也找不到"权限管理"入口 →
    误以为自己操作错了，实际是**根本没这个权限**。
    **快捷应用不是白建的** —— 它能当平台在钉钉工作台里的入口卡片，零申请零审批。

23. **"文档变更实时同步"这条路，权限点和文档链接的选择比代码难。**
    Teambition 那次的教训再强调一次：**钉钉后台的权限点名称与接口路径不是一一对应的，
    必须让用户在后台把显示的全名原样抄回来，不能凭猜。** 猜名字去申请 = 白跑一趟。

## D. 安全铁律（本轮新增一条）

24. **`data/skill/state.json` 含真实产能/偏差分析结果，已补进 `.gitignore`。**
    本轮发现它是**未忽略**状态且已积累 108KB 真实数据 —— 若有人执行 `git add .` 就进仓库了。
    **新增任何模块后，第一件事是确认 `data/<模块>/state.json` 进了 gitignore。**

25. **`NODE_TLS_REJECT_UNAUTHORIZED=0` 是这台机器的系统环境变量**，
    等于**全局关闭 HTTPS 证书校验**。当前不阻塞开发，但：
    - 部署到服务器前必须处理（装公司根证书 + 恢复校验）
    - `appSecret` 要经这条链路传给钉钉，一直关着等于裸奔

**沿用（未变）**：
- **`git add .` 一次都不能用** —— `data/iteration/state.json` 被 git 跟踪且含真实工时
- 提交前 `git diff --cached --name-only` 确认暂存区没有 `data/`
- `data/platform.db`（口令哈希+审计）、`data/dingtalk/secret.json`、`data/auth-config.json` 一律不入库

## E. 现状与下一步

**并行开发中**：另一会话（SGAI+）正在做 M2 的 AI Skill 运行时
（`modules/skill/`、`dataflow.html`、`db.js` 加 `skill:*` 权限、`server.js` 路径穿越修复）。
**这份 handoff 不代表它的进度**，需要时直接问它或看 `git status`。

**P0 待做（无外部依赖，可立即开工）**：
1. `user-import.js` 批量建号脚本（含 `--dry-run`，见 sso 文档 §2.2）
2. `data/auth-config.json` 口令规则配置（已 gitignore）
3. `users.pwd_is_initial` 列 + 首次登录提示横幅
4. `docs/ops-manual.md` 补「批量建号」（✅ 已补）与「初始口令」两节

**等公司侧**：开发者权限 → 企业内部应用凭据 → 最小连通验证脚本 → 才动 P1。
**Teambition 教训：拿到凭据后第一件事是写最小连通脚本跑通，跑通之前同步逻辑一行都不写。**

---

# 交接文档 v6 · 批3（P0 收口 + 「今日待确认」入口 + 三处静默 bug）

> 日期：2026-09-22　分支：`dev/sgai`（提交 `1981116` 之前）
> 本轮起点是用户的一句反馈：**「我目前还没看到任何可验收可视化的产物」**。
> 这句话定义了这一轮的全部工作。

## A. 本轮做了什么

### A1. P0 六项（已推送 `889a97d`）
`user-import.js`（含 `--dry-run`）、`data/auth-config.json`、`users.pwd_is_initial`
+ 首登横幅、`ops-manual.md` §2.4、`start.bat` 注释、全链路验收。
实测：干跑 → 真导入（新建 5 / 跳过 0 / 失败 0）→ 重跑全跳过 → 初始口令登录
返回 `isInitialPwd:true` → 改口令后 `false` → 新口令复登成功。

### A2. 修掉「看不见」的四条根因
用户的抱怨不是错觉，是四件事叠加：
1. `auth` / `pradapter` / `skill` / `tb` 四个模块**只有服务端没有 UI**；
2. `Platform.init()` 只注册了 5 个模块；
3. **`dataflow.html` 没有任何入站链接** —— 页面存在，但等于不存在；
4. 权限播种 bug（见 C-26），`dataflow.html` 上每个接口都返回「没有权限」。

修了 3、4，并顺势补上 1、2 里最该有的那个入口（A4）。

### A3. `seedPermissions()` 从「按角色跳过」改为「按权限点逐条补齐」（`45cfe48`）
见 C-26。这是本轮最大的一处发现。

### A4. 新增 `modules/inbox/` ——「今日待确认」（`4dc54a6`）
路线图把 AI PMO 的落地形态定为**「一个需要人点确认的待办」，不是「一堆需要人去读的报告」**。
此前 `skill` 模块只能按 Skill 逐个点进去看，跨 Skill 有没有事、今天要不要动手，用户无从得知。

- `GET /api/inbox`：跨 Skill 聚合所有 `pending` 项，按严重度排序（high → medium → low，同级按时间倒序）
- `POST /api/inbox/confirm`：采纳/驳回，**写入口径一律走 `skill` 引擎的 `confirm()`** ——
  采纳率是唯一诚实指标，分母只能有一处维护，不另起一套状态机
- 页面：顶部数字条（待确认 / 其中高风险 / 累计采纳率）、各 Skill 状态行、待确认卡片、**侧栏红点**
- 权限：`inbox:read` / `inbox:write`（pm 读写，dev/viewer 只读）
- 自检 `_test-inbox.js`：21 项通过

## B. 为什么「今日待确认」要单独做一个模块，而不是塞进 dataflow.html

`dataflow.html` 是**运维视角**：仓库采集正不正常、告警有没有、Skill 跑没跑。
它回答的是"这套东西活着吗"。

用户（PM）每天要回答的是另一个问题：**"今天要你拍板的 N 件事是什么？"**

两者受众、频率、心智都不同：运维页一周看一次，待确认页一天开一次。
更关键的是 —— 待确认项要**能一级入口直达**、要有**红点提醒**、要**排在业务模块之前**，
这些都是 `dataflow.html` 这种独立整页给不了的（它进了 SPA 就破坏"自带脚本"的设计）。

所以：`dataflow.html` 保留为运维/调试页（侧栏 footer，新标签打开）；
`inbox` 做成正式模块（侧栏正区、order=1、带红点）。

## C. 本轮踩过的坑（含新发现的静默 bug）

26. ⭐⭐ **`seedPermissions()` 原来是按「角色」整体跳过，新增权限点永远进不了旧库 —— 而且全程不报错。**
    原写法 `if (has.get(role).n > 0) return;` 的意思是「该角色一行都没有才播种」。
    这个库建于 2026-09-20，那时 `skill:*` / `pradapter:*` 还不存在；等它们加进
    `DEFAULT_PERMISSIONS` 时，pm/dev/viewer 早就"已有行"，于是**整批跳过**，
    新权限点一条都没落库。
    **表现**：`permissions` 表看着完全正常（29 行），但 `dataflow.html` 上每个接口都返回
    `{"error":"没有权限：skill:read"}`，症状与"功能没做"完全一样，极难排查。
    **正解**：逐条 `INSERT OR IGNORE`。
    - 新库：行为与从前一致
    - 旧库：只补缺失的权限点，已存在的行不被动
    - 管理员手动改成 `allowed=0` 的行**也不会被重置**（`OR IGNORE` 不覆盖已存在行）
    实测：权限行 29 → 37，`/api/skill` 恢复返回真实数据。
    **教训：凡是「只在首次初始化时写一次」的种子逻辑，都要问一句「以后新增的条目怎么办」。**

27. ⭐ **严重度值中英混用，导致 5 条高风险全部沉底、高风险计数恒为 0。**
    `risk.js` 发的是中文 `'高'/'中'/'低'`；`report.js` / `variance.js` 的待确认项
    **压根不带 severity**，引擎 `normalizeItems` 用 `o.severity || ''` 兜底，再被下游
    当成 `medium`。下游排序表只认英文 `high/medium/low`，于是中文「高」被当作**未知值**
    排到最后 —— 页面看上去「一条严重的都没有」，而那 5 条恰恰是最该先看的。
    **正解**：在引擎 `normalizeItems` 里收敛成唯一一套 canonical 值，中文别名照收。
    **引擎是唯一的生产者，严重度就该由一处定义，不能由各 Skill 各自发挥。**
    改完 `_test-skill.js` 47 项全量复跑通过，未打破既有断言。

28. ⭐ **输入采集失败时静默产出空结果 —— 比报错危险得多。**
    我在裸 node 里跑 `engine.run()` 想让存量项套用新的归一化，结果三个 Skill 全部产出 0 项，
    把 **82 条待办一次性全标成了 `expired`**。
    根因：`calc.js` 依赖由 `server.js` 注入的全局 `TEAMS`，裸 node 里没注入 →
    `ReferenceError` 被 `collectInputs` 的 `catch (e) { /* 偏差为空 */ }` 吞掉 →
    `deviations=[]` → 所有偏差类结论为空，但 Skill 报告的是 **"运行成功"**。
    用户看到的是「今天没风险」，真相是「输入压根没采集到」。
    **已改为显式 `console.warn` 并提示常见原因。**
    **教训：`catch` 里写注释而不是写日志，等于把故障藏起来。降级可以，沉默不可以。**
    **恢复办法**：注入 globals 后重跑，`deviations` 回到 18，三个 Skill 恢复正常产出。

29. **`platform.js` 已经有 `setBadge()`，别在模块里自己写一套徽标逻辑。**
    我第一版在 `inbox/index.js` 里手写了 `updateBadge()` 直接操作 DOM，
    而 `Platform.setBadge` 本来就是公开 API（`return { ..., setBadge, ... }`）。
    徽标的显示/隐藏规则只该有一处实现，已改回调用平台 API。

30. **headless Chrome 截图这条路在这台机器上走不通**（`--screenshot` 挂住，120s 超时被挪到后台，
    最终无产物）。**别再花时间在这上面**：用户本来就能自己打开页面看，
    "让用户能自己打开看"比"我截图给用户看"更根本 —— 这也是本轮把力气花在**入口可见性**
    而不是截图上的原因。

## D. 安全铁律（未变，重申）

**沿用（一条都没放松）**：
- **`git add .` 一次都不能用** —— `data/iteration/state.json` 被 git 跟踪且含真实工时
- 提交前 `git diff --cached --name-only` 确认暂存区没有 `data/`
- `data/platform.db`（口令哈希+审计）、`data/dingtalk/secret.json`、`data/auth-config.json`、
  `data/skill/state.json` 一律不入库
- 新增任何模块后，第一件事是确认 `data/<模块>/state.json` 进了 `.gitignore`

## E. 现状与下一步

**已推送**：`889a97d`（P0 六项）→ `45cfe48`（权限播种 + dataflow 入口）→
`4dc54a6`（inbox）→ `1981116`（施工单）。均推在 `dev/sgai`，等用户验收。

**用户可以现在就验收的**（无需任何部署）：
1. `AUTH_REQUIRED=1 node server.js 8770`（PowerShell 见 `start.bat` 注释）
2. 登录 → 侧栏**「📥 今日待确认」**（带红点，显示待办数）
3. 侧栏 footer **「🔄 数据自动流入」**（新标签，运维/调试页）

**已知缺口（未解决）**：
1. **`data/pradapter/config.json` 里 `teams: []` 为空** → 偏差表的「佐证」列会显示 `—`。
   这是 SGAI+ 的设计（未配置映射时不产生"无佐证"噪音），**不是 bug**，
   但要填真实仓库→团队映射后才有内容。
2. **M2-C 等用户输入**：C1 真实仓库路径；C2 团队工作台对接契约。
3. **`data/iteration/state.json` 的 `deviations` 依赖全局 `TEAMS`** ——
   任何脱离 `server.js` 的入口（CLI、定时任务、测试）都必须自己先注入 `config.js`，
   否则会静默产出空结果（见 C-28）。这是当前最容易被再踩一次的坑。

**待用户手动删除**（我的 `rm` 被权限系统拒绝）：
`.tmp-adv*.js`、`.tmp-adv2dir/`、`.tmp-adv3dir/`、`.tmp-adversarial/`、
`.tmp-import-test/`、`_dbg-*.js`

**未跟踪且按用户指示保持不跟踪**：`钉钉开发/`（含应用信息，仅供我参考）、
`AI项目管理新范式思路.txt`
