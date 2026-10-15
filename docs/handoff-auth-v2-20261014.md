# Handoff: 账号权限重构 v2 (2026-10-14)

## 一、本轮目标

账号管理从四档职能混角色模型（`admin/pm/dev/viewer`）收敛到三档纯访问级别（`admin/editor/reader`），配套二级权限矩阵（模块级授权）、新建用户表单（服务端密码生成）、服务端白名单拦截。

## 二、关键决策与踩坑记录

### 1. 角色收敛：为什么 `dev → reader` 不是 `editor`

**决策**：存储值一把改彻底，不留「显示名 ↔ 存储名」映射层。

旧模型 `dev` 在默认矩阵里是**零写权限**（比 `viewer` 看得还少，`viewer` 有 `budget:read`，`dev` 连它都没有）。从 `dev` 直接升到 `editor` 是**提权不是改名**——用户原话「你给 dev 改成 editor，那我 dev 角色的人不就成项目经理了？」

所以迁移路径：

| 旧值 | 新值 | 理由 |
|---|---|---|
| `admin` | `admin` | 不动 |
| `pm` | `editor` | 写权限集原样保留 |
| `dev` | `reader` | 旧矩阵零写权限，降级是对齐不是提权 |
| `viewer` | `reader` | 本就只读，直接映射 |
| 未知值 | 原样保留 + 告警 | 不猜 |

实现：`db.migrateRoles()` 用 `meta.role_model = 'v2'` 打标记保证幂等（第二次启动直接跳过）。

### 2. `seedPermissions()` 为什么不能按角色播种

**坑的由来（2026-09-22）**：早期 `seedPermissions()` 是按角色播种——先查这个角色有没有记录，有就跳过，没有就批量写。结果某次加新模块（`dataflow`）后，旧角色（`pm`/`viewer`）在 `permissions` 表里已有行，播种直接跳过，新模块的权限点静默漏掉，导致全站 `dataflow.html` 403。

**修复（db.js:149-162）**：改成**逐权限点 `INSERT OR IGNORE`**——不判断角色，只判断 `(role, resource, allowed)` 三元组存不存在，不存在才插入。这样加新模块时，旧角色会自动补上新模块的默认权限。

**本轮约束**：`migrateRoles()` 删掉了 `pm/dev/viewer` 三个旧角色的 `permissions` 行，`seedPermissions()` 的逐权限点写法会立刻把 `editor/reader` 的完整矩阵补齐。**这套逻辑必须保持，不要改回按角色跳过。**

### 3. `module-loader` 与 `auth` 的循环依赖

**问题**：权限矩阵要枚举「全部可授权资源」，资源清单从 `module-loader.listResources()` 汇总（模块注册表 + `BUILTIN_RESOURCE`）。如果 `modules/auth/routes.js` 在文件顶层 `require('../../module-loader')`，就会撞循环依赖：

- `module-loader.loadAll()` 会 require `modules/auth/routes.js`（加载模块时）
- 如果 auth 的 routes.js 顶层 require module-loader，它拿到的是**pre-assignment 的空对象**
- 而且 module-loader 用的是 `module.exports = {...}` 对象替换（不是 `module.exports.loadAll = ...` 属性追加），所以那个空对象永远是空的

**解法**：`module-loader` 必须在 `modules/auth/routes.js` 里**懒加载**——在 `matrixResources()` 函数内 `const moduleLoader = require('../../module-loader')`，而不是文件顶层。

**配套**：`BUILTIN_RESOURCE` 从 `server.js` 移到 `module-loader.js`——这样权限矩阵不需要 require server.js（那会引入更大的循环依赖），只 require module-loader 就能拿到完整资源清单。

### 4. 白名单只在客户端拦是摆设

**现象**：`platform.js:678-685` 的 `checkWhitelist()` 读 `_platformConfig.editMode`，拦住了界面上的保存按钮（`platform.css:1059-1060` 加 `pointer-events: none`），但这只是**防手滑不防绕过**——懂行的人直接 `curl -X POST /api/platform/config` 就能改配置。

**本轮补上（server.js）**：
- `platformConfig()` 函数读 `data/platform.json`，带 5 秒缓存（写路由主动失效）
- `readonlyBlocked(req, url, me)` 在 `gate()` 的权限判定**之后**挂入（先分出「这人本身就没权限」和「白名单临时只读」两种 403）
- 用 `me.name` 对齐（白名单里存的是**姓名**不是工号，`whoami()` 返回的也是 `user.name`）
- 三条豁免：平台配置自身（`/api/platform/config`，否则锁死无人能解）、退出登录 / 改密码 / 登录（`/api/auth/*`），admin 不受白名单约束

### 5. 密码公式为什么两条分支

**内部**：`姓名缩写首字母大写 + 年份 + 工号后4位` → `Cdp20267968`
**外包**：`姓名缩写首字母大写 + outsourcedPasswordSuffix` → `Zs20261024`

外包没有工号，如果硬套内部公式，「工号后 4 位」会拼成空串，悄悄产出 `Zs2026` 这种短密码。而且两个张磊缩写都是 `zl`，密码会撞车。

**兜底方案**：外包档的**账号用姓名全拼**（`zhangsan`），不是缩写（`zs`）。密码撞了不影响登录，账号是唯一的。

**单一出处**：`password-rule.js` 导出 `buildPassword(prefix, id, cfg, kind)`，CSV 批量建号（`user-import.js`）和 HTTP 建号（`modules/auth/routes.js`）共用这一套——否则两条路建出来的号密码会不一致，且双方都不报错。

**注意**：`10017001` 这种工号的后 4 位是 `7001` 不是 `0001`——`String(id).slice(-4)` 是从尾部取 4 个字符。

### 6. `.gitignore` 缺口：带时间戳的备份

旧规则 `data/platform.db.bak` 是精确匹配，挡不住手工备份的 `data/platform.db.bak-20261014-155436`——那文件里有全部密码哈希和审计，不能进 git。

改成 `data/platform.db.bak*` 通配。

### 7. `help` 模块的噪音日志

```
[module-loader] 加载模块 "help" 失败，已跳过: Cannot find module '/Olivia/pmwork/modules/help/routes.js'
```

`modules/help/` 是纯前端模块（只有 `index.js`），`platform.html` 直接 `<script src="modules/help/index.js">` 加载，走哈希路由 `#/help` 渲染，不经过服务端。`module-loader.loadAll()` 是「扫到子目录就 require routes.js」，遇到它必然报错。

**不影响功能**，「帮助」页面正常可用。治法是在 `loadAll()` 里加前置判断（目录里没有 `routes.js` 但有 `index.js`，就当纯前端模块静默跳过），但不在本轮计划范围内，暂时保留。

## 三、文件清单

### 新增
- `password-rule.js` — 初始密码公式单一出处；导出 `loadConfig / buildPassword / validateNewUser`

### 修改（核心）
- `db.js` — 迁移 `migrateRoles()`（用 `meta.role_model` 打标记）；新增 `getPermissions(role)`（返回 `[{resource, allowed}]`，矩阵需要状态）；导出 `ROLES / ROLE_LIST / ROLE_LABELS` 常量
- `server.js` — `BUILTIN_RESOURCE` 改为从 `module-loader` 引用；新增 `platformConfig()` / `readonlyBlocked()`，在 `gate()` 里挂入白名单拦截
- `module-loader.js` — `BUILTIN_RESOURCE` 移入（单一真值），导出 `listResources()`（模块注册表 + 内置路由汇总）
- `modules/auth/routes.js` — 新增 `matrixResources()` / `GET /api/auth/permissions/matrix` / `POST /api/auth/permissions`（只配 editor，reader 固定只读）；`POST /api/auth/users` 改写（服务端密码生成，一次性返回）；**module-loader 懒加载**（`matrixResources()` 内 require，不在文件顶层）
- `modules/settings/index.js` — 新建用户表单（`bindNewUserForm / submitNewUser`）；权限矩阵（`loadPermissionMatrix / renderPermissionMatrix / onMatrixChange`）；补 `<span id="nuIdHint">` 元素
- `user-import.js` — 密码逻辑委托给 `password-rule.js`

### 修改（测试）
- `_db-test.js` — 角色名点位 + `DEFAULT_PERMISSIONS` 的 key 从四档改三档
- `_test-gate.js` — 新增 `testMatrix()`（18 assertions）、`testNewUser()`（15 assertions）；角色名点位同步

### 修改（其它）
- `.gitignore` — `data/platform.db.bak` → `data/platform.db.bak*`
- `dingtalk-reconcile.js` / `user-cli.js` — 角色名点位同步
- `data/auth-config.json` — 新增 `outsourcedPasswordSuffix: "20261024"`；`_密码公式` 注释扩展两种分支

### 文档
- `docs/plan-dingtalk-checklist.md` — 第 10 项标注作废（单向拉取不需要在钉钉表加列）

## 四、测试覆盖

**单测**（本地 + 服务器）
- `_db-test.js` — 8 pass / 0 fail
- `_test-gate.js` — 55 pass / 0 fail（含权限矩阵 18 条 + 新建用户 15 条）

**服务器验收**（按四步标准：停服 → 拉码 → 起服 → 验收）
- 迁移日志：`[db] 角色模型已迁移到 v2：viewer→reader 371 个。新角色：admin / editor / reader`
- 角色分布：`SELECT role, COUNT(*) FROM users GROUP BY role` → `admin: 2` / `reader: 371`
- 权限表：`SELECT DISTINCT role FROM permissions` → `editor` / `reader`（旧角色 `pm/dev/viewer` 三条僵尸行已清）

**浏览器验收清单**（用户已确认「账号这个先这样吧」，未逐条走完，但服务正常）
1. 非 admin 账号看不到系统设置页的四个 admin-only 区块
2. 同页「去修改密码」入口仍在（整页没锁死）
3. 权限矩阵能配置、改只读后 editor 写 403
4. 新建外包账号返回 `Zs20261024`、能登录
5. 白名单只读模式下非白名单 editor 直接 POST 写接口 403

## 五、提交记录

- `5c2f3fe` — `feat(auth): 角色收敛 admin/editor/reader + 权限矩阵 + 新建用户表单 + 服务端白名单`
- `30827e9` — `docs(dingtalk): 撤回第 10 项「在钉钉表加 _id/_parentId 两列」`

已推送 `origin/dev/sgai`，待合并 `main`。

## 六、遗留与下一步

**立刻要做**
- `main` 合并（等用户浏览器验收完再合，`main` 是验收快照）

**Item 5：钉钉文档单向同步**（最大的一块，没动）
- 前置：一份真实文档的 14 张表结构（873 行 WBS 的 `.able` 文件）
- 代码：入口「从钉钉文档同步」、`applySheetOverrides` 复用表名映射、平台侧存 `dtRecordId` + `dingtalk:{docUrl,nodeId,tableId}`、冲突弹窗、跳过 3 张接不上的表

**遗留小账**（不阻塞，攒着）
- 服务器 `M package.json` / `M package-lock.json` 本地改动一直挂着
- 服务器 `data/scopes.json` / `data/secret.json` 游离文件该删（可能是手滑写错路径）
- `data/dingtalk/scopes.json` CRLF 噪音
- `上市计划` 误映射到 `overview`
- 资源需求丢「缺口/应对方案」两列
- WBS 8 个业务列未匹配
- 15 个模块浏览器逐页验收
- `data/skill/state.json` 260 vs 70 口径差
- 笔记本 `data/sso/secret.json` 还挂 `debug: true`
- `help` 模块噪音日志可治但不急

## 七、配套 Memory

已更新 `C:\Users\chendanping\.claude\projects\...\memory\auth-role-model-v2.md`，并在 `MEMORY.md` 索引里挂上。
