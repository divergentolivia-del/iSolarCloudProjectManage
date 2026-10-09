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

> **⚠️ 2026-10-09 实操修正（照下面这份走，别照最早那版清单）**
>
> 1. **`data/sso/secret.json` 不要搬**（原清单列在 A 里，是错的）。
>    本机那份 `debug: true`（联调），服务器上验过的 `debug: false`（生产）。
>    搬过去会把服务器打回联调模式：SSO 能跳转、能显示工号，**但不建 session**，
>    表现为「登录成功却还是进不去」，且日志不报错。它属于**机器级配置**，各管各的。
> 2. **`platform.db` 不再是「`.db`+`-wal`+`-shm` 三件套」**，改成单文件快照：
>    停服**不能保证** WAL 合并 —— 2026-10-09 那次停了服，主库还是停在 258KB，
>    WAL 里躺着 4.1MB 真实数据。改用 `VACUUM INTO` 出单文件（见坑 1 修正）。
> 3. **`--exclude` 必须写在文件列表前面**。tar 从左到右处理参数，
>    写在后面等于没写 —— 原命令就是这个顺序，坏样本差点带上服务器。

```
data/platform.snapshot.db     ← VACUUM INTO 产物，到服务器后 mv 成 platform.db
data/iteration/state.json
data/iteration/history/
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
data/tb/secret.json           data/tb/state.json
data/state.json               ← 旧版重定向标记，别删，migrate.js 认它
```

> 可执行版本见 `docs/ops-server-deploy.md` §3.5，那边含完整自检和验收命令。

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

**正确做法：停服后用 `VACUUM INTO` 出单文件快照。**

> **⚠️ 2026-10-09 实操修正 —— 「停服后 WAL 会自动合并」这个假设不成立。**
>
> 那次搬迁本机服务确实停干净了（`9680` 无 LISTENING），但 `data/platform.db`
> 仍停在 258 KB，`platform.db-wal` 里躺着 **4,157,112 字节**。也就是说
> **进程退出不等于 WAL 合并** —— 用 `cp` / `tar` 只拿主库就会丢掉几乎所有账号和审计记录。
>
> **「三件套一起拷」也不推荐**：`-wal` 是绑定到某一具体主库的，跨机器搬运时
> 中途任何一步顺序不对（比如解包后被别的进程碰过）就会配错对，SQLite 直接判库损坏，
> 而且损坏是恢复时才发现的。
>
> **改用 `VACUUM INTO`**：在只读事务里把主库 + WAL 的一切写成一个自洽单文件，
> 产物拿到哪台机器上都能直接打开，没有配对问题。

```bash
# ① 把三件套复制到工作目录（不动生产数据）
mkdir -p .scratch/migrate
cp data/platform.db data/platform.db-wal data/platform.db-shm .scratch/migrate/ 2>/dev/null

# ② 在副本上做快照
cat > .scratch/migrate/snapshot.js <<'EOF'
const path = require('path'); const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const SRC = path.join(__dirname, 'platform.db');
const DST = path.join(__dirname, 'platform.snapshot.db');
if (fs.existsSync(DST)) fs.unlinkSync(DST);
const db = new DatabaseSync(SRC);
db.exec("VACUUM INTO '" + DST.replace(/\\/g, '/') + "'");
console.log('账号数:', db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
db.close();
EOF

node .scratch/migrate/snapshot.js     # 预期输出 账号数: 373
```

**③ 验证快照确实是完整的**（这一步是判断「有没有丢 WAL 数据」的唯一手段）：

```bash
# 同一个脚本分别体检「主库单个文件」和「主库+WAL 完整打开」，
# 行数一致 = 快照没丢东西
node .scratch/migrate/inspect.js .scratch/migrate/platform.db
node .scratch/migrate/inspect.js .scratch/migrate/platform.snapshot.db
```

两次输出的 `users` / `audit_log` 行数**必须相同**（当时是 373 / 781）。
`platform.db` 单文件那次如果行数明显偏少，正好印证了 WAL 里确实压着数据。

> 体检脚本内容见 `docs/ops-server-deploy.md` §3.5 或直接写个只读
> `SELECT COUNT(*)` 的一次性脚本，不用留。

> ⚠️ 本机平台现在**服务还开着、还在用**（用户 2026-09-24 明确交代过「云服务迭代版本那里现在服务还启着用着更新着呢」）。搬之前先跟相关人说一声再停，别硬停。
>
> 搬完记得 `rm -rf .scratch/migrate/` —— 里面有 `platform.db` 副本，**含真实密码哈希**，
> 不要留在工作区。

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

> 命令以 `docs/ops-server-deploy.md` §3.5 为准 —— 那边是 2026-10-09 实跑验证过的版本，
> 含打包后自检和服务器端六项验收。这里是要点摘录。

```bash
# ① 停掉本机服务（Ctrl+C）
#    ★ 别指望 WAL 会自动合并，见坑 1 —— 实测停服后 WAL 仍有 4.1MB
ls -la data/platform.db data/platform.db-wal

# ② 进项目目录，做 VACUUM INTO 单文件快照
cd "E:/PMWork/Project Materials/iSolarCloudProject/迭代版本/iSolarCloudProjectManage"
#    ...（快照脚本与验证见坑 1）

# ③ 打包
#    ★ --exclude 必须写在文件列表【前面】
#    ★ data/sso 必须排除（会把服务器打回 debug:true 联调模式）
#    ★ platform.db-wal / -shm 不再单独打包，快照已含 WAL 内容
tar -czf pmwork-data.tar.gz \
  --exclude='data/iteration/state.json.CORRUPT-*' \
  --exclude='data/sso' \
  data/platform.snapshot.db \
  data/iteration data/archive data/plan data/project data/budget \
  data/token data/skill data/pradapter data/notify \
  data/dingtalk data/tb data/auth-config.json data/state.json

ls -lh pmwork-data.tar.gz      # 预期 3~4 MB

# ④ 打包后自检（别省）
tar -tzf pmwork-data.tar.gz | grep CORRUPT && echo '★ 有坏样本' || echo '✓ 干净'
tar -tzf pmwork-data.tar.gz | grep 'data/sso' && echo '★ 混进 sso' || echo '✓ 干净'
md5sum pmwork-data.tar.gz
tar -xzOf pmwork-data.tar.gz data/platform.snapshot.db | md5sum
```

### 步骤 2：传到服务器

```bash
# Linux 服务器
scp pmwork-data.tar.gz 用户名@10.63.139.103:/Olivia/pmwork/

# Windows 服务器（用 WinSCP 图形化传，或 PowerShell 的 scp）
```

### 步骤 3：服务器上解包

```bash
cd /Olivia/pmwork

# ★ 先备份现状，出事能整套回退
systemctl stop pmwork
cp -r data data.bak-before-full-migrate

# 校验包（md5 与步骤 1 ④ 记下的值对比）
md5sum pmwork-data.tar.gz
gzip -t pmwork-data.tar.gz && echo '✓ 压缩包完整'

tar -xzf pmwork-data.tar.gz

# 快照改名成平台正式用的库
mv data/platform.snapshot.db data/platform.db

# ★ 删掉旧 WAL/SHM —— -wal 绑定具体主库，换库还留着旧 -wal 会直接判损坏
rm -f data/platform.db-wal data/platform.db-shm
```

### 步骤 4：对照校验清单逐条确认

解包完**必须**跑一遍这个，别跳：

```bash
cd /Olivia/pmwork

# ① 账号数应该是 373
node -e "const db=require('./db');console.log('账号数:',db.listUsers().length)"

# ② 迭代数据不是空的（本机约 319740 字节）
ls -la data/iteration/state.json

# ③ 钉钉通讯录在（gitignore 的，只能靠搬）—— 「按姓名推送」靠它
ls -la data/dingtalk/org.json          # 预期 103200 字节

# ④ SSO 仍是生产模式 ★ 别漏这一条
grep '"debug"' data/sso/secret.json    # 预期 false

# ⑤ 归档数量对得上本机（本机现在是 3）
ls data/archive/*.json | wc -l
```

**预期**：① 输出 `账号数: 373`；④ 输出 `false`；⑤ 与本机数字**完全一致**。

对不上就别往下走，先把对应文件重传一遍。

---

## 六、回滚

搬过去之后如果发现问题要退回本机：

1. 服务器停服
2. 本机 `data/` 目录**先整个复制一份留底**（`cp -r data data.bak-20261009`）
3. 本机的原始数据始终没被改动过（搬运是复制，不是移动），所以回滚 = 直接用本机那份
4. **唯一要小心的是**：如果服务器已经跑了一段时间、产生了新数据，回滚会丢掉那部分。所以**服务器上线前，本机先停用**，避免两边同时写入

> **2026-10-09 之后的回滚变简单了**：服务器上服务跑起来之前先做过
> `cp -r data data.bak-before-full-migrate`，所以服务器端的回退不用找回本机，
> 直接：
> ```bash
> systemctl stop pmwork
> cd /Olivia/pmwork
> mv data data.broken
> mv data.bak-before-full-migrate data
> systemctl start pmwork
> ```

---

## 七、搬完之后的两条纪律

1. **服务器成为唯一数据源**。搬完就让本机停止写入，否则两边数据分叉，之后再想合并会非常痛苦。

2. **`data/` 要备份**。服务器上的 `data/` 现在是唯一副本了。

   **用仓库自带的 `backup.js`，不要裸 tar** —— 它会先对 `platform.db` 做
   `PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 合并回主库，再整体复制。
   裸 tar 在服务运行时**会拷出半截数据库**（SQLite 页写到一半），恢复时打不开，
   而且这个问题在备份成功的日志里完全看不出来。

   ```bash
   mkdir -p /Olivia/backup
   cd /Olivia/pmwork

   # ① 手动跑一次验证（必须用 node22，backup.js 依赖 node:sqlite）
   BACKUP_DIR=/Olivia/backup /Olivia/node22/bin/node backup.js

   # ② 校验副本与生产库是同一份
   md5sum data/platform.db /Olivia/backup/backup-<时间戳>/data/platform.db

   # ③ 两条哈希一致后挂 cron（管道追加，不用进 vi）
   (crontab -l 2>/dev/null; echo '0 2 * * * cd /Olivia/pmwork && BACKUP_DIR=/Olivia/backup /Olivia/node22/bin/node backup.js >> /Olivia/backup/backup.log 2>&1') | crontab -
   crontab -l
   ```

   保留最近 30 份，每份约 66MB（原样复制不压缩），峰值约 2GB。
   目录名用 **UTC 时间**，本地凌晨 2 点跑出的名字是前一天的 UTC 日期。

   完整说明见 `docs/ops-server-deploy.md` §9.2。

---

## 相关文档

- `docs/ops-server-deploy.md` — 登录服务器、部署代码、启动服务、备份的详细操作步骤（**搬迁命令以此为准**）
- `docs/ops-manual.md` — 平台日常运维（账号、权限、审计）
- `docs/plan-identity-and-dingtalk.md` — SSO / 钉钉接入的背景与回调地址约定
- `部署指南.md` — ⚠️ 已过时，仅作历史参考（讲的是老的 8770 端口与无账号体系版本）
