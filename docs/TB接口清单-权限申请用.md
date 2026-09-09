# Teambition 开放接口清单（权限申请用）

> 用途：向 TB 管理方申请接口/数据权限时，作为完整的接口与字段清单附件。
> 整理时间：2026-09-09
> 对接方：云平台管理工作台（`modules/tb/`）

---

## 一、基础信息

| 项 | 值 |
|---|---|
| 接口根地址 | `https://open.teambition.com/api` |
| 认证方式 | HTTP Header `Authorization: Bearer <User Token>` |
| Token 来源 | Teambition UserToken 自助申请页 `https://open.teambition.com/user-mcp` |
| Token 存放位置 | 本机 `data/tb/secret.json`（已 gitignore）或环境变量 `TB_TOKEN`，不入代码库 |
| 目标项目 | 智慧能源需求管理项目，`projectId = 680dfb8c99c59515f40c1226` |

---

## 二、当前已打通、正在使用的接口（2 个）

这两个接口用现有 Token 调用**正常返回**，是目前拉数的全部来源。

### 1. 按 TQL 查询任务 ID 列表（分页）

```
GET /api/v2/all-task/search?tql=<TQL>&pageSize=200&pageToken=<T>
```

- **用途**：按「项目 + 迭代 + 团队 + 任务类别 + 未归档」条件筛出任务 ID 全集
- **返回**：任务 ID 列表 + `nextPageToken` + `totalCount`
- **分页**：每页 200 条，用 `nextPageToken` 翻页
- **实际使用的 TQL 条件**：

  | 条件 | 值 | 说明 |
  |---|---|---|
  | `projectId` | `680dfb8c99c59515f40c1226` | 固定项目 |
  | `isArchived` | `false` | 只取未归档，与 TB 统计看板口径一致 |
  | `sprintId` | 动态 | 当前用的两个见第四节 |
  | `cf:68722870444ca7f13ef053d2` | `三级任务-研测工程师拆解` | 任务类别（部分看板才加此条件） |
  | `cf:689d9725d499509188209290` | `IN (团队白名单)` | 所在团队（部分看板不限团队） |

### 2. 批量查询任务详情（自定义字段）

```
GET /api/v3/task/query?taskId=<id1,id2,...>&fields=customfields
```

- **用途**：拿上一步的任务 ID，批量取自定义字段值（团队、故事点、产品线等）
- **批量大小**：每次最多 50 个 taskId 拼接
- **需要读取的字段**：见第三节

---

## 三、需要读取权限的自定义字段（5 个）

均属上述项目，通过 `v3/task/query` 的 `customfields` 返回。

| 字段含义 | 字段 ID | 类型 | 用途 |
|---|---|---|---|
| 所在团队 | `cf:689d9725d499509188209290` | 单选 | 按团队聚合工作量；同时用作 TQL 筛选条件 |
| 故事点 | `cf:6878b134ae04e423c2eb5a36` | 数字 | 工作量主口径 |
| 预估故事点 | `cf:6979a32e929cb98c2efcca7d` | 数字 | 部分团队的工作量口径 |
| 任务类别 | `cf:68722870444ca7f13ef053d2` | 单选 | 筛「三级任务-研测工程师拆解」 |
| 所属产品线 | `cf:686ccc74e4f32d9e9e7ef0e2` | 层级 | 按产品线维度聚合（取层级 1） |

另需读取任务自带的 `sprintId`（判断任务属于哪个迭代）。

---

## 四、**待申请**：迭代（Sprint）列表接口 ⚠️

### 正确的接口路径

```
GET /api/v3/project/{projectId}/sprints
```

> **注意：不是 `/sprint/list`。** 路径以 Teambition 官方仓库
> [teambition/tb-skills](https://github.com/teambition/tb-skills) 的 `scripts/manage_sprint.py` 为准
> （该脚本 `list` 动作调用的即 `v3/project/{projectId}/sprints`）。
> 申请时请用上面这个路径，写错路径会导致申请无效。

### 为什么需要它

任务详情只返回 `sprintId`（一串 ID），**不返回迭代名称**。没有这个接口，就无法把
`6a54cad1565616b581fcb14b` 这样的 ID 翻译成「阳光云2026-8月C版本迭代」。

**当前的临时办法**：在 `tb-config.js` / 前端「迭代配置」里人工维护一张
`sprintId → 迭代名` 对照表。**每月换迭代都要手工改一次 ID**，容易漏改、填错。
接口打通后即可自动拉取，不再需要人工维护。

### 当前状态

调用返回 **403 Forbidden**。

### ⚠️ 关于 403 的性质（申请前请先确认）

Teambition 官方文档对 403 的说明是：**Token 有效，但无权限访问该资源**，
处置建议为「确认 Token 对应的用户有权限访问该项目/任务」
（来源：[teambition/tb-skills — references/error-handling.md](https://github.com/teambition/tb-skills/blob/master/dingtalk-teambition/references/error-handling.md)）。

结合我们的实际情况：**同一个 Token 调任务查询接口完全正常，只有迭代列表 403**。
因此更可能是「**该 Token 所属账号在这个项目里的角色权限不足**」，
而不是需要单独开通一个 API 权限点。

**建议向管理方同时确认这两种可能：**

1. **账号角色**（优先）：该 Token 所属账号在项目 `680dfb8c99c59515f40c1226` 中
   是什么角色？读取迭代列表是否要求项目管理员 / 特定角色？能否提升该账号角色？
2. **接口权限点**：若贵方权限体系确实按接口粒度管控，请为该账号 / 应用开通
   `GET /api/v3/project/{projectId}/sprints` 的调用权限。

---

## 五、未来可能需要、目前未使用的接口

不在本次申请必需范围内，一并列出便于一次性评估。路径均来自官方仓库
[teambition/tb-skills](https://github.com/teambition/tb-skills)。

| 接口 | 用途 | 现在为什么不用 |
|---|---|---|
| `GET /api/v3/project/{projectId}/customfield/search` | 拉取项目自定义字段定义（字段 ID、选项列表） | 字段 ID 已硬编码在 `tb-config.js`。打通后可自动发现字段、避免字段调整后写死的 ID 失效 |
| `GET /api/v3/project/query` | 项目详情 | 只对接单一项目，信息已知 |
| `GET /api/project/search` | 按 TQL 查项目列表 | 同上 |
| `POST /api/v3/member/query?q=<关键词>` | 查项目成员（姓名 / userId） | 团队归属取自自定义字段，暂不需要成员表 |
| `GET /api/v3/project/priority/list` | 优先级字典 | 未使用优先级 |
| `GET /api/v3/project/{projectId}/scenariofieldconfig/search` | 任务类型（场景）配置 | 任务类型配置 ID 已硬编码 |
| `GET /api/users/me` | 当前 Token 对应用户信息 | 可用于自检 Token 有效性与账号身份，排查 403 时有用 |

---

## 六、关于「工时数据」的重要说明 ⚠️

**目前系统里的「工时」不是 Teambition 的工时记录，而是自定义字段「故事点 / 预估故事点」的求和。**

我们检索了 Teambition 官方开放接口清单，**未发现任何工时 / worklog / timesheet 类接口**。

所以请先明确你要的是哪一种：

- **若「工时」= 故事点口径**（当前实现）：
  第二、三节的接口和字段已经够用，**不需要额外申请**。
- **若「工时」= TB 里人员实际登记的工时/耗时记录**：
  需要先向管理方确认「Teambition 开放接口是否提供工时数据接口」。
  若开放接口不提供，则此需求走开放接口无法实现，需要另找途径
  （例如数据库/数仓直连、或由 TB 侧提供导出）。

---

## 七、申请清单速览（可直接粘给审批人）

**项目**：智慧能源需求管理项目 `680dfb8c99c59515f40c1226`
**账号**：`<填写 User Token 所属账号>`

**已通、无需处理：**
1. `GET /api/v2/all-task/search`
2. `GET /api/v3/task/query`

**本次申请：**
3. `GET /api/v3/project/{projectId}/sprints` —— 当前 403。
   请确认是账号在该项目的角色权限不足，还是需要单独开通接口权限点。

**建议一并开通（可选，降低后续维护成本）：**
4. `GET /api/v3/project/{projectId}/customfield/search` —— 自动发现自定义字段，避免字段 ID 写死
5. `GET /api/users/me` —— 自检 Token 与账号身份，便于排查权限问题

**待澄清：**
6. Teambition 开放接口是否提供**工时/worklog 数据接口**？若有，请一并提供接口路径与权限。

---

## 附：信息来源

- 接口路径与错误码语义：Teambition 官方仓库 [teambition/tb-skills](https://github.com/teambition/tb-skills)
  （`dingtalk-teambition/scripts/*.py`、`references/error-handling.md`、`references/tql.md`）
- 项目内实际调用代码：`modules/tb/client.js`、`modules/tb/sync.js`、`tb-config.js`

> 上述外部来源内容经改写以符合授权要求（Content was rephrased for compliance with licensing restrictions）。
