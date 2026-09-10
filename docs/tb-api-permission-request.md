# Teambition 开放平台接口权限清单（应用授权）

> 用途：向 TB 企业管理员 / 应用开发者说明「人力产能工作台」需要申请哪些接口权限。
> 关联应用：`6aa124bdad090c49109f7017`
> 关联企业（tenantId）：`60e7dce8bf4c8af5be3c42c1`
> 目标项目：`680dfb8c99c59515f40c1226`（智慧能源需求管理）

---

## 0. 结论先行

本平台只需 **3 类权限**即可跑通全部功能，**已实测全部通过**：

| # | 权限点 | 用途 | 对应接口 |
|---|---|---|---|
| 1 | `tb-core:task:list` | 任务列表查看 | `GET /api/v2/all-task/search` |
| 2 | `tb-core:project.sprint:list` | **迭代列表查看（核心缺口）** | `GET /api/v3/project/{projectId}/sprint/search` |
| 3 | 任务详情 / 自定义字段读取 | 读工时、故事点等自定义字段 | `GET /api/v3/task/query` |

另需 **1 个免权限接口** 用于换取令牌：`POST /api/appToken`。

---

## 1. 认证方式：应用凭据（非 User Token）

平台采用 TB 的**企业内部应用**模型，不再依赖个人令牌。

### 请求头四件套

| Header | 取值 | 说明 |
|---|---|---|
| `Authorization` | `Bearer <appToken>` | 由 `appToken` 接口换取，见下 |
| `X-Tenant-Id` | `60e7dce8bf4c8af5be3c42c1` | 企业 ID |
| `X-Tenant-Type` | `organization` | 固定值 |
| `X-Operator-Id` | `614b8b746ce83b42a92d1cdc` | 以该成员身份执行，权限校验的第二层 |

### 换取 appToken

```
POST https://open.teambition.com/api/appToken
Content-Type: application/json

{ "appId": "<appId>", "appSecret": "<appSecret>" }
```

**实测返回**（2026-09-10）：

```json
{ "appToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...", "expire": 1800 }
```

> ⚠️ 两个容易踩的点：
> 1. `appToken` 在**响应体顶层**，不在 `result` 里。
> 2. `expire` 单位是**秒**，实测 1800（30 分钟），需做缓存 + 提前刷新。

### 双层权限校验

接口能否调通 = **应用层**（权限点已勾选且应用已发布安装）**AND** **成员层**（`X-Operator-Id` 那个人在该项目里的角色）。
两层缺一不可。仅勾权限但操作者不在项目里，仍会失败。

---

## 2. 接口清单（全部实测通过）

### 2.1 任务列表 — `tb-core:task:list`

```
GET /api/v2/all-task/search?tql=<TQL>&pageSize=200&pageToken=<token>
```

- `tql`：Teambition Query Language，**大小写敏感**
- 返回 `result` 是**任务 id 字符串数组**，翻页用响应里的 `nextPageToken`

本项目实际使用的 TQL：

```
projectId = '<项目ID>' AND isArchived = false AND sprintId = '<迭代ID>'
```

> 备注：`projectId` 在任务查询里是合法字段；但在**项目搜索**里不合法（见 2.3）。

### 2.2 任务详情（自定义字段）— 任务详情 / 自定义字段读取

```
GET /api/v3/task/query?taskId=<id1,id2,...>&fields=customfields
```

- 单次建议不超过 50 个 taskId
- **工时、故事点等全部在 `customfields` 里**，按 `cfId` 取值

实测单个任务返回 9 个自定义字段。本项目依赖的字段：

| 字段用途 | cfId |
|---|---|
| 所属团队 | `cf:689d9725d499509188209290` |
| 故事点 | `cf:6878b134ae04e423c2eb5a36` |
| 预估故事点 | `cf:6979a32e929cb98c2efcca7d` |
| 任务层级 | `cf:68722870444ca7f13ef053d2` |
| 产品线 | `cf:686ccc74e4f32d9e9e7ef0e2` |
| 工时（分钟） | `cf:637664d214a5d6004073215f` |

### 2.3 迭代列表 — `tb-core:project.sprint:list`（**核心缺口**）

```
GET /api/v3/project/{projectId}/sprint/search?pageSize=100&pageToken=<token>
```

**实测返回**（这是本次打通的最后一块）：

```json
{
  "code": 200,
  "nextPageToken": "10",
  "result": [{
    "id": "684f8434f81e4e5670680dfa",
    "name": "工具开发部8月迭代",
    "status": "complete",
    "projectId": "680dfb8c99c59515f40c1226",
    "startDate": "2025-07-31T16:00:00.000Z",
    "dueDate": "2025-08-31T15:59:59.999Z",
    "accomplished": "2025-09-04T11:58:23.665Z"
  }]
}
```

- `status` 取值：`future`（未开始）/ `active`（进行中）/ `complete`（已完成）
- 实测该项目共 **150 个迭代**，分页正常

**单迭代详情**（备用）：

```
GET /api/v3/sprint/info?sprintId=<迭代ID>
```

> ⚠️ **重要更正**：早期文档写的 `GET /api/sprint/list` 是**无效路径**，实测返回
> `code:421 MisdirectedRequest, url not found`。正确端点是上面的 `sprint/search`。
>
> ⚠️ 另一个坑：TB **恒返回 HTTP 200**，真实结果在响应体 `code` 字段里。
> 客户端若只判断 HTTP 状态码，会把 421 这类错误当成功。

### 2.4 项目列表（弱关联，可选）

```
GET /api/v3/project/search?tql=<TQL>&pageSize=...
```

- `tql=name ~ '关键字'` 可用；`tql=id = '<项目ID>'` 可用
- **`projectId` 和 `_id` 都不是合法字段名**（报 `invalid field name`）
- 返回的 `result` 是**项目 id 字符串数组**（不是对象数组）；如需项目名要再调 `v3/project/query`

```
GET /api/v3/project/{projectId}/application/list
```

---

## 3. 应用生命周期（权限变更后的坑）

```
创建企业内部应用 → 拿 App ID / App Secret
  → 应用开发 · 应用权限 勾选权限点
  → 应用发布（填版本号并发布）
  → 企业管理员在应用商店「企业内部应用」类目安装
```

> ⚠️ **权限变更后必须重新发布，且已安装的企业要重新安装一次才生效。**
> 只勾权限没发布、或发布了没重装，接口仍会失败。

---

## 4. 环境配置

平台侧凭据存放于 `data/tb/secret.json`（已 `.gitignore`，不入库），也可用环境变量覆盖：

| 配置项 | 环境变量 |
|---|---|
| `appId` | `TB_APP_ID` |
| `appSecret` | `TB_APP_SECRET` |
| `tenantId` | `TB_TENANT_ID` |
| `operatorId` | `TB_OPERATOR_ID` |

> 兜底：若未配齐应用凭据，平台会回退使用 `token`（User Token）/ `TB_TOKEN`。

---

## 5. 实测结论（2026-09-10）

以应用凭据调用，以下接口全部业务码 200：

| 接口 | 结果 |
|---|---|
| `POST /api/appToken` | ✅ 拿到 176 字符 JWT |
| `GET /api/v2/all-task/search` | ✅ 分页正常 |
| `GET /api/v3/task/query` | ✅ 含 9 个自定义字段 |
| `GET /api/v3/project/{id}/sprint/search` | ✅ 150 个迭代 |
| `GET /api/v3/sprint/info` | ✅ |
| `GET /api/v3/project/{id}/application/list` | ✅ |

**全量同步实测**：阳光云 **765** 任务 / 中后台 **201** 任务 / 产品线 **998** 任务，耗时约 **6.7 秒**。
