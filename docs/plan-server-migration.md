# 本地数据全搬到服务器 · 方案

> 目标：把本机 `data/` 下你已经经营出来的数据（373 个账号、迭代工时、归档、钉钉/SSO/TB 凭据、Skill 运行结果）完整搬到 `10.63.139.103`，让服务器上的平台和本机**长得一模一样**，而不是一个空壳。
>
> 写这份文档的直接原因：**平台在服务器上能不能用，代码只占一半，另一半是 gitignore 掉的那些数据文件。** 只 clone 代码 = 拿到一个没有账号、没有迭代数据、没有凭据的空平台。

---

## 一、结论先行（三句话）

1. **`git clone` 拿不到能用的平台。** 你本机 `data/` 下绝大多数文件在 `.gitignore` 里（真实工时、账号库、密钥、Skill 结果），clone 下来是空的。
2. **真正要搬的是 8 类文件，约 70 MB**，其中 `data/iteration/history/` 占了 61 MB，是体量主因。
3. **有 3 个坑必须先处理**，否则搬过去要么丢数据、要么起不来：WAL 未落盘、`DATA_DIR` 有不跟随的硬编码路径、服务器 Node 版本必须 ≥ 22.5。

---

## 二、为什么不能只 clone 代码

`.gitignore` 里被排除、但**平台运行必需**的：

| 被忽略的路径 | 里面是什么 | 不搬的后果 |
|---|---|---|
| `data/platform.db` `-wal` `-shm` | 373 个账号、密码哈希、角色、权限矩阵、审计日志 | 服务器上一个账号都没有，全员登不进 |
| `data/iteration/state.json` | 当前迭代的真实工时数据 | 首页全空 |
| `data/iteration/history/` | 每次变更的快照（61 MB） | 历史回溯、回滚全没了 |
| `data/archive/*.json` | 已归档迭代 | 「历史归档」页空 |
| `data/{plan,project,budget,token}/state.json` | 各模块业务数据 | 对应 Tab 空 |
| `data/skill/`、`data/pradapter/` | AI Skill 运行结果、PR 适配器快照 | AI 相关页面空 |
| `data/sso/secret.json` | SSO 应用凭据 | **服务器上 SSO 登录直接不可用** |
| `data/dingtalk/secret.json` | 钉钉应用凭据 | 钉钉登录/同步不可用 |
| `data/tb/secret.json` | TB 应用凭据 | 迭代同步不可用 |
| `data/dingtalk/org.json` `roster.csv` | 372 人通讯录快照 | 钉钉匹配降级为实时查询（能用但慢） |
| `data/notify/{state,outbox}.json` | 推送待发队列 | 推送去重记录丢失，可能重复推送 |
| `data/auth-config.json` | 初始密码规则 | 走默认规则 |

**反过来，有些文件绝对不能搬**（见第四节）。

---

## 三、搬迁清单

### A. 必须搬（不搬平台不可用）

```
data/platform.db
data/platform.db-wal          ← 见坑 1，必须在停服后一起搬
data/platform.db-shm          ← 同上
data/iteration/state.json
data/iteration/history/       ← 61 MB，体量主因
data/archive/
data/plan/state.json          data/plan/history/
data/project/state.json       data/project/history/
data/budget/state.json        data/budget/history/
data/token/state.json         data/token/history/
data/skill/
data/pradapter/
data/notify/state.json        data/notify/outbox.json   data/notify/config.json
data/auth-config.json
data/dingtalk/secret.json     data/dingtalk/org.json
data/dingtalk/scopes.json     data/dingtalk/teams.json
data/dingtalk/roster.csv      data/dingtalk/report.txt
data/sso/secret.json
data/tb/secret.json           data/tb/state.json
data/state.json               ← 旧版重定向标记，别删，migrate.js 认它
```

### B. 建议搬（有它就少一次手工）

- `data/dingtalk/leavers.csv` — 离职名单，对账用
- `data/dingtalk/reconcile-report.txt` — 上次对账报告，用于对比

### C. 不用搬（服务器会自己生成）

- `data/dingtalk/token.json` — 运行时 token，会自动重建
- `data/platform.json` — 老的元信息，已由 `platform.db` 的 meta 表接管

### D. 绝对不搬

- `data/iteration/state.json.CORRUPT-*.bak` — 那次事故留的损坏样本（171 字节），别把坏数据带上服务器
- `node_modules/` — 服务器上重新装
- `backups/` — 本机备份目录，含历史密码哈希，没必要上服务器

---

## 四、三个必须先处理的坑

### 坑 1：`platform.db-wal` 有 4 MB 未落盘 —— 只拷 `.db` 会丢数据

**现象**：`data/platform.db` 只有 252 KB，但 `platform.db-wal` 有 **4 MB**（比主库大 16 倍）。

**原因**：`db.js` 打开了 `PRAGMA journal_mode = WAL`，写入先进 WAL 文件、定期才合并回主库。你现在服务还开着，这 4 MB 里躺着的是**最近的账号、权限、审计写入**。

**如果只拷 `platform.db`**：服务器上会缺最近所有的新账号和新审计记录，而且**不报错**——查询就是少几条，最难发现的那种。

**正确做法（二选一）**：

- **推荐**：先停本机服务（`Ctrl+C` 正常退出），SQLite 会在关闭时自动 checkpoint，WAL 内容合并进主库。停服后 `platform.db-wal` 会缩到接近 0，这时拷 `.db` 就安全了。
- **图省事**：停服后把 `.db` / `-wal` / `-shm` **三个文件一起拷**过去。SQLite 会在服务器上自动重放 WAL。⚠️ 三个文件必须同属一份，混搭不同时间的文件会导致库损坏。

> ⚠️ 本机平台现在**服务还开着、还在用**（用户 2026-09-24 明确交代过「云服务迭代版本那里现在服务还启着用着更新着呢」）。搬之前先跟相关人说一声再停，别硬停。

### 坑 2：`DATA_DIR` 有几个地方不跟随 —— 如果你把数据放到别的路径，这些会读错

大部分模块都正确读了 `process.env.DATA_DIR`，但下面这些**写死了项目目录下的 `data/`**：

| 文件 | 写死的路径 | 影响 |
|---|---|---|
| `dingtalk-ping.js:24` | `data/dingtalk/secret.json` | 命令行诊断工具读不到凭据 |
| `dingtalk-sync.js:34-35` | `data/dingtalk/org.json`、`scopes.json` | **同步会把产物写到错的地方** |
| `dingtalk-roster.js:26` | `data/dingtalk/` | 名单工具 |
| `dingtalk-reconcile.js:52` | `data/dingtalk/` | 对账工具 |
| `modules/dingtalk/client.js:27` | `data/dingtalk/secret.json` | **钉钉登录读不到凭据** |
| `modules/notify/routes.js:27,189` | `data/notify/config.json`、`data/dingtalk/org.json` | **推送配置读不到** |

**规避方式（二选一）**：

- **方案 A（推荐，省事）**：服务器上**不设 `DATA_DIR`**，就让数据待在项目目录的 `data/` 下。所有路径自动一致，零风险。
- **方案 B**：设 `DATA_DIR` 指向独立持久化路径（如 `/data/pmwork/data`），但必须**只在项目根目录下建一个软链**，让硬编码路径也能落到同一处：
  ```bash
  ln -s /data/pmwork/data /opt/pmwork/data
  ```
  这样写死的 `__dirname/data` 会跟着软链走。

### 坑 3：服务器 Node 版本必须 ≥ 22.5

**原因**：`db.js` 用的是 `node:sqlite` 内置模块，Node **22.5** 才引入，本机跑的是 v24.12.0。

**如果服务器是 Node 18/20**：启动即报 `Cannot find module 'node:sqlite'`，平台起不来。

**检查**：`node -v`。低于 v22.5 就必须升级（`start.sh` 里那段安装脚本装的是 v20，**不够用**，别照抄）。

> 另注：即使版本够，每次启动都会有一行 `ExperimentalWarning: SQLite is an experimental feature`。**这是正常的**，不是错误。

---

## 五、操作步骤

### 步骤 1：本机停服并打包

```bash
# ① 停掉本机服务（Ctrl+C），确认 WAL 已合并
ls -la data/platform.db-wal      # 应该已缩到很小或为 0

# ② 进项目目录，打包
cd "E:/PMWork/Project Materials/iSolarCloudProject/迭代版本/iSolarCloudProjectManage"

tar -czf pmwork-data.tar.gz \
  data/platform.db data/platform.db-wal data/platform.db-shm \
  data/iteration data/archive data/plan data/project data/budget \
  data/token data/skill data/pradapter data/notify data/sso \
  data/dingtalk data/tb data/auth-config.json data/state.json \
  --exclude='data/iteration/state.json.CORRUPT-*'

ls -lh pmwork-data.tar.gz     # 预期 20~40 MB（61 MB 历史目录压缩后）
```

> ⚠️ 如果 `data/platform.db-wal` 不存在（已经 checkpoint 掉了），`tar` 会报 `Cannot stat`。去掉这个文件名再打一次即可。

### 步骤 2：传到服务器

```bash
# Linux 服务器
scp pmwork-data.tar.gz 用户名@10.63.139.103:/opt/pmwork/

# Windows 服务器（用 WinSCP 图形化传，或 PowerShell 的 scp）
```

### 步骤 3：服务器上解包

```bash
cd /opt/pmwork
tar -xzf pmwork-data.tar.gz
ls -la data/platform.db data/iteration/state.json data/sso/secret.json
# 三个都在 = 关键数据到位
```

### 步骤 4：对照校验清单逐条确认

解包完**必须**跑一遍这个，别跳：

```bash
cd /opt/pmwork

# ① 账号数应该是 373
node -e "const db=require('./db');console.log('账号数:',db.listUsers().length)"

# ② 迭代数据不是空的
node -e "console.log('工时段数:',Object.keys(require('./data/iteration/state.json')).length)"

# ③ 凭据文件齐不齐
for f in data/sso/secret.json data/dingtalk/secret.json data/tb/secret.json; do
  [ -f "$f" ] && echo "OK  $f" || echo "缺  $f"
done

# ④ 归档数量对得上本机
ls data/archive/*.json | wc -l
```

**预期**：① 输出 `账号数: 373`；③ 三行全 `OK`；④ 与本机 `ls data/archive/*.json | wc -l` 数字**完全一致**。

对不上就别往下走，先把对应文件重传一遍。

---

## 六、回滚

搬过去之后如果发现问题要退回本机：

1. 服务器停服
2. 本机 `data/` 目录**先整个复制一份留底**（`cp -r data data.bak-20261008`）
3. 本机的原始数据始终没被改动过（搬运是复制，不是移动），所以回滚 = 直接用本机那份
4. **唯一要小心的是**：如果服务器已经跑了一段时间、产生了新数据，回滚会丢掉那部分。所以**服务器上线前，本机先停用**，避免两边同时写入

---

## 七、搬完之后的两条纪律

1. **服务器成为唯一数据源**。搬完就让本机停止写入，否则两边数据分叉，之后再想合并会非常痛苦。
2. **`data/` 要备份**。服务器上的 `data/` 现在是唯一副本了。用现成的 `backup.sh` / `backup-data.bat`，或者加个 crontab：
   ```bash
   # 每天凌晨 2 点备份，保留 30 天
   0 2 * * * tar -czf /backup/pmwork-$(date +\%Y\%m\%d).tar.gz /opt/pmwork/data
   find /backup -name 'pmwork-*.tar.gz' -mtime +30 -delete
   ```

---

## 相关文档

- `docs/ops-server-deploy.md` — 登录服务器、部署代码、启动服务的详细操作步骤
- `docs/ops-manual.md` — 平台日常运维（账号、权限、审计）
- `docs/plan-identity-and-dingtalk.md` — SSO / 钉钉接入的背景与回调地址约定
- `部署指南.md` — ⚠️ 已过时，仅作历史参考（讲的是老的 8770 端口与无账号体系版本）
