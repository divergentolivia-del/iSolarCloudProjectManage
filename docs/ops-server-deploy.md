# 服务器部署操作手册 · 登录 / 部署 / 启动

> 目标机器：`10.63.139.103`，端口 **9680**，访问地址 `http://10.63.139.103:9680`
>
> ⚠️ **端口 9680 不是随便定的** —— 它是公司 SSO 回调白名单里**登记过的值**（`http://10.63.139.103:9680/sso/callback`）。改端口必须同步去「流程数字化中心」变更回调地址，否则 SSO 跳到旧端口会被拒绝。详见 `docs/plan-identity-and-dingtalk.md`。
>
> 数据搬迁见另一份：`docs/plan-server-migration.md`。本文只讲**从零把服务跑起来**。

---

## 〇、开始之前：三个前置条件

| 项 | 要求 | 怎么确认 | 不满足会怎样 |
|---|---|---|---|
| **Node.js** | **≥ v22.5** | `node -v` | 启动即报 `Cannot find module 'node:sqlite'`，服务起不来 |
| **端口 9680** | 服务器上没被占用 | `netstat -ano \| findstr :9680`（Windows）<br>`ss -lntp \| grep 9680`（Linux） | 启动报 `EADDRINUSE` |
| **代码仓库权限** | 能 clone 到 `dev/sgai` | 见步骤 2 | 拉不到代码 |

> **为什么 Node 要 22.5 以上**：`db.js` 用的是 Node 内置的 `node:sqlite` 模块，这是 22.5 才引入的。本机跑的是 v24.12.0。注意 `start.sh` 里那段安装脚本装的是 v20，**不够用**，别照抄。
>
> 版本够了之后，每次启动仍会有一行 `ExperimentalWarning: SQLite is an experimental feature`。**这是正常的**，不是错误。

---

## 一、登录服务器

### 1.1 Linux 服务器

```bash
ssh 你的用户名@10.63.139.103
# 首次连接会问是否信任主机指纹，输入 yes
# 然后输入密码（或走密钥）
```

如果公司要求走跳板机：

```bash
ssh -J 跳板机用户名@跳板机地址 你的用户名@10.63.139.103
```

### 1.2 Windows 服务器

用 **远程桌面（mstsc）**：Win+R → `mstsc` → 计算机填 `10.63.139.103` → 输入账号密码。

之后所有命令在**服务器上的** PowerShell 或 CMD 里执行。

> ⚠️ PowerShell 不认 `set` 命令（会当成查看变量、静默什么都不设）。设置环境变量用：
> - CMD：`set AUTH_REQUIRED=1`
> - PowerShell：`$env:AUTH_REQUIRED=1`
> - 或者直接用 `start.bat`，它内部已经处理好了

### 1.3 登录后先确认环境

```bash
# 我是谁、这是哪台机器
whoami && hostname

# Node 版本 —— 必须 ≥ v22.5
node -v

# git 在不在
git --version

# 端口空不空（有人占了就得先处理）
# Windows：
netstat -ano | findstr :9680
# Linux：
ss -lntp | grep 9680
```

**没输出 = 端口空着 = 可以往下走。**

---

## 二、部署代码

### 2.1 选目录

约定用 `/opt/pmwork`（Linux）或 `D:\pmwork`（Windows）。本文统一写作 `/opt/pmwork`，Windows 上对应替换。

```bash
# Linux
sudo mkdir -p /opt/pmwork && sudo chown -R $USER /opt/pmwork
cd /opt/pmwork

# Windows（管理员 CMD）
mkdir D:\pmwork && cd /d D:\pmwork
```

### 2.2 clone 代码

```bash
git clone https://github.com/divergentolivia-del/iSolarCloudProjectManage.git pmwork
cd pmwork

# ★ 切到 dev/sgai —— 所有改动都在这条线上，main 是验收快照
git checkout dev/sgai
git log --oneline -5        # 确认拿到的是最新提交
```

> **为什么是 `dev/sgai` 而不是 `main`**：按项目约定，所有改动一律推 `origin/dev/sgai`，用户验收通过后才合并回 `main`。`main` 上的代码是「上次验收时冻结的样子」，不是最新的。
>
> commit 太多导致 clone 慢的话，可以只拉最近一次历史：
> ```bash
> git clone --depth 1 -b dev/sgai https://github.com/divergentolivia-del/iSolarCloudProjectManage.git pmwork
> ```

### 2.3 clone 完你会看到什么（★ 重要）

**clone 下来的是一个「没有数据、没有任何凭据」的代码骨架。** 这不是出错，是因为 `.gitignore` 把真实的工时数据、账号库、密钥都排除了。

对照检查：

```bash
ls data/platform.db          # 预期：不存在
ls data/iteration/state.json # 预期：不存在
ls data/sso/secret.json      # 预期：不存在
```

**这三个都不存在是正常的**，靠 `docs/plan-server-migration.md` 那份文档搬过来。

### 2.4 目录权限

服务需要对 `data/` 有读写权限：

```bash
# Linux
chmod -R u+rwX /opt/pmwork/pmwork/data
```

Windows 上一般用管理员账号运行，不需要额外设置。

---

## 三、搬数据（紧接着做，别跳）

**没有数据，服务能起来但没人能登录、页面全空。**

完整步骤见 `docs/plan-server-migration.md`，这里只给最小路径：

```bash
cd /opt/pmwork/pmwork

# 从上一步的 tar 包解出来（包是 scp 传过来的）
tar -xzf /opt/pmwork/pmwork-data.tar.gz

# 关键三件套必须都在
ls -la data/platform.db data/iteration/state.json data/sso/secret.json

# 账号数应该是 373
node -e "const db=require('./db');console.log('账号数:',db.listUsers().length)"
```

**`账号数: 373` 对上了再往下走。** 对不上说明 `platform.db` 没搬对（常见原因：只拷了 `.db` 漏了 `-wal`，见迁移文档坑 1）。

---

## 四、启动服务

### 4.1 先手动跑一次（前台，看日志）

**这一步一定要在前台跑** —— 只有在前台你才能第一时间看到报错。

```bash
cd /opt/pmwork/pmwork

# 前台启动，日志直接打在屏幕上
node server.js 9680
```

**看到这些说明成功了**：

```
启动 iSolarCloud 项目管理工作台
  端口: 9680
  数据: ...
(…) ExperimentalWarning: SQLite is an experimental feature     ← 正常，忽略
服务已启动: http://10.63.139.103:9680
```

> `ExperimentalWarning` 那一行不是错误，是 Node 对内置 SQLite 模块的例行提醒。

**验证**：

```bash
# 服务器本机自测（另开一个终端）
curl http://localhost:9680/login.html
# 返回一堆 HTML = 服务活着

# 回到你的电脑上，浏览器打开：
#   http://10.63.139.103:9680
```

### 4.2 打不开？按这个顺序排查

**① 服务器本机 curl 通不通？**

| 结果 | 说明 | 下一步 |
|---|---|---|
| 本机 curl 不通 | 服务没起来 | 看前台终端的报错，通常是 Node 版本或端口被占 |
| 本机 curl 通、外部打不开 | 防火墙或网络策略 | 走 ② |

**② 放行端口 9680**

```bash
# Linux（firewalld）
sudo firewall-cmd --add-port=9680/tcp --permanent && sudo firewall-cmd --reload

# Linux（ufw）
sudo ufw allow 9680/tcp

# Windows（管理员 CMD）
netsh advfirewall firewall add rule name="pmwork-9680" dir=in action=allow protocol=TCP localport=9680
```

**③ 还不行** → 找运维确认网络策略是否限制该网段/端口。

> **为什么绑的不是 127.0.0.1**：`server.js` 里的 `server.listen(PORT, ...)` **没传 host 参数**，等于绑所有网卡（`0.0.0.0`），所以同一内网的同事都能访问。这是对的，不用改。

### 4.3 停掉前台进程

前台跑着的按 `Ctrl+C`。**下一步要把它做成常驻服务**，否则你关掉 SSH 窗口服务就停了。

---

## 五、做成开机自启的常驻服务

### 5.1 Linux（systemd，推荐）

新建 `/etc/systemd/system/pmwork.service`：

```ini
[Unit]
Description=iSolarCloud 项目管理工作台
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/pmwork/pmwork
ExecStart=/usr/bin/node /opt/pmwork/pmwork/server.js 9680
Restart=always
RestartSec=5

# ★ 启用真实登录（账号 + 密码 + 会话）
Environment=AUTH_REQUIRED=1

# ★ 数据放项目目录下，与 .gitignore 和代码里的路径一致
#   不要指向别处 —— 有几个脚本写死了 data/ 路径，不跟随 DATA_DIR
# Environment=DATA_DIR=/opt/pmwork/pmwork/data

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable pmwork     # 开机自启
sudo systemctl start pmwork
sudo systemctl status pmwork     # 确认是 active (running)
```

日常操作：

```bash
sudo systemctl restart pmwork            # 重启
sudo systemctl stop pmwork               # 停止
sudo journalctl -u pmwork -f             # 实时看日志（排障必用）
sudo journalctl -u pmwork --since "10 min ago"   # 看最近 10 分钟
```

### 5.2 Windows Server（nssm）

下载 nssm（nssm.cc），管理员 CMD 执行：

```cmd
nssm install pmwork "C:\Program Files\nodejs\node.exe" "D:\pmwork\pmwork\server.js"
nssm set pmwork AppDirectory D:\pmwork\pmwork
nssm set pmwork AppEnvironmentExtra AUTH_REQUIRED=1
nssm set pmwork AppStdout D:\pmwork\pmwork\server.log
nssm set pmwork AppStderr D:\pmwork\pmwork\server-error.log
nssm start pmwork
nssm status pmwork
```

日志在 `server.log` / `server-error.log` 里看。也可以装完之后去「服务」管理器里手动启停。

### 5.3 不装服务时的临时解法

```bash
# Linux：nohup + 后台
nohup node server.js 9680 >> server.log 2>&1 &

# 看日志
tail -f server.log

# 停掉
pkill -f "node server.js"
```

⚠️ 这种方式**重启服务器就没了**，只适合临时验证。

---

## 六、首次启用登录（重要，顺序不能反）

`AUTH_REQUIRED=1` 打开后，所有人都会被要求登录。如果账号库没准备好，等于把所有人挡在门外。

**正确顺序**：

1. **先不带 `AUTH_REQUIRED` 启动一次**，确认页面能打开、数据都在：
   ```bash
   node server.js 9680
   ```
2. **确认账号库里有 admin**：
   ```bash
   node -e "const d=require('./db');console.table(d.listUsers().filter(u=>u.role==='admin'))"
   ```
   - 有 → 用现有 admin 账号密码登录
   - 没有 → 首次启动时日志会打印一次性随机密码：`首次建库：默认管理员 admin，随机密码 xxxx`。**记下来，登录后立刻改掉**（这个密码只打印一次）
3. **再带 `AUTH_REQUIRED=1` 启动**，验证能登录进去
4. 确认无误后，把它写进 systemd 的 `Environment=` 或 nssm 的 `AppEnvironmentExtra`，做成常驻

---

## 七、验收 SSO 登录（必须在服务器上做）

> ⚠️ **SSO 无法在你笔记本上验证，只能在 `10.63.139.103` 上验。** 两个原因，缺一不可：
>
> **① `redirect_uri` 必须逐字节匹配。** SSO 侧登记的是 `http://10.63.139.103:9680/sso/callback`，你在笔记本上跑，回调地址就变成了 `http://localhost:9680/sso/callback`，SSO 会直接拒绝。
>
> **② `state` 防重放 nonce 存在发起登录那个进程的内存里。** `modules/sso/routes.js` 里是 `_nonces = new Map()`，登录请求由笔记本实例发出，nonce 就存在笔记本实例的内存；SSO 回跳到 `10.63.139.103:9680` 时，接请求的是**服务器实例**，它的 Map 里没这个 nonce，于是拒绝，报「state 校验失败」。
>
> **这不是矛盾** —— 你之前提到的即时激励平台，团队之所以能用，正是因为它**本来就跑在 `10.63.139.103` 上**，发起登录和接收回调是同一个进程。同一个道理。

### 验收步骤

1. **先确认凭据齐全**。`data/sso/secret.json` 里 `clientSecret` **不能还是占位符**（占位符会让 `/sso/login` 直接返 503）：
   ```bash
   node -e "const s=require('./data/sso/secret.json');console.log('clientId:',s.clientId);console.log('secret长度:',String(s.clientSecret||'').length)"
   ```
   真实密钥应该是几十位的串。若只有 6 个字符，说明还是占位符，要先去「流程数字化中心」拿真值。

2. **确认三条 URL 指向的是你要验的环境**。见第八节 —— 当前值指向 SIT 环境，需要你确认这是不是有意为之。

3. 浏览器打开 `http://10.63.139.103:9680`，登录页应出现「公司统一认证登录」按钮（配好了才显示）。
4. 点击 → 跳到公司 SSO 认证页 → 输入公司账号 → 回跳到平台。
5. **看审计日志确认登录方式**：
   ```bash
   node -e "const d=require('./db');console.log(d.getAudit(10).filter(a=>a.module==='auth'))"
   ```

**先在联调模式跑一遍更好**：若 `secret.json` 里 `debug: true`，SSO 回调后**只把工号显示在页面上，不建会话、不让人进平台**。第一次接通时挂着它确认工号对得上，再改回 `false`。

---

## 八、验收钉钉登录

### 8.1 要准备什么

`data/dingtalk/secret.json` 需要四项（模板见 `docs/samples/dingtalk-secret.sample.json`）：

| 字段 | 从哪拿 | 备注 |
|---|---|---|
| `appKey` | 钉钉开放平台 → 应用信息 | 已有 |
| `appSecret` | 同上 | 已有 |
| `operatorId` | 钉钉后台 userId | 已有 |
| **`corpId`** | **钉钉管理后台 → 首页 → 企业信息** | ⚠️ **当前缺这个，需要你去后台拿** |

检查当前配置：

```bash
node -e "const c=require('./modules/dingtalk/client');console.log(JSON.stringify(c.loadConfig(),(k,v)=>/secret/i.test(k)?'[已填]':v,2))"
node -e "console.log('登录配置齐全:',require('./modules/dingtalk/client').isLoginConfigured())"
```

**`corpId` 没填的表现**：登录页**不显示**「钉钉一键登录」按钮。这是刻意的 —— 宁可没有入口，也不要摆个点了报错的按钮。

### 8.2 为什么钉钉能在内网 IP 上用，SSO 却不行

两条路的技术差别，是这次能打通的关键：

| | SSO | 钉钉免登 |
|---|---|---|
| 流程 | 浏览器 → SSO 页 → **SSO 跳回平台** | 钉钉客户端内页面 → JSAPI 拿 authCode → **前端 POST 给平台** |
| 谁发起回跳 | 公司 SSO 服务器 | 无回跳 |
| 要不要登记回调域名 | **要**，且纯内网 IP 登记不了 | **不要** |
| 内网 IP 可用？ | 只能靠登记过的那个 IP | **直接可用** |

**钉钉服务器全程不访问平台**，所以没有回调白名单这回事，`10.63.139.103:9680` 直接能用。

### 8.3 验收步骤

1. **在钉钉管理后台把平台配成工作台应用卡片**，地址填 `http://10.63.139.103:9680`。
   > 这是免登体验的关键：员工**从工作台点卡片进来**时，页面 UA 里带 `DingTalk`，登录页会**自动免登**，连按钮都不用点。直接在普通浏览器里输网址打开则只能走账号密码。
2. 从钉钉工作台点开卡片 → 应该**自动登录进去**，直接落到首页。
3. 验证身份打通与权限透传：
   ```bash
   # 在服务器上，看审计日志里的登录记录
   node -e "const d=require('./db');console.log(d.getAudit(20).filter(a=>/钉钉/.test(a.action||'')))"
   ```
   预期看到 `钉钉免登（角色 xxx，匹配方式 dingtalk_id 或 jobNumber，权限透传 已建立）`。
4. 页面右上角用户菜单 → 或直接访问 `http://10.63.139.103:9680/api/dingtalk/me` 看绑定状态：
   ```json
   { "bound": true, "dingtalkId": "...", "passthrough": true, "passthroughExpiresIn": 7100 }
   ```
   `passthrough: true` 就是「权限透传确实通了」的证据。

### 8.4 身份是怎么匹配上的

三道匹配，逐级降级（`modules/dingtalk/routes.js` 的 `matchUser`）：

1. `users.dingtalk_id` —— 已经绑过的，最快最准
2. **工号 = `users.id`** —— 主口径。工号稳定、唯一，且与 SSO 的 `idField: userNo` 同口径
3. ~~姓名~~ —— **刻意不做**。重名会认错人，认错人比不让进更糟

**匹配不上会被明确拒绝并记审计，不会静默建号** —— 否则等于「全公司两万人谁用钉钉点一下就能进平台」。

被拒绝时的提示会带上钉钉 userId 和工号，方便你去「系统设置 → 用户管理」核对。

---

## 九、日常运维速查

### 9.1 升级代码

```bash
cd /opt/pmwork/pmwork
sudo systemctl stop pmwork           # 先停，避免 data/ 写入到一半

git fetch origin dev/sgai
git log HEAD..origin/dev/sgai --oneline    # 看看要更新什么
git pull origin dev/sgai

# data/ 目录不要动 —— 代码升级不动数据，数据格式向后兼容
sudo systemctl start pmwork
sudo journalctl -u pmwork -n 50      # 确认启动无报错
```

> ⚠️ **`git pull` 前先确认本地没有未提交改动**（`git status`）。服务器上**不应该**改代码 —— 所有改动都在本机做完、推到 `dev/sgai`，服务器只负责拉。

### 9.2 备份数据

服务器上的 `data/` 现在是**唯一数据源**，必须备份。

```bash
# Linux：加进 crontab -e
0 2 * * * tar -czf /backup/pmwork-$(date +\%Y\%m\%d).tar.gz /opt/pmwork/pmwork/data
find /backup -name 'pmwork-*.tar.gz' -mtime +30 -delete     # 保留 30 天
```

⚠️ **备份 `platform.db` 时要连 `-wal` `-shm` 一起**，或者先停服再备。只备 `.db` 会缺最近的写入。

### 9.3 账号管理

走界面：admin 登录 → 用户管理（建账号、改角色、停用、重置密码）。

界面进不去时走命令行：

```bash
cd /opt/pmwork/pmwork

# 看所有用户
node -e "const d=require('./db');console.table(d.listUsers())"

# 重置密码
node -e "require('./db').setPassword('工号','新密码'); console.log('已重置')"

# 改角色（admin / pm / dev / viewer）
node -e "require('./db').setRole('工号','pm'); console.log('已改')"
```

`data/auth-config.json` 里是批量建号的初始密码规则，改完重启生效。

### 9.4 常见问题

| 现象 | 最可能的原因 | 怎么办 |
|---|---|---|
| 启动报 `Cannot find module 'node:sqlite'` | Node < 22.5 | 升级 Node |
| 启动报 `EADDRINUSE` | 9680 被占 | `netstat -ano \| findstr :9680` 找进程，或换端口（**但换端口要同步改 SSO 回调登记**） |
| 页面打开但没人能登录 | `platform.db` 没搬对 | 查账号数是不是 373，见迁移文档坑 1 |
| 登录页没有 SSO 按钮 | `clientSecret` 还是占位符 | 去拿真实凭据，见 7.1 |
| 登录页没有钉钉按钮 | `corpId` 没填 | 去钉钉后台拿，见 8.1 |
| SSO 登录报 state 校验失败 | 在笔记本上验的 | 必须在服务器上验，见第七节 |
| 钉钉点了没反应 | 不在钉钉客户端里打开的 | 从钉钉工作台卡片进入，见 8.3 |
| 每次启动都有 ExperimentalWarning | 正常的 | 忽略 |

---

## 十、验收清单（打勾用）

- [ ] 服务器 Node 版本 ≥ v22.5
- [ ] 9680 端口空闲
- [ ] 代码 clone 到 `dev/sgai` 且是最新提交
- [ ] `data/` 数据已搬，账号数 = 373
- [ ] `data/sso/secret.json`、`data/dingtalk/secret.json`、`data/tb/secret.json` 三个都在
- [ ] 前台启动一次，看到「服务已启动」，无报错
- [ ] 服务器本机 `curl http://localhost:9680/login.html` 有返回
- [ ] 笔记本浏览器能打开 `http://10.63.139.103:9680`
- [ ] 防火墙放行 9680（如需）
- [ ] 做成 systemd / nssm 常驻服务，开机自启
- [ ] 用现有账号密码能登录进去
- [ ] 首页数据与本机一致
- [ ] SSO 真实登录走通（在服务器上验）
- [ ] 钉钉免登走通（`corpId` 填好后）
- [ ] 备份定时任务已配

---

## 相关文档

- `docs/plan-server-migration.md` — 本地数据全搬服务器的方案（含三个坑）
- `docs/ops-manual.md` — 平台日常运维（账号、权限、审计）
- `docs/plan-identity-and-dingtalk.md` — SSO / 钉钉接入的背景与回调地址约定
- `docs/plan-dingtalk-sso.md` — 钉钉 + SSO 实施计划
- `docs/samples/sso-secret.sample.json` — SSO 凭据模板
- `docs/samples/dingtalk-secret.sample.json` — 钉钉凭据模板
