# 运维手册（Ops Manual）

> 适用版本：M1（系统库 + 真实登录 + 权限门禁 + 审计加厚）完成之后。
> 零依赖，Node.js ≥ v22.5（`node:sqlite` 内置模块要求）。

---

## 1. 启动

| 场景 | 命令 |
|---|---|
| 本地开发 | `node server.js`（默认端口 8770） |
| 本地带端口 | `node server.js 8800` 或 `start.bat 8800` |
| 部署（Windows 服务器） | 双击 `start.bat`；建议用 nssm 注册成 Windows 服务保活 |
| 部署（Linux） | `nohup node server.js 8770 >> server.log 2>&1 &` 或 systemd |

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8770 | 监听端口（也可用命令行第 1 个参数） |
| `DATA_DIR` | 项目目录 `data/` | 数据根目录，部署时建议指向持久化路径 |
| `AUTH_REQUIRED` | 关 | `1` 启用真实登录。**升级当天先关着启动确认一切正常，再开** |
| `ACCESS_TOKEN` | 空 | 旧版口令门禁（整站级），与登录并存：先过口令再过登录 |
| `DB_FILE` | platform.db | 系统库文件名（一般不用改） |

**首次启用登录的流程（重要）：**

1. 确认数据已备份（见第 3 节）。
2. 不设 `AUTH_REQUIRED` 启动，确认页面正常。
3. 设 `AUTH_REQUIRED=1` 再启动。若系统库里还没有 admin，启动日志会打印**一次性随机口令**：
   `首次建库：默认管理员 admin，随机口令 xxxx，登录后请立即修改`。
   记下来，登录一次改掉。
4. 如果日志没打印（admin 已存在），用现有 admin 登录；忘了就走第 2 节"重置口令"。

---

## 2. 账号与口令

### 2.1 日常操作（走界面）

登录页登录后，admin 可在界面里管理用户：建账号、改角色（admin/pm/dev/viewer）、停用、改自己的口令。

### 2.2 命令行操作（界面进不去时）

在**项目目录**下执行（`DATA_DIR` 与服务器保持一致）：

```bat
rem 查看所有用户
node -e "const d=require('./db'); console.table(d.listUsers())"

rem 重置某账号口令（例如把 pm 重置为 NewPass@123）
node -e "require('./db').setPassword('pm','NewPass@123'); console.log('已重置')"

rem 改某账号角色
node -e "require('./db').setRole('pm','admin'); console.log('已改角色')"

rem 停用账号（enabled=0）；启用改回 1
node -e "const d=require('./db'); d.open(); d.get().prepare('UPDATE users SET enabled=0, updated_at=? WHERE id=?').run(new Date().toISOString(),'dev'); console.log('已停用 dev')"

rem 新建账号（钉钉扫码登录接入前，先走账密）
node -e "const d=require('./db'); d.createUser({id:'zhangsan',name:'张三',role:'dev',password:'Zs@12345'}); console.log('已创建')"

rem 查看当前角色权限矩阵
node -e "const d=require('./db'); ['pm','dev','viewer'].forEach(r=>console.log(r+':', d.listPermissions(r).map(x=>x.resource).join(', ')))"
```

> 口令哈希用 scrypt + 加盐，库里不存明文。口令建议 ≥10 位、含大小写和符号。

### 2.3 批量建号（几百人规模用）

> 完整方案见 [`plan-dingtalk-sso.md`](./plan-dingtalk-sso.md)。这里只讲怎么用。

**适用场景**：部门几百人一次性开号，账号 = 工号，口令 = 姓名缩写 + 固定后缀。

**前置**：先**停掉服务**（避免 SQLite 写竞争），再执行：

```bat
rem 1. 先干跑一遍，只看会建哪些号，不写库
node user-import.js --dry-run docs/samples/员工名单.csv

rem 2. 确认无误后正式导入
node user-import.js docs/samples/员工名单.csv
```

**名单格式**（CSV，首行表头，UTF-8，放 `docs/samples/员工名单.csv`，**已 gitignore**）：

```
工号,姓名,口令前缀[,角色]
10017xxx,张三,zs
10018xxx,李四,ls,pm
```

- `口令前缀`：姓名缩写，**由 Excel 公式或人工生成好**（程序不做拼音转换，避免引入依赖和多音字出错）
- `角色`列可选，缺省 `viewer`。**建议只给 PMO 的人写 `pm`，其余一律留空**
- **重复导入安全**：已存在的工号会跳过，**不覆盖其口令和角色**

**初始口令提示**：用初始口令登录后，页面顶部会出现可关闭的提醒横幅（不强制改密，见方案 D3）。用户改密后自动消失。

### 2.4 权限矩阵（默认值）

| 角色 | 能干什么 | 刻意不给 |
|---|---|---|
| admin | 一切（含用户管理、审计、平台配置） | — |
| pm | plan/iteration/project/csenergy 读写、archive 写、budget 读、调用文档/风险/周报 Agent | `budget:write`、`ai:finance`、`platform:*` |
| dev | plan/iteration/project/csenergy 读、dashboard/token 读 | 一切写（改自己任务状态将来走行级权限） |
| viewer | 只读 | 一切写 |

改矩阵：界面（admin）或 `node -e "require('./db').setPermission('dev','plan:write',1)"`。
**改完不用重启**（每次请求实时查库）。

---

## 3. 数据备份与恢复

### 3.1 备份

```bat
rem Windows：双击或命令行
backup-data.bat
rem 备份到独立磁盘
set BACKUP_DIR=E:\pm-backups && backup-data.bat
```

```bash
# Linux：cron 每天凌晨 2 点
0 2 * * * cd /path/to/iSolarCloudProjectManage && ./backup.sh >> /var/log/pm-backup.log 2>&1
```

脚本做的事：先把 `platform.db-wal` 合并回主库（`PRAGMA wal_checkpoint(TRUNCATE)`），再整目录复制 `data/` 到 `backups/backup-<时间戳>/`，自动保留最近 30 份。**备份期间服务不停、不锁**（WAL 模式支持并发读）。

### 3.2 恢复

1. 停服务。
2. 把当前 `data/` 整体挪走（留现场）。
3. 从最近一份完整备份把 `data/` 内容拷回。
4. 起服务，核对：`node -e "console.log(require('./db').auditCount())"`（审计条数）与页面数据。

### 3.3 备份里有什么

| 文件 | 内容 |
|---|---|
| `platform.db` (+`-wal`/`-shm`) | 身份/会话/权限矩阵/审计日志（SQLite） |
| `platform.json` | 平台设置（editMode、whitelist 等） |
| `iteration/state.json` | 迭代工时/偏差真实数据（**核心资产**） |
| `plan/`、`project/`、`budget/`、`csenergy/`、`token/`、`tb/`、`dashboard/`、`archive/` | 各模块 state + history 快照 |
| `history/` | 根级历史快照 |

> `secret.json`（TB/钉钉凭据）**不入库**（.gitignore 已挡），但**在备份目录里**——备份目录的权限比 git 仓库更值得管住（含口令哈希和审计）。

---

## 4. 系统库与审计核查

```bat
rem 库文件位置与大小
node -e "const d=require('./db'); d.open(); console.log(d.DB_FILE)"

rem 审计日志最近 20 条
node -e "const d=require('./db'); d.open(); console.table(d.getAudit(20).map(r=>({t:r.ts,u:r.user_name,m:r.module,a:r.action})))"

rem 审计总条数（加厚后不再截断，持续增长）
node -e "const d=require('./db'); d.open(); console.log(d.auditCount())"

rem 直接查库（任意 SQL 只读）
node -e "const d=require('./db'); d.open(); console.table(d.get().prepare('SELECT module, COUNT(*) n FROM audit_log GROUP BY module ORDER BY n DESC').all())"
```

界面入口：`/api/platform/audit`（仅 admin）——平台页的"审计日志"区。

**Harness 审计层落点**：`audit_log` 表里 `ai_triggered` / `ai_adopted` 两列现在留空，M3 接 Agent 后每个 AI 操作写这两列，即可回答"AI 干了什么、人采没采纳"。

---

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| 端口被占用 | 换端口 `node server.js 8800`；或查谁占用：`netstat -ano \| findstr 8770` |
| 启动日志刷 `ExperimentalWarning: SQLite` | 正常现象（node:sqlite 尚标记 experimental），不影响使用 |
| 页面一直转圈 | 看 server 日志；若 `state.json 解析失败`，服务端会自动回退最近快照（日志有提示） |
| 有人反馈"我登录的是别人" | 不应再发生（身份只认服务端会话 Cookie，不再信 localStorage）；若发生，查该请求的审计记录里 `user_id` |
| 忘了 admin 口令 | 第 2.2 节 `setPassword` 重置；重置前建议先备份 |
| 想回退到"无登录"模式 | 去掉 `AUTH_REQUIRED=1` 重启即可，数据不受影响 |
| `data/platform.db` 损坏 | 用最近备份恢复；或删库重建（`setPassword`/`createUser` 重建账号，审计不可恢复） |

---

## 6. 部署检查清单（上线前过一遍）

- [ ] `backup-data.bat` 跑过一次，备份目录可读
- [ ] `AUTH_REQUIRED=1` 下用 4 种角色各登一次：admin/pm/dev/viewer
- [ ] dev 写 plan 被 403 拦截；pm 写 plan 通过
- [ ] 审计日志里能看到自己的登录记录
- [ ] 重启服务后登录态还在（会话在 SQLite，不随进程丢）
- [ ] 备份目录权限：只有运维/admin 能读
