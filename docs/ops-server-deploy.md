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
| **glibc** | **≥ 2.28**，否则改用 glibc-217 构建 | `getconf GNU_LIBC_VERSION` | 见 〇.2 —— 老系统装不了官方 Node 22 |
| **端口 9680** | 服务器上没被占用 | `ss -lntp \| grep 9680`（Linux）<br>`netstat -ano \| findstr :9680`（Windows） | 启动报 `EADDRINUSE` |
| **能访问外网** | github.com / nodejs.org 可达 | `curl -sI https://nodejs.org \| head -1` | 拉不到代码也装不了 Node |

> **为什么 Node 要 22.5 以上**：`db.js` 用的是 Node 内置的 `node:sqlite` 模块，这是 22.5 才引入的。本机跑的是 v24.12.0。注意 `start.sh` 里那段安装脚本装的是 v20，**不够用**，别照抄。
>
> 版本够了之后，每次启动仍会有一行 `ExperimentalWarning: SQLite is an experimental feature`。**这是正常的**，不是错误。

> **好消息**：本项目**零依赖**（`package.json` 的 `dependencies` 是空的），
> **不需要 `npm install`**，也不需要编译任何原生模块。老服务器上只要能跑起
> `node` 这一个二进制就够了。

### 〇.1 系统体检（先跑这四条，再决定怎么装）

```bash
cat /etc/os-release          # 什么发行版
uname -m                     # 架构，x86_64 才对应 linux-x64 包
getconf GNU_LIBC_VERSION     # ★ glibc 版本，决定装哪一种 Node
ss -lntp | grep 9680         # 端口空不空（没输出 = 空着）
```

**怎么读 glibc 那一行**：

| 输出 | 含义 | 走哪条路 |
|---|---|---|
| `glibc 2.17` | CentOS 7 / RHEL 7 一类的老系统 | **〇.2 路线 A**（glibc-217 构建） |
| `glibc 2.28` 及以上 | 较新的系统 | **〇.2 路线 B**（官方包） |

> **怎么看出是 CentOS 7**：`cat /etc/os-release` 里 `VERSION="7 (Core)"`。
> 另一个旁证是 `git --version` —— CentOS 7 出厂的 git 是 `1.8.3.1`，见到这个版本号
> 基本可以断定是老系统。

### 〇.2 装 Node 22

**路线 A · glibc 2.17（老系统）**

Node 官方专门为老系统构建了 `glibc-217` 版本 —— **代码和官方一致，只是换了个
编译目标**，直接解压就能跑。

```bash
# 挑一个 v22.x 版本号替换（22 整条线都 ≥ 22.5，满足要求）
VER=v22.20.0

mkdir -p /opt/node/22 && cd /opt/node
curl -LO "https://unofficial-builds.nodejs.org/download/release/${VER}/node-${VER}-linux-x64-glibc-217.tar.gz"
tar -xzf "node-${VER}-linux-x64-glibc-217.tar.gz" -C /opt/node/22 --strip-components=1

/opt/node/22/bin/node -v      # 能打印版本号才算解压对了
```

版本号自己去这个目录列表挑一个：`https://unofficial-builds.nodejs.org/download/release/`

装上 PATH：

```bash
echo 'export PATH=/opt/node/22/bin:$PATH' >> /etc/profile
source /etc/profile
node -v
```

> ⚠️ **绝对不要去升级系统 glibc。** 那是能把机器搞挂的操作（可能连带 yum、ssh 一起坏掉），
> 而 `glibc-217` 构建就是为了让你不必碰它。

**路线 B · glibc ≥ 2.28（较新系统）**

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo yum install -y nodejs
node -v
```

**★ 装完必须验这一条** —— 唯一能证明「平台起得来」的测试：

```bash
node -e "const {DatabaseSync}=require('node:sqlite'); console.log('node:sqlite 可用')"
```

**打印出「node:sqlite 可用」才算过。** 报 `Cannot find module 'node:sqlite'`
说明版本还是不够，回上面对一下 `node -v`。

---

## 一、登录服务器

> **本文假设服务器是 Linux，你在自己的笔记本上开终端 SSH 连过去操作。**
>
> 登录方式：`ssh 用户名@10.63.139.103` + 密码（服务器管理员给你的那套）。
> 连上之后，下面**所有命令都在这个 SSH 窗口里敲**，命令提示符会从你笔记本的
> 变成服务器的主机名 —— 这是判断「我现在是在服务器上还是在本机」的最直接依据。
>
> ⚠️ **最容易出错的地方就在这一步**：你笔记本上也要开一个终端来打包数据（第三节）。
> 两个窗口长得一样，敲错窗口的后果是命令作用在本机或服务器上完全反了。
> 建议**服务器窗口**的标题或背景色改一下，并在动手前用 `hostname` 确认一次。

### 1.1 从笔记本连上去

在**笔记本**上开终端（Windows 用 PowerShell / CMD / Git Bash 都行）：

```bash
ssh 你的用户名@10.63.139.103
```

会依次看到：

```
The authenticity of host '10.63.139.103' can't be established.
ED25519 key fingerprint is SHA256:xxxxx...
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

**输入 `yes` 回车**（只在首次连接时问一次）。然后：

```
你的用户名@10.63.139.103's password:
```

**输入密码**（敲的时候屏幕上不显示任何字符，这是正常的，不是卡住），回车。

成功后提示符会变成类似：

```
[用户名@服务器主机名 ~]$
```

**看到这个才说明登进去了。**

> **密码里有哪些字符要小心**：如果密码含 `!` `$` `` ` `` `\` 等，在某些终端里会被解释。
> 直接输密码时不受影响（走的是终端密码通道，不做 shell 展开）；但**不要**用
> `ssh 用户@IP -p'密码'` 这类写法，那会真的展开。
>
> **连接超时/拒绝**（`Connection timed out` / `Connection refused`）：
> 说明 22 端口到不了服务器，找服务器管理员确认 SSH 端口和网络策略，
> 或者改用远程桌面（1.2）。

如果公司要求走跳板机：

```bash
ssh -J 跳板机用户名@跳板机地址 你的用户名@10.63.139.103
```

### 1.2 如果服务器是 Windows（走远程桌面）

服务器管理员确认是 Windows 的话，SSH 那条路不一定通（要额外装 OpenSSH Server），
改用远程桌面：

Win+R → `mstsc` → 计算机填 `10.63.139.103` → 输入账号密码。

进去之后所有命令在**服务器上的** PowerShell 或 CMD 里执行 —— 这种情况下
**没有「本地/服务器」两个窗口的问题**，因为你不是从笔记本传过去的，是在服务器本机上操作。

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
# ★ 服务器是 Linux 就用这一条：
ss -lntp | grep 9680
# ⚠️ 只有当服务器确实是 Windows 时，才用下面这条
#    （findstr 是 Windows 命令，Linux 上会报 findstr: command not found）
# netstat -ano | findstr :9680
```

**没输出 = 端口空着 = 可以往下走。**

> **Node 版本不对就别往下走了** —— v22.5 以下平台起不来。
> 装法见 **〇.2**，先跑 `getconf GNU_LIBC_VERSION` 确认走 A 还是 B。

---

## 二、部署代码

### 2.1 选目录

**项目目录就一层，不要套两层。** 约定：

| 系统 | 项目目录 | 打包文件放哪 |
|---|---|---|
| Linux | `/opt/pmwork` | `/opt/pmwork-data.tar.gz`（项目目录的**上一级**） |
| Windows | `D:\pmwork` | `D:\pmwork-data.tar.gz` |

```bash
# Linux
sudo mkdir -p /opt/pmwork && sudo chown -R $USER /opt/pmwork
cd /opt/pmwork
pwd            # 必须是 /opt/pmwork

# Windows（管理员 CMD）
mkdir D:\pmwork && cd /d D:\pmwork
```

> **为什么强调「一层」**：数据包要落在项目目录的**上一级**，解包时才能 `tar -xzf ../pmwork-data.tar.gz` 一步到位。如果套成 `/opt/pmwork/pmwork`（clone 时不加结尾那个点就会变成这样），包和解包路径都要多一级，容易和本文档后续命令对不上。

### 2.2 clone 代码

**Linux 服务器（SSH 登录后，就在 SSH 窗口里执行）**：

```bash
cd /opt/pmwork

git clone https://github.com/divergentolivia-del/iSolarCloudProjectManage.git .
#            ↑ 注意结尾这个点：把代码直接放进当前目录，
#              不要再建一层 pmwork 子目录 —— 见 2.1 的说明

# ★ 切到 dev/sgai —— 所有改动都在这条线上，main 是验收快照
git checkout dev/sgai
git log --oneline -3        # 确认拿到的是最新提交
```

**`git log` 看到这三条就对上了**（新 → 旧）：

```
f8e7f24 docs(deploy): 按服务器实况修正 —— 补齐 Node 升级路径与 git 过旧的兜底
edb3c38 docs(deploy): 补齐 SSH 登录/拉码/验收全流程 —— 登录数据可不停服搬
4d18aac fix(sso): 补齐 /sso/logout 的分发与门禁白名单 —— 退出登录点了没反应
```

看到的是别的提交 = 没拉到最新，回头检查分支和网络。

> 这三条是**写文档时的样子**，你拉的时候多半已经更新了 ——
> **关键不是逐字对上，而是确认第一行是个较新的提交、且分支是 `dev/sgai`**。

> **`git clone` 末尾那个点是什么意思**：不加点会建出 `/opt/pmwork/iSolarCloudProjectManage/` 一层子目录，和本文档后面所有 `cd /opt/pmwork` 都对不上。加了点就是「克隆到当前目录」。
>
> **如果 `/opt/pmwork` 已经非空**（比如上一级已有文件），`git clone` 到当前目录会报 `destination path '.' already exists and is not an empty directory`。那就反过来做：
> ```bash
> cd /opt/pmwork
> git clone https://github.com/divergentolivia-del/iSolarCloudProjectManage.git
> mv iSolarCloudProjectManage/* iSolarCloudProjectManage/.git .
> rmdir iSolarCloudProjectManage
> ```

> **为什么是 `dev/sgai` 而不是 `main`**：按项目约定，所有改动一律推 `origin/dev/sgai`，用户验收通过后才合并回 `main`。`main` 上的代码是「上次验收时冻结的样子」，不是最新的。
>
> commit 太多导致 clone 慢的话，可以只拉最近一次历史：
> ```bash
> git clone --depth 1 -b dev/sgai https://github.com/divergentolivia-del/iSolarCloudProjectManage.git .
> ```

#### ★ 如果 git 太老，clone 失败 —— 绕开 git 直接下包

先在服务器上跑 `git --version` 看一眼。**`1.8.3.1` 是 CentOS 7 的出厂版本**（约 2011 年），
底层 openssl 大多还能协商 TLS 1.2，所以**大概率能用**；但万一报下面这类错，
说明是 git 太老谈不拢，**别再折腾 git，直接下压缩包**：

```
error: SSL connect error
fatal: unable to access '...': SSL certificate problem
fatal: HTTP request failed
error: RPC failed; result=22, HTTP code = 0
```

**绕行做法**（`curl` 走的是系统 openssl，比老 git 内嵌的那套靠谱得多）：

```bash
cd /opt/pmwork

curl -L -o pmwork.tar.gz \
  "https://codeload.github.com/divergentolivia-del/iSolarCloudProjectManage/tar.gz/refs/heads/dev/sgai"

tar -xzf pmwork.tar.gz --strip-components=1
rm pmwork.tar.gz

ls server.js data/      # 有 server.js 就对了
```

**代价要说清楚**：

| | 用 git clone | 用 tarball |
|---|---|---|
| 首次拿到代码 | ✅ | ✅ |
| 以后升级 | `git pull` 一条命令 | ❌ 改动会覆盖，**得重新下包** |
| 看提交历史 | ✅ `git log` | ❌ 没有 `.git`，看不到 |
| 切分支 | ✅ | ❌ 包就是 dev/sgai 那一个快照 |

所以 **tarball 是兜底，不是首选**。真要走这条路，**第一件事是先把 git 升上去**：

```bash
yum install -y https://repo.ius.io/ius-release-el7.rpm
yum install -y git236
git --version        # 看到 2.x 就成了，以后就能正常 clone / pull
```

（或者直接下源码编译。升完 git 后想改用 clone，把 `/opt/pmwork` 清空重来一遍即可。）

> ⚠️ **用 tarball 时要格外注意「别覆盖自己的改动」**。因为升级时是「重新下包 + 解压」，
> 会**直接盖掉已在服务器上改过的文件**。服务器上应该只有 `data/` 是本地产生的内容
> （且 `data/` 不在包里，不会被覆盖），代码本身**不要在服务器上手改** —— 改在本地改完推上来。

#### ★ 到这里【还不能】做 SSO 验收 —— 必须先搬数据

**`git checkout dev/sgai` 只解决「代码是最新的」，不解决「数据在不在」。**
clone 出来的目录里**没有账号库、没有 SSO 凭据**（都在 `.gitignore` 里，git 拉不到），
此时直接启动服务，表现是：

| 现象 | 原因 |
|---|---|
| 登录页只有「工号+密码」，**没有「公司统一认证登录」按钮** | `data/sso/secret.json` 不存在 → `/sso/status` 返 `configured:false` → 前端不渲染按钮（刻意设计，不摆点了报错的按钮） |
| 就算手输 `/sso/login` 跳过去、SSO 也认证成功了，回来是「**账号未开通**」 | `data/platform.db` 不存在 → 373 个账号一个都没有 → 换到的工号匹配不上 |

**三个文件是硬前置**（缺一个 SSO 就验不成）：

```bash
ls -la data/platform.db        # 373 个账号在里面
ls -la data/sso/secret.json    # client_id / client_secret / 四条 URL
ls -la data/auth-config.json   # 密码规则（非 SSO 必需，但一起搬省事）
```

搬法见下一节，完整方案见 `docs/plan-server-migration.md`。

> **⚠ 只拷 `data/` 目录、不要拷 `node_modules`**（本项目零依赖，没有这个目录，别从上位机带过来）。

### 2.3 clone 完你会看到什么（★ 重要）

**clone 下来的是一个「没有数据、没有任何凭据」的代码骨架。** 这不是出错，是因为 `.gitignore` 把真实的工时数据、账号库、密钥都排除了。

对照检查：

```bash
ls data/platform.db          # 预期：不存在  ← 没有账号库
ls data/sso/secret.json      # 预期：不存在  ← 没有 SSO 凭据
ls data/iteration/state.json # ⚠ 这个【会存在】，但内容不对，见下
```

> **`data/iteration/state.json` 是个例外，要看仔细。** 它的名字同时出现在
> `.gitignore` 里**和** git 的跟踪列表里（历史遗留），所以 clone 会带一份**上次提交时的旧版本**，
> **不是你现在的实时工时数据**。它是三个文件里唯一「看起来有、其实不对」的那个 ——
> 用 `ls` 判断会误以为数据齐了。
>
> 判断方法：看时间戳。
> ```bash
> ls -la data/iteration/state.json     # clone 下来的那份时间是「上次有人提交它」的时刻
> ```
>
> **第一趟搬登录数据不含它**，所以这时候 `state.json` 还是旧的 —— 不影响 SSO 验收
> （SSO 只依赖账号库和凭据）。第二趟全量搬会覆盖成正确的。

**这三个都当「缺失」处理**，靠第三节搬过来。

### 2.4 目录权限

服务需要对 `data/` 有读写权限：

```bash
# Linux
chmod -R u+rwX /opt/pmwork/data
```

Windows 上一般用管理员账号运行，不需要额外设置。

---

## 三、搬数据（紧接着做，别跳）

**没有数据，服务能起来但没人能登录、页面全空。**

本节分两趟走，**先做第一趟就够你验 SSO 了**：

| | 第一趟：登录必需 | 第二趟：全量搬 |
|---|---|---|
| 传什么 | 账号库 + SSO 凭据 | 全部业务数据（工时、归档、Skill…） |
| 大小 | **约 300 KB** | **约 25 MB**（打包后；解开 72 MB） |
| 要停本机服务吗 | **不用** | **要** |
| 能验什么 | 账号密码登录 + **SSO 登录全流程** | 首页数据、历史归档、各 Tab |
| 什么时候做 | 现在 | 服务跑通、大家准备切过去时 |

> **为什么第一趟不用停服**：数据库用 `VACUUM INTO` 生成一致快照 —— 它让 SQLite 在
> **一个只读事务里**把当前数据完整导出成新文件，服务同时在写也不影响。这比
> 「停服让 WAL 落盘」温和得多，也**不需要**碰 `platform.db-wal` / `-shm`
> （快照已经把它们的内容算进去了）。
>
> ⚠️ 但你本机平台**现在还在用着**（你 2026-09-24 交代过「云服务迭代版本那里
> 现在服务还启着用着更新着呢」）。第一趟全程不停服，放心做。

---

### 3.1 【笔记本】第一趟：打包登录必需的数据

**在笔记本上新开一个终端**（不要用那个 SSH 到服务器的窗口，见 1.1 开头的提醒），
进项目目录：

```bash
cd "E:/PMWork/Project Materials/iSolarCloudProject/迭代版本/iSolarCloudProjectManage"
pwd        # 确认路径对，末尾应该是 iSolarCloudProjectManage
```

**① 生成数据库一致快照**（服务运行中也能做）：

```bash
mkdir -p .scratch && rm -f .scratch/login-pack.db

node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('data/platform.db');
d.exec(\"VACUUM INTO '.scratch/login-pack.db'\");
d.close();
console.log('快照已生成');
"

ls -lh .scratch/login-pack.db      # 预期 200~400 KB
```

> **末尾那行 `ExperimentalWarning: SQLite is an experimental feature` 是正常的**，
> 不是错误。
>
> **为什么用 `VACUUM INTO` 而不是直接拷 `platform.db`**：直接拷主库会漏掉还在
> `platform.db-wal` 里的**最近写入**（眼下有 4.1 MB 未落盘），而且**不报错** ——
> 查出来就是少几条账号、少几条审计，最难发现的那种。`VACUUM INTO` 出来的快照
> 是**完整且自洽**的，服务器上打开就能用。

**② 确认快照是对的**（别跳过，这是唯一一次在传之前发现问题的机会）：

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const t=new DatabaseSync('.scratch/login-pack.db');
console.log('账号数:', t.prepare('SELECT COUNT(*) n FROM users').get().n);
console.log('审计条数:', t.prepare('SELECT COUNT(*) n FROM audit_log').get().n);
t.close();
"
```

**预期输出**：

```
账号数: 373
审计条数: 781
```

**两个数字都对上才往下走。** 对不上说明快照没生成对，重跑 ①。

**③ 打包**：

```bash
tar -czf login-pack.tar.gz \
  -C .scratch login-pack.db \
  -C .. "data/sso/secret.json" "data/auth-config.json"

ls -lh login-pack.tar.gz      # 预期 60~120 KB（实测 86 KB）
```

> **上面这条命令容易看岔**：`-C` 是「切到这个目录再取后面的文件」，所以
> `-C .scratch login-pack.db` 取的是 `.scratch/login-pack.db`，
> `-C ..` 之后取的是项目目录下的 `data/sso/secret.json`。
> 打包时**没有把 `.scratch/` 这层目录带进去** —— 解包后会直接在目标目录下看到
> `login-pack.db`，方便后面改名。

---

### 3.2 【笔记本】传到服务器

```bash
# 换成你在 1.1 里用的那个用户名
scp login-pack.tar.gz 你的用户名@10.63.139.103:/opt/pmwork/

# 会要一次密码，输完看到进度条 + 100% 就是传完了
```

> **`scp` 是独立的命令，用的是和 `ssh` 同一套账号密码**，不需要等 SSH 连上再敲。
>
> **如果 `scp` 报 `Permission denied`**：`/opt/pmwork` 不是你这个账号可写的目录。
> 先在服务器上把它改成可写（1.1 那个窗口里执行）：
> ```bash
> sudo chown -R $USER /opt/pmwork
> ```

---

### 3.3 【服务器】解包并对号入座

**回到那个 SSH 窗口**（用 `hostname` 确认一下是在服务器上）：

```bash
cd /opt/pmwork
pwd        # 预期 /opt/pmwork

tar -xzf ../login-pack.tar.gz
ls -la login-pack.db data/sso/secret.json data/auth-config.json
```

三个文件都 `ls` 得出来，就往下走。接着**把快照放到它该在的位置**：

```bash
# ① 备份 clone 里可能存在的旧库（正常情况下不存在，有就留着别删）
[ -f data/platform.db ] && mv data/platform.db data/platform.db.from-clone

# ② 快照改名成平台认的库名
mv login-pack.db data/platform.db

# ③ 把 WAL/SHM 清掉 —— 它们是【本机那份库】的附属文件，
#    和新搬来的库不是一对。混着用会损坏数据库
rm -f data/platform.db-wal data/platform.db-shm

# ④ 确认到位
ls -la data/platform.db data/sso/secret.json
```

> **③ 这一步是最容易埋雷的地方**。如果你用的是「三个文件一起拷」的老办法，
> 那三个文件**必须来自同一时刻**；而这里是 `VACUUM INTO` 出来的**单文件自洽快照**，
> 天然不需要 `-wal` / `-shm`。如果 clone 时带过来一份旧的 `-wal`，它和快照对不上，
> SQLite 会试图重放，轻则数据错乱重则开不了库。**所以一定要删掉。**

### 3.4 【服务器】校验：账号数必须是 373

```bash
cd /opt/pmwork

node -e "const db=require('./db');console.log('账号数:',db.listUsers().length)"
```

**`账号数: 373` 对上了再往下走。**

再顺手看一眼 SSO 凭据读没读到（不打印任何密钥值）：

```bash
curl -s localhost:9680/sso/status
```

> ⚠️ 这条要**服务起来之后**才有输出（第四节）。现在没起服务的话会
> `Connection refused`，是正常的，到 4.1 起服务后再回来补这一条。

对不上怎么办：

| 现象 | 最可能的原因 | 怎么办 |
|---|---|---|
| `账号数: 0` | `data/platform.db` 不存在，`db.js` 自动建了个空库 | 回到 3.3 检查 `mv login-pack.db data/platform.db` 有没有执行到 |
| 账号数不是 373 但大于 0 | 搬到的是 clone 里那份**旧库**（见 2.3） | 确认 3.3 的 `mv` 覆盖成功了；`ls -la data/platform.db` 看时间戳是不是刚才 |

---

### 3.5 【笔记本 → 服务器】第二趟：全量搬（服务跑通后再做）

> ★ **这一趟要停你本机的服务**，因为要动的是**实时业务数据**（工时、归档），
> 那些不是数据库、没有 `VACUUM INTO` 这种快照机制。做之前先在群里说一声。
>
> **第一趟做完、SSO 验过了，再回来做这一趟。** 现在可以跳过，直接去第四节。

完整清单和三个坑见 `docs/plan-server-migration.md`，这里是可执行版本。

**① 【笔记本】停服**（在跑着 `node server.js` 的那个窗口按 `Ctrl+C`），然后：

```bash
cd "E:/PMWork/Project Materials/iSolarCloudProject/迭代版本/iSolarCloudProjectManage"

# 停服后 WAL 会自动合并，这个文件应该缩到很小或消失
ls -la data/platform.db-wal
```

**② 【笔记本】打包**：

```bash
tar -czf pmwork-data.tar.gz \
  data/platform.db data/platform.db-wal data/platform.db-shm \
  data/iteration data/archive data/plan data/project data/budget \
  data/token data/skill data/pradapter data/notify data/sso \
  data/dingtalk data/tb data/auth-config.json data/state.json \
  --exclude='data/iteration/state.json.CORRUPT-*'

ls -lh pmwork-data.tar.gz      # 预期 20~40 MB
```

> `--exclude` 排掉的是 2026-09-24 那次事故留下的 171 字节损坏样本，别把坏数据带上服务器。
>
> **如果 `data/platform.db-wal` 不存在**（已经 checkpoint 掉了），`tar` 会报
> `Cannot stat: No such file or directory`。把这一项从命令里删掉再打一次。

**③ 【笔记本】传过去**：

```bash
scp pmwork-data.tar.gz 你的用户名@10.63.139.103:/opt/pmwork/
```

**④ 【服务器】解包**：

```bash
cd /opt/pmwork
tar -xzf ../pmwork-data.tar.gz

# 三个关键文件都在
ls -la data/platform.db data/iteration/state.json data/sso/secret.json

# 账号数还是 373
node -e "const db=require('./db');console.log('账号数:',db.listUsers().length)"

# 归档数量和本机一致（本机现在是 3）
ls data/archive/*.json | wc -l
```

**⑤ 【服务器】重启服务让新数据生效**：

```bash
sudo systemctl restart pmwork      # 如果已经做成 systemd 服务（见第五节）
# 还没做成服务的话，把前台那个 Ctrl+C 掉重新 node server.js 9680
```

---

## 四、启动服务

### 4.1 先手动跑一次（前台，看日志）

**这一步一定要在前台跑** —— 只有在前台你才能第一时间看到报错。

```bash
cd /opt/pmwork

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
WorkingDirectory=/opt/pmwork
ExecStart=/usr/bin/node /opt/pmwork/server.js 9680
Restart=always
RestartSec=5

# ★ 启用真实登录（账号 + 密码 + 会话）
Environment=AUTH_REQUIRED=1

# ★ 数据放项目目录下，与 .gitignore 和代码里的路径一致
#   不要指向别处 —— 有几个脚本写死了 data/ 路径，不跟随 DATA_DIR
# Environment=DATA_DIR=/opt/pmwork/data

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
nssm install pmwork "C:\Program Files\nodejs\node.exe" "D:\pmwork\server.js"
nssm set pmwork AppDirectory D:\pmwork
nssm set pmwork AppEnvironmentExtra AUTH_REQUIRED=1
nssm set pmwork AppStdout D:\pmwork\server.log
nssm set pmwork AppStderr D:\pmwork\server-error.log
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

1. **先确认凭据齐全**（不打印任何密钥值，只看长度和地址）：
   ```bash
   node -e "const s=require('./data/sso/secret.json');console.log('clientId:',s.clientId);console.log('clientSecret 长度:',String(s.clientSecret||'').length);console.log('authorizeUrl:',s.authorizeUrl);console.log('tokenUrl:',s.tokenUrl);console.log('debug:',s.debug)"
   ```
   预期看到 `clientId: aic3431485b7a541768b9391be0bbff132`、三条 URL 都是
   `https://sso.sungrow.cn/...`（**生产**，不是 `sso-sit`）。

   若 `clientSecret 长度` 是 0，说明 `data/sso/secret.json` 没搬过来（回 3.3 检查）。

2. **确认 SSO 状态接口说配置齐全**：
   ```bash
   curl -s localhost:9680/sso/status
   ```
   预期：
   ```json
   {"configured":true,"missing":[],"redirectUri":"http://10.63.139.103:9680/sso/callback","debug":true,"logoutConfigured":true}
   ```
   - `configured:false` → 登录页**不会显示**「公司统一认证登录」按钮，先解决这个再往下
   - `redirectUri` 必须**逐字**是 `http://10.63.139.103:9680/sso/callback`

3. 浏览器打开 `http://10.63.139.103:9680`，登录页应出现「公司统一认证登录」按钮。
4. 点击 → 跳到公司 SSO 认证页（`sso.sungrow.cn`）→ 输入公司账号 → 回跳到平台。
5. **看审计日志确认登录方式**：
   ```bash
   node -e "const d=require('./db');console.log(d.getAudit(10).filter(a=>a.module==='auth'))"
   ```

**先在联调模式跑一遍更好**：若 `secret.json` 里 `debug: true`，SSO 回调后**只把工号显示在页面上，不建会话、不让人进平台**。第一次接通时挂着它确认工号对得上，再改回 `false`。

> 当前 `data/sso/secret.json` 里 `debug` 就是 `true` —— 这是**有意的**。
> 第一次点 SSO 登录，页面上会显示「联调模式（未登录）」+ 你的工号。
> **确认这个工号和你在 `users` 表里的账号对得上**，再把 `debug` 改成 `false` 重启服务，
> 才能真正登进去。这样设计是为了避免「配置写错了但症状是『人进去了、看到的却是别人的数据』」。

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
cd /opt/pmwork
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
0 2 * * * tar -czf /backup/pmwork-$(date +\%Y\%m\%d).tar.gz /opt/pmwork/data
find /backup -name 'pmwork-*.tar.gz' -mtime +30 -delete     # 保留 30 天
```

⚠️ **备份 `platform.db` 时要连 `-wal` `-shm` 一起**，或者先停服再备。只备 `.db` 会缺最近的写入。

### 9.3 账号管理

走界面：admin 登录 → 用户管理（建账号、改角色、停用、重置密码）。

界面进不去时走命令行：

```bash
cd /opt/pmwork

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
| 页面打开但没人能登录 | `platform.db` 没搬对 | 查账号数是不是 373，见 3.4 |
| 账号数是 **0** 不是 373 | `data/platform.db` 不存在，`db.js` 自动建了空库 | 回 3.3 确认 `mv login-pack.db data/platform.db` 执行到了 |
| 登录页没有 SSO 按钮 | `data/sso/secret.json` 没搬过来 | 回 3.3，`curl localhost:9680/sso/status` 看 `configured` |
| 登录页没有钉钉按钮 | `corpId` 没填 | 去钉钉后台拿，见 8.1 |
| SSO 登录报 state 校验失败 | 在笔记本上验的 | 必须在服务器上验，见第七节 |
| SSO 跳到 `sso.sungrow.cn` 后报应用不存在/回调不合法 | 回调地址与登记值不符 | 核对 `secret.json` 的 `redirectUri` 逐字等于 `http://10.63.139.103:9680/sso/callback` |
| SSO 登录后页面显示「联调模式（未登录）」 | 这是有意的 | 确认工号对得上后，把 `secret.json` 的 `debug` 改成 `false` 重启 |
| 钉钉点了没反应 | 不在钉钉客户端里打开的 | 从钉钉工作台卡片进入，见 8.3 |
| 每次启动都有 ExperimentalWarning | 正常的 | 忽略 |

---

## 十、验收清单（打勾用）

### 第一趟：能登录 + 能验 SSO（做这些就够）

- [ ] 服务器 Node 版本 ≥ v22.5
- [ ] 9680 端口空闲
- [ ] 代码 clone 到 `dev/sgai` 且是最新提交（`git log` 看到 `4d18aac`）
- [ ] 本机 `VACUUM INTO` 快照生成成功，**账号数 373 / 审计 781**
- [ ] `login-pack.tar.gz` 已 scp 到服务器并解包
- [ ] `mv login-pack.db data/platform.db` 已执行，`data/platform.db-wal` / `-shm` **已删除**
- [ ] 服务器上 `node -e "require('./db').listUsers().length"` = **373**
- [ ] `data/sso/secret.json` 在，且三条 URL 都是 `https://sso.sungrow.cn/...`（**生产**，不是 sit）
- [ ] **`curl http://localhost:9680/sso/status` 返回 `"configured":true`** —— 不检查这条就直接去点登录按钮，按钮压根不会出现
- [ ] 前台启动一次，看到「服务已启动」，无报错
- [ ] 服务器本机 `curl http://localhost:9680/login.html` 有返回
- [ ] 笔记本浏览器能打开 `http://10.63.139.103:9680`
- [ ] 防火墙放行 9680（如需）
- [ ] 用现有账号密码能登录进去
- [ ] **SSO 真实登录走通**（在服务器上验，见第七节）
- [ ] `secret.json` 的 `debug` 已从 `true` 改回 `false`，重启后能真正登进平台

### 第二趟：全量数据（大家准备切过去时再做）

- [ ] 已通知相关人，本机服务已停
- [ ] `pmwork-data.tar.gz` 已打包（20~40 MB）并传到服务器
- [ ] 服务器上账号数仍 = 373，归档数与本机一致（本机当前 **3**）
- [ ] 首页数据与本机一致，各 Tab 不空
- [ ] `platform.db-wal` / `platform.db-shm` 是**与 `.db` 同一时刻**的一组（第二趟是三个一起拷的，不是 `VACUUM INTO` 单文件）

### 收尾

- [ ] 做成 systemd / nssm 常驻服务，开机自启
- [ ] 钉钉免登走通（`corpId` 填好后，见第八节）
- [ ] 备份定时任务已配
- [ ] **本机停止写入**（否则两边数据分叉，见迁移文档第七节）

---

## 相关文档

- `docs/plan-server-migration.md` — 本地数据全搬服务器的方案（含三个坑）
- `docs/ops-manual.md` — 平台日常运维（账号、权限、审计）
- `docs/plan-identity-and-dingtalk.md` — SSO / 钉钉接入的背景与回调地址约定
- `docs/plan-dingtalk-sso.md` — 钉钉 + SSO 实施计划
- `docs/samples/sso-secret.sample.json` — SSO 凭据模板
- `docs/samples/dingtalk-secret.sample.json` — 钉钉凭据模板
