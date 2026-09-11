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
