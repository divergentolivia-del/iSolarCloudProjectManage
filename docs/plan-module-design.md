# 「项目计划」功能完整设计规格书

> 写给 Kiro 的实现文档。目标：Kiro 只看本文档 + 现有模块即可独立完成代码，无需向用户反复追问。
> 本文档覆盖：功能定位、架构约定、数据模型、服务端路由、客户端五视图、交互细节、样式规范、跨模块集成、以及「左侧功能栏图标重设计」。
> **已存在的产物**：`modules/plan/routes.js`（服务端路由，本次已写完且完整可用，见 `§4`）。客户端 `index.js`、样式 `plan.css`、平台集成（`platform.html` / `router.js`）需 Kiro 新增。

---

## 0. 读此文档前必读

本项目是「云平台管理工作台」，代码在 `E:\PMWork\Project Materials\iSolarCloudProject\迭代版本\iSolarCloudProjectManage`，git 分支 `feat/tb-sync-stage2`。

平台是一个多模块 SPA，后端 Node（原生 `http`，无 express），前端原生 JS + CSS。**新增一个功能模块 = 新增一个 `modules/<name>/` 目录**，遵循既有约定。

**四条铁律（务必遵守）：**

1. ❌ **禁止改动** `data/iteration/state.json`（真实 TB 工时历史数据）。项目计划模块的数据完全独立在 `data/plan/state.json`。
2. ✅ 项目计划的所有写操作只走 `POST /api/plan/state`，带乐观锁 `baseRev`。
3. ✅ 延续现有设计语言：浅灰背景 + 白色圆角卡片 + 柔和阴影 + 胶囊状态点 + 细化进度条 + `tabular-nums`，**不要工业风/理工男硬风格**。
4. ✅ 用户前期反复强调的三条体验硬指标，本模块必须全部满足（这是验收点）：
   - **输入框不截断**：工作量大数字（人天，可 5–6 位）、结论长文本，输入控件要 `min-width` 足够、允许横向滚动或自动换行，不能 `overflow:hidden` 把最右一位裁掉。
   - **平铺/完整展示**：数据全量平铺，不隐藏、不省略号截断关键字段。
   - **页面滑动/自适应**：宽表（任务表、甘特图）在页内容器内**横向滚动**（`overflow-x:auto` + `min-width`），不撑破布局；侧边栏拥挤时自动折叠（已有能力，阅读 `platform.css` 的响应式折叠即可，不要破坏）。

---

## 1. 功能定位

**「项目计划」= 对一个具体软硬件智能产品做项目管理级执行计划。** 站在高级 PM 视角，覆盖五大模块：

| # | 名称 | 做什么 |
|---|------|--------|
| 1 | 任务 WBS | 把工作拆解成树形任务（可按阶段/能力分组），记录计划工时(人天)、进度、起止、负责人 |
| 2 | 里程碑 | 关键节点（立项/原型/联调/上线/转产），带状态与日期 |
| 3 | 资源 | 团队 + 人员的产能投入，识别超载 |
| 4 | 甘特图 | 任务时间轴（泳道、时段条、进度填充、依赖箭头） |
| 5 | 高管视图 | 本地规则计算的指挥舱：整体进度环、里程碑达成、团队负载、风险清单 |
| 6 | AI 入口预留 | 先做「规则替代」，预留真正 AI 的挂载点 |

**数据独立性（已与用户确认）**：计划数据完全自持，**不强依赖**全年度项目管理（csenergy）。提供可选 `projectId` 弱关联，仅在详情页展示一个可点击的跳转链接。

---

## 2. 平台机制（新增模块必须遵守的约定）

### 2.1 服务端自动发现（`module-loader.js`）
- 扫描 `modules/*/routes.js`，`require` 得到 `{id, prefix, handle, ensureData?}`。
- `prefix` 全局唯一；按 prefix 长度降序匹配 `pathname === prefix || pathname.startsWith(prefix+'/')`。
- 每个模块在启动时调用一次 `ensureData()`。
- **结论：新增模块只需放 `modules/plan/routes.js`，`server.js` 一行都不用改。**

### 2.2 静态目录保护（`server.js`）
- 以 `DATA_DIR` 开头的静态请求一律 `403`。
- **结论：`data/plan/state.json` 不会被直接下拉，只能通过 `GET /api/plan/state` 读取。**

### 2.3 客户端模块契约（`ModuleDefinition`，IIFE 返回纯对象）
```js
return {
  id: 'plan',            // 与路由 prefix 后缀一致
  name: '项目计划',
  icon: '<emoji/表达式>', // 见 §7 图标重设计
  order: 3,              // 左侧栏排序，dashboard:0 iteration:1 csenergy:2 → plan:3
  sidebar: true,
  init(el, context) {},  // 首次挂载；context.subPath 为 URL 片段
  enter(subPath) {},     // 切到本模块时调用；据 subPath 渲染（详情/编辑/列表切换）
  leave() {},
  getSummary() {}        // 供首页 dashboard 汇总卡片用
};
```

### 2.4 集成接入点（3 处）
1. `platform.html`：
   - `<head>` 加 `<link rel="stylesheet" href="modules/plan/plan.css?v=20260901c">`
   - 模块脚本区加 `<script src="modules/plan/index.js"></script>`
   - `Platform.init([...])` 数组末尾追加 `PlanModule`
2. `router.js` `buildBreadcrumb(moduleId, subPath)`：加一个 `plan` 分支（见 §6.4）。
3. （可选，增强）`modules/csenergy` 项目卡片加「查看计划」链接跳 `#/plan/detail/<planId>`。这是加分项，非必须。

### 2.5 数据读写约定（照抄 csenergy 模式）
只读状态 `/api/plan/state`，汇总 `/api/plan/summary`，写状态用乐观锁：
```
POST /api/plan/state
body = { baseRev: <当前state.rev>, state: <新state>, by: <用户名> }
```
- 返回 `200 {ok, rev, updatedAt}`；`409` 表示被他人改动 → 前端 toast「数据冲突，请刷新后重试」；`400` 带校验错误。

---

## 3. 数据模型（存于 `data/plan/state.json`）

顶层：
```json
{
  "rev": 0,
  "updatedAt": "",
  "updatedBy": "",
  "plans": [ ... ]
}
```

### 3.1 Plan（计划）
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | `plan-<timestamp36>` |
| `name` | string | 计划名，必填 |
| `year` | number | 计划年度，默认当前年 |
| `status` | enum | `draft`/`active`/`completed`/`archived` |
| `owner` | string | 计划负责人（PM） |
| `productLine` | string | 产品线（阳光云/乐充云/平台共性） |
| `projectId` | string? | 可选：关联 csenergy 项目 id |
| `projectName` | string? | 冗余展示名 |
| `description` | string | 一句话概述 |
| `startDate`/`endDate` | string? | `YYYY-MM-DD`，计划总窗口 |
| `tasks[]` | array | WBS 任务，见 3.2 |
| `milestones[]` | array | 里程碑，见 3.3 |
| `resources[]` | array | 资源，见 3.4 |
| `aiConfig` | object? | **AI 入口预留**，见 3.5 |

### 3.2 Task（WBS 任务）
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | `task-<timestamp36>` |
| `parentId` | string? | 父任务 id，构成树；顶层留空 |
| `name` | string | 任务名 |
| `phase` | string | 阶段分组（需求/设计/开发/测试/发布/转产…） |
| `status` | enum | `not-started`/`in-progress`/`completed`/`blocked` |
| `priority` | enum | `high`/`medium`/`low` |
| `plannedHours` | number | 计划工时（**人天**，可为 5–6 位大数） |
| `progress` | number | 0–100 整数 |
| `startDate`/`endDate` | string? | `YYYY-MM-DD` |
| `owner` | string | 负责人（任务维度） |
| `dept` | string | 主责部门 |
| `deps[]` | string? | 依赖的前置任务 id 列表（甘特箭头用） |
| `deliverable` | string | 交付物/成果 |

### 3.3 Milestone（里程碑）
`id`、`name`、`date`(`YYYY-MM-DD`)、`status`(`pending`/`in-progress`/`done`)、`note`。

### 3.4 Resource（资源）
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | `res-<timestamp36>` |
| `name` | string | 团队名或个人名 |
| `kind` | enum | `team`/`person` |
| `dept` | string | 部门 |
| `team` | string | 所属团队（用于聚合） |
| `total` | number | 可用产能（人天） |
| `used` | number | 已占用产能（人天） |

### 3.5 aiConfig（AI 入口预留，一期只存配置，不调真 AI）
```json
{
  "provider": "",                  // 预留：未来公司可控模型端点
  "model": "",
  "enabled": false,
  "lastRunAt": ""
}
```

---

## 4. 服务端路由 `modules/plan/routes.js`（⭐ 已完成，Kiro 可直接用）

本文件**已经写完且完整可用**。Kiro 无需重写，只需确认存在并在 `§6` 集成。其契约：

- `ensureData()`：确保 `data/plan/`、`data/plan/history/` 存在；仅当 `state.json` 不存在时写空态 `{rev:0,...plans:[]}`。**不会覆盖已有数据。**
- `GET /api/plan/state` → 完整状态（含乐观锁 rev）。
- `GET /api/plan/summary` → 每计划的执行汇总 + 顶层聚合 `agg`（见 §5 高管视图字段）。
- `POST /api/plan/state` → 校验（枚举、日期、进度 0-100、工时非负、id 唯一、嵌套任务/里程碑/资源检查）→ 乐观锁合并 → 写文件 + 快照 `history/plan-rev<n>.json` → `global._broadcast` → 返回。
- 校验规则（Kiro 无需改动，直接使用即可）：计划/任务/里程碑/资源的枚举值与 id 唯一性、日期格式与大小关系。

> 如果 Kiro 想从零重写也行，但**必须保持**：路由前缀 `/api/plan`、四个端点、乐观锁语义、校验字段与 §3 数据模型一致、`ensureData` 不覆盖现有数据。

---

## 5. 客户端视图设计（`modules/plan/index.js`）

### 5.0 顶层状态
```js
let container, state, summary, plansById;
let currentView = 'list';   // list | detail | new | edit
let currentPlanId = null;
let planDetailTab = 'wbs';  // wbs | gantt | milestone | resource | exec | ai
```

### 5.1 路由与视图映射（`applySubPath`）
| subPath | 视图 |
|---------|------|
| 空 / `list` | 计划**列表（卡片平铺）** |
| `detail/<planId>` | 计划详情（含 6 个子 Tab） |
| `new` | 新建计划表单 |
| `edit/<planId>` | 编辑计划表单 |
| 其他 | 回退到 `list` |

### 5.2 列表视图（平铺卡片）
- 顶部：标题 + `+ 新建计划` 主按钮 + 年度切换/筛选。
- 汇总指标条（复用 `SharedUI.renderMetricCard`）：计划总数、进行中、总任务数、总人天、平均进度、风险数。
- 每计划一张卡片（平铺，白圆角卡）：
  - 左侧：计划名 + 状态胶囊 + 年度 + 负责人 + 产品线 + 起止窗口。
  - 右侧：**整体进度环**（SVG 环形，`renderDonut` 风格）+ 关键数字（任务 X/Y 完成、里程碑 Z、风险 N）。
  - 一个「查看计划」主链接 → `#/plan/detail/<planId>`，一个「编辑」次链接。
- 空态：友好插图 + 引导文案 + 「新建第一条计划」按钮。

### 5.3 详情页（Tab 结构）
顶部统一：返回按钮 + 计划标题 + 状态胶囊 + 「编辑计划」按钮。
下方 6 个 Tab（`data-view`）：
```
WBS 任务 | 甘特图 | 里程碑 | 资源 | 高管视图 | AI 助手
```
点击 Tab 切换 `location.hash = '#/plan/detail/<planId>/<tab>'`（`detail/<id>/<tab>` 子路由）。

#### Tab A：任务 WBS
- 树形展示：顶层任务为一行，子任务缩进一行。渲染为表格，列：
  `任务名 / 阶段 / 状态(胶囊) / 优先级 / 计划人天 / 进度(进度条+%)/ 起止 / 负责人 / 交付物 / 操作`
- **操作**：新增子任务、编辑、删除、标记完成。
- 编辑用内联表单或 `SharedUI.confirm` 弹出小表单。字段见 §3.2。
- **体验硬指标**：`计划人天` 列宽要容纳大数（`min-width`），`任务名`/`交付物` 长文本列要有 `max-width` + 单元格内换行或 tooltip，**禁止省略号截断导致读不全**。外层表格用 `.table-wrapper`（`overflow-x:auto`）。
- 提供一个「+ 添加任务」主按钮 + 一个「从模板生成 WBS」次按钮（见 §5.6 规则生成）。

#### Tab B：甘特图
- 时间轴：按计划 `startDate~endDate` 定跨度（若缺省用全年）。顶部月份刻度。
- 每任务一行：左侧任务名（固定列），右侧泳道（相对定位）。任务时段条按 `(start-start)/(span)` 算 `left%`，`(end-start)/span` 算 `width%`。
- 条内填充进度（`width = progress%` 的二层条）；状态不同配色：未开始灰、进行中蓝、完成绿、阻塞红。
- 依赖箭头：`deps[]` 把前置任务右端 → 后继任务左端画一条线（SVG overlay 或绝对定位 div）。**一期可用简单折线，不追求完美贝塞尔。**
- **体验硬指标**：甘特容器自身横向滚动（任务多时），任务名列 `position:sticky; left:0` 固定，不撑破页面。

#### Tab C：里程碑
- 垂直时间线列表：节点 `done`(✅ 绿色) / `in-progress`(🔵 蓝) / `pending`(⚪ 灰)，过期未完成标红「逾期」。
- 操作：添加/编辑/删除/标记完成。字段见 §3.3。

#### Tab D：资源
- 统计卡：资源总数、超载数、总可用/已占用产能。
- 每资源一张卡：团队/人员 + 部门 + `used/total 人天` + **负载条**（`load = (used+任务owner工时)/total`，`>=100%` 标红，`<80%` 绿）。
- 负载映射：任务 `owner` 与资源 `name` 匹配累加，得到每个资源绑定的实际工时。
- 操作：添加/编辑/删除资源。

#### Tab E：高管视图（本地规则 = 「AI 助手」的规则替代版）
- **顶部 4 个指标卡**（`renderMetricCard`）：整体进度环 / 已完成任务率 / 里程碑达成 / 团队负载。
- **整体进度环**：大号 SVG 环，中心显示 `overallProgress%`，分段色（完成/进行/未开始）。
- **里程碑达成**：`done / total` 环 + 最近 5 个未达成里程碑列表（带日期，按时间升序）。
- **团队负载**：横向条形图（每资源一条），负载高者置顶。
- **风险清单**：从 §5.5 规则计算出的风险（逾期/阻塞任务 + 资源超载），卡片列表，按严重度排序。
- **周报骨架**：一键生成本周汇报提纲（规则生成，见 §5.6）。

#### Tab F：AI 助手（AI 入口预留）
- 一期**只做「规则替代」**，明确标注「本地规则生成，未接入模型」。
- 提供三类规则按钮：
  1. **从模板生成 WBS**（按 `productLine` + `phase` 模板生成任务骨架）。
  2. **资源缺口分析**（找出负载 > 100% 的资源 + 未分配 owner 的任务）。
  3. **本周周报骨架**（按本周完成/进行/风险/下周计划组稿）。
- 界面预留一块「接入模型后」的说明区（读 `aiConfig`，`enabled=false` 显示「待接入」）。
- **绝不**在这儿发起真实模型请求。

### 5.4 表单（新建 / 编辑计划）
- 用「二级页面」形式（参考 csenergy `renderProjectForm`）：顶部返回 + 标题 + `保存`/`取消`，主体为分区表单。
- 分区：**基础信息**（计划名*、年度、状态、负责人、产品线、关联项目[projectId 下拉，数据来自 `/api/csenergy/state` 若可读，否则留空]、起止日期）→ **概述**（description 多行）→ **AI 配置**（预留，只展示，不强制）→ **里程碑/任务/资源** 初始可留空（进详情页再补）。
- **体验硬指标**：所有输入框要够宽。数字输入（人天）`width` 足够容纳 5–6 位；多行文本（description）用 `textarea`。**不要用 `overflow:hidden` 的窄 input。**

### 5.5 高管视图规则计算（纯前端，不加后端负担）
数据取自 `GET /api/plan/summary` 返回的 `plans[i]`：
```js
{
  id, name, year, status, owner, projectId, projectName, startDate, endDate,
  wbs: {
    total, completed, inProgress, blocked, notStarted,
    sumHours, finishedHours, taskDoneRate, overallProgress, topLevel, phases
  },
  milestone: { total, done, inProgress, pending },
  resource: { load:[...], total, overloaded },
  risks: [ { type:'overdue'|'blocked', id, name, owner, endDate, progress, priority } ],
  upcomingMilestones: [ ... ],
  today
}
```
- `overallProgress` = 所有任务 progress 的平均。
- `risks`：任务 `endDate < today` 且未完成 → `overdue`；`status==='blocked'` → `blocked`。
- 资源超载：`load >= 100`。

### 5.6 规则生成（替代真 AI）
用 `SharedUI.confirm` 弹预览确认，非直接落库：
- **WBS 模板**：按 phase 顺序 push 预置任务（需求→设计→开发→测试→发布→转产），每阶段默认任务带 `plannedHours`、`dept`、`deliverable` 占位，用户可以编辑后再保存。
- **资源缺口**：扫 tasks 里 `owner` 无对应 resource，或 resource `load>=100`，列出给用户。
- **周报骨架**：拼字符串 `本周完成~ 进行中~ 风险~ 下周计划~`。

---

## 6. 集成细节

### 6.1 `platform.css`（图标重设计会动这块，勿重复）
```css
--sidebar-width:220px;  --sidebar-collapsed-width:60px;
```

### 6.2 `platform.html`
三处 + platform init：
```html
<link rel="stylesheet" href="modules/plan/plan.css?v=20260901c">
...
<script src="modules/plan/index.js"></script>
...
Platform.init([DashboardModule, IterationModule, ProjectModule, CsEnergyModule, PlanModule]);
```

### 6.3 `platform.js` 图标重设计（见 §7）
改 `renderSidebarNav()`：给 `nav-icon` 加一个**彩色圆角底块**，按模块 id 分配固定渐变/配色；每个功能的图标必须互不相同。

### 6.4 `router.js` buildBreadcrumb 加 `plan` 分支
```
plan   → '项目计划'（+ subPath）
detail/<id>/<tab> → '项目计划' / '详情' / '<Tab 名>'
new    → '项目计划' / '新建计划'
edit/<id> → '项目计划' / '编辑计划'
```

### 6.5 `server.js`
无需改动（module-loader 自动发现 + data/ 已屏蔽）。

---

## 7. 左侧功能栏图标重设计（附在当前任务里）

### 7.1 问题
当前 `renderSidebarNav()` 直接用 `m.icon`（纯 emoji）拼 `.nav-icon`。**iteration 与 csenergy 都是 `📊`**，视觉重复；全部图标是裸 emoji，简陋。

### 7.2 目标
- 每个可见功能一个**互不相同**的图标。
- 现代、克制、与现有 `.metric-card-icon`/`.entry-card-icon`（圆角色块）一致。
- 折叠态仍能显示（`width` 变化兼容）。

### 7.3 方案（保留 emoji 内核 + 彩色圆角底块）
平台全站用 emoji 作图标（nav/metric/tab），**不要只在侧栏引入 SVG**（会割裂）。做法：
1. 每个模块在 `ModuleDefinition` 增加可选的 `iconColor`（或内部映射表）。
2. `renderSidebarNav` 把 `.nav-icon` 改成：
   ```html
   <span class="nav-icon" style="--nav-bg:linear-gradient(135deg,<c1>,<c2>)">emoji</span>
   ```
3. `platform.css` 加 `.nav-icon { width:26px; height:26px; border-radius:8px; display:flex; align-items:center; justify-content:center; background:var(--nav-bg,#f0f2f5); box-shadow:...; }`——**折叠态**下 `width`/`height` 不变，仅去掉 label，图标仍是底块。
4. 顶部导航（navbar）现有 `⚙`/`🔔` 可顺带圆角化，保持一致（可选）。

### 7.4 图标表（互不相同 + 配色建议）
| 模块 | icon | 配色（渐变） | 说明 |
|------|------|--------------|------|
| dashboard | 🏠 | 蓝 | 首页 |
| iteration | 📚 | 青/绿 | 阳光云迭代项目（与 csenergy 的 📊 区分开）×原来 `📊` |
| csenergy | 📊 | 紫 | 全年度项目管理看板（保留） |
| **plan(新)** | 🗓️ | 橙 | 项目计划 |
| 系统设置 | ⚙ | 灰 | 静态 footer |
| 使用帮助 | 📖 | 灰 | 静态 footer |

> 强调：iteration 不用 `📊`（让给 csenergy），改成 `📚`/`🗂️` 任一；plan 用 `🗓️`（日历=计划），确保与其余全部不同。

---

## 8. 验收清单（Kiro 实现后自检）

1. ✅ `data/plan/state.json` 可创建；`GET/POST /api/plan/state`、`GET /api/plan/summary` 可用。
2. ✅ 新建→详情→各 Tab→编辑→删除 全链路无错。
3. ✅ 乐观锁：两窗口同时编辑，后提交者收到 `409` 提示。
4. ✅ **输入框不截断**（人天 5–6 位、长结论换行/tooltip）。
5. ✅ **平铺完整展示**（列表/详情数据不省略）。
6. ✅ **页面滑动/自适应**（宽表 + 甘特横向滚动，侧边栏拥挤自动折叠）。
7. ✅ 侧栏每个功能图标不同，均带彩色底块，折叠态正常。
8. ✅ 未触碰 `data/iteration/state.json`，未调用 `POST /api/tb/sync`。
9. ✅ 样式沿用平台 token（`--bg/--panel/--radius/--line/--accent`），自动适配明暗主题。

---

## 9. 风险与兼容

- **数据不迁移**：项目计划独立成 `data/plan/state.json`，与 csenergy/project 互不污染。可选 `projectId` 只在详情页出跳转链接。
- **AI 二期**：`aiConfig` 预留 + 规则替代一期；未来接公司可控模型端点，不改数据模型。
- **侧栏图标**：改 `renderSidebarNav` 不影响路由/高亮（`data-module` 不变）。
- **不破坏既有模块**：只新增 `plan` 三件套 + 改 `platform.html`(3处) + `router.js`(1分支) + `platform.css`(icon 样式) + `platform.js`(icon 渲染)。

---

## 10. 执行顺序建议（给 Kiro）

1. 确认 `modules/plan/routes.js`（已有）。
2. 写 `modules/plan/index.js`（客户端，最大件）。
3. 写 `modules/plan/plan.css`。
4. 改 `platform.html`（link + script + init）。
5. 改 `router.js`（breadcrumb）。
6. 改 `platform.js` + `platform.css`（侧栏图标重设计）。
7. 自检 §8 清单；`state.json` 加入 `.gitignore` 对应条目（`data/plan/state.json` + `data/plan/history/`），确保**不提交真实数据**。
8. 本地 `npm` 起服务验证 → `git push` 到 `origin/feat/tb-sync-stage2`。
