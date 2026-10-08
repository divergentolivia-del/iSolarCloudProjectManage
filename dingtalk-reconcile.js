#!/usr/bin/env node
/* dingtalk-reconcile.js — 钉钉通讯录 ↔ 平台 users 表对账（P1-3 / P1-4）
 *
 * 前置：先跑 node dingtalk-sync.js 生成 data/dingtalk/org.json
 *
 * 用法：
 *   node dingtalk-reconcile.js                  # 干跑（默认）：只出报告，一个字节都不写
 *   node dingtalk-reconcile.js --apply          # 执行：新增缺失账号（一律 viewer，无密码）
 *   node dingtalk-reconcile.js --apply --disable-missing   # 再停用「钉钉查无此人」的账号
 *
 * 产出：data/dingtalk/reconcile-report.txt（人看的对账报告，已 gitignore）
 *
 * ── 这个脚本为什么默认干跑，而不是默认执行 ──────────────────────
 * user-import.js 是「默认执行、--dry-run 才只看」，因为建号最坏情况是多建几个号，
 * 删掉就行。对账不一样：它会【停用账号】，而几百人系统里最贵的错就是
 * 「把还在职的人停掉」——本人登录不上、任务断档，而且脚本不会报错。
 * 所以默认值反过来：想写库必须显式 --apply。
 *
 * ── 四条硬约束（docs/plan-dingtalk-sso.md §3.2）────────────────
 *   1. 自动建号角色一律 viewer（D8）
 *   2. 改角色永不自动 —— 这里只会【提示复核】，绝不调用 setRole
 *   3. 停用可自动，但必须写 audit_log（记「因钉钉对账停用」）
 *   4. 只新增，不改已有账号的角色和密码（否则重跑会冲掉别人改过的密码）
 *
 * ── ★ 范围闸：为什么这是本文件最重要的一段 ────────────────────
 * org.json 的快照有 scope.deptId / scope.full 两个字段。实测当前这份
 * org.json 的 scope.full = false —— 意思是【它只是某个子树的切片】，
 * 不是全公司通讯录。
 *
 * 于是就有了一条极危险、且不会报错的路径：
 *   有人用 node dingtalk-sync.js --dept 阳光云组 重跑一次 → 快照只剩那几十人
 *   → 对账脚本看不到其余 300 多人 → 判定他们「钉钉里没有」→ 全部停用。
 *
 * 对策不是"给个提示"，而是**压根不让范围外的人进停用候选集**：
 * 用 departments 的 parentId 建树，求出 scope.deptId 的子树 id 全集，
 * 只有落在这个范围内的平台账号才参与停用判断。范围外的一律不动。
 *
 * 判定「在范围内」两个口径，任一命中即可：
 *   a) 该账号的 id == 快照里某个人的工号（最可靠，工号是 D1 定的身份主键）
 *   b) 该账号的姓名在快照里唯一，且它的部门名出现在快照范围内
 * 本地管理员 admin（部门为空、不在花名册）两个都不命中 → 天生不受影响。
 *
 * 注意：本脚本直接写平台数据库，请先停掉服务再执行，避免写入竞争。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA_DIR = path.join(__dirname, 'data', 'dingtalk');
const ORG_FILE = path.join(DATA_DIR, 'org.json');
/* 报告路径跟随 DATA_DIR 走。原因：db.js 认 process.env.DATA_DIR（测试时指向副本库），
   如果这里硬编码 __dirname/data/dingtalk，副本上跑一次就会把报告写到【生产目录】里，
   干跑看着干净、实际污染了生产 data/。快照文件同理。 */
const OUT_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), 'dingtalk')
  : DATA_DIR;
const REPORT_FILE = path.join(OUT_DIR, 'reconcile-report.txt');
const ORG_SRC = process.env.DATA_DIR ? path.join(OUT_DIR, 'org.json') : ORG_FILE;

/* 停用幅度阈值：超过这个比例就要求 --force。
   子树快照下「一下子冒出大批离职」几乎必然是范围错误，而不是真离职。 */
const DISABLE_RATIO_LIMIT = 0.2;
const DISABLE_ABS_LIMIT = 5;      // 人数少时按比例算不可靠，给个绝对下限

const ROLE_NEW = 'viewer';        // D8：自动建号一律 viewer，不看不猜

const argv = process.argv.slice(2);
const has = (name) => argv.includes('--' + name);
const APPLY = has('apply');
const DISABLE_MISSING = has('disable-missing');
const FORCE = has('force');

function fail(msg) {
  console.error('\n失败：' + msg);
  process.exit(1);
}

function usage(code) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''));
  process.exit(code || 0);
}
if (has('help') || has('h')) usage(0);

/* ---------- 0. 读快照 ---------- */

if (!fs.existsSync(ORG_SRC)) {
  fail('读不到 ' + path.relative(__dirname, ORG_SRC) + '，请先跑 node dingtalk-sync.js');
}
let org;
try {
  org = JSON.parse(fs.readFileSync(ORG_SRC, 'utf8'));
} catch (e) {
  fail('org.json 解析失败：' + e.message);
}
if (!Array.isArray(org.users)) fail('org.json 里没有 users 数组，快照格式不对');

const SCOPE = org.scope || {};
const SCOPE_DEPT_ID = SCOPE.deptId ? String(SCOPE.deptId) : '';
const SCOPE_LABEL = (SCOPE.deptName || '（未记录）') + (SCOPE.full ? '（全量）' : '（子树）');

/* ---------- 1. 范围闸：求快照覆盖的部门子树 ---------- */

/* 快照根部门可能不在 departments 数组里（sync 从 root 开始拉时，root 自己不返回），
   所以先把 root 放进去，再自顶向下逐层收敛。
   不用递归是为了避免 org.json 出现环时栈溢出 —— 循环 + 收敛判定的写法，
   遇到环也只是白跑一轮。 */
const scopeIds = new Set();
if (SCOPE_DEPT_ID) scopeIds.add(SCOPE_DEPT_ID);
if (SCOPE.full) {
  /* full=全量：范围就是「全部部门」，不做子树裁剪。 */
  (org.departments || []).forEach(d => scopeIds.add(String(d.id)));
} else {
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of (org.departments || [])) {
      const id = String(d.id);
      if (scopeIds.has(id)) continue;
      if (scopeIds.has(String(d.parentId))) { scopeIds.add(id); grew = true; }
    }
  }
}

/* 快照范围内的部门名（钉钉叶子部门名，与 users.department 同口径）。
   trim 后比较：通讯录部门名实测带全角空格/不可见字符。 */
const scopeDeptNames = new Set();
for (const u of org.users) {
  if (u.deptName && scopeIds.has(String(u.deptId))) {
    scopeDeptNames.add(String(u.deptName).trim());
  }
}

/* 快照里按工号索引。同一工号挂多部门（兼职/借调）保留第一条，与 roster 一致。 */
const orgByJob = new Map();
for (const u of org.users) {
  const job = String(u.jobNumber || '').trim();
  if (!job) continue;
  if (!orgByJob.has(job)) orgByJob.set(job, u);
}

/* 姓名索引：只用来判断「库里这个人是否被快照覆盖」和「姓名有没有变」。
   重名（同名多条）单独记下来，涉及的人不做自动判断，只写进报告。 */
const orgByName = new Map();
for (const u of org.users) {
  const n = String(u.name || '').trim();
  if (!n) continue;
  orgByName.set(n, (orgByName.get(n) || 0) + 1);
}

/* ---------- 2. 读平台账号 ---------- */

const platUsers = db.listUsers();
const platById = new Map();
for (const p of platUsers) platById.set(String(p.id), p);

/* ★ 平台侧姓名索引 —— 建号撞名判定必须用它，不能用快照的重名统计。
   曾经写错过一次：拿 orgByName 判「姓名有没有重」，但那是【快照内部】的重名。
   快照里只有一个「陈丹萍」时该判定为假，于是脚本给 19990002 陈丹萍建了号，
   而平台里早就有 10017968 陈丹萍 —— 用户列表冒出两个同名的人，管理员无从分辨。
   要防的是「与平台已有账号撞名」，比较对象只能是 platform users。 */
const platByName = new Map();
for (const p of platUsers) {
  const n = String(p.name || '').trim();
  if (!n) continue;
  const arr = platByName.get(n) || [];
  arr.push(String(p.id));
  platByName.set(n, arr);
}

/** 该平台账号是否被本次快照覆盖（决定它是否参与停用判断） */
function covered(p) {
  if (orgByJob.has(String(p.id))) return true;
  const n = String(p.name || '').trim();
  if (!n || orgByName.get(n) !== 1) return false;   // 重名不给结论
  return scopeDeptNames.has(String(p.department || '').trim());
}

/* ---------- 3. 对账：三个集合 ---------- */

const toCreate = [];    // 钉钉有、平台无
const inScope = [];     // 平台有、且在快照覆盖范围内
const outScope = [];    // 平台有、但本次快照覆盖不到（一律不动）

for (const p of platUsers) (covered(p) ? inScope : outScope).push(p);

for (const [job, u] of orgByJob) {
  if (platById.has(job)) continue;
  const name = String(u.name || '').trim();
  /* 撞名：这个工号平台没有，但【它的姓名在平台里已经存在】——
     多半是「同一个人换了工号」或「重名」，自动建号会造出第二个同名账号，
     而用户列表按姓名看根本分不出谁是谁。不建，写进报告让人决定。 */
  const clash = platByName.get(name) || [];
  toCreate.push({
    job, name, deptName: u.deptName,
    clash: clash.length ? clash : null,
    dupInOrg: (orgByName.get(name) || 0) > 1
  });
}

/* 非 viewer 的账号单独列出来 —— 这些是人工提权过的，必须要人看一眼，
   对账脚本绝不能碰它们的角色（D8）。 */
const privileged = inScope.filter(p => p.role !== ROLE_NEW);

/* 停用候选：在范围内、当前是启用的、工号在快照里查不到。
   ★ 这是全脚本唯一会产生「损失」的动作，所以候选集被 coverage 收得极窄。 */
const disableCandidates = DISABLE_MISSING
  ? inScope.filter(p => Number(p.enabled) === 1 && !orgByJob.has(String(p.id)))
  : [];

/* 姓名/部门漂移：工号对上了但姓名或部门与钉钉不一致。
   只提示复核，【绝不自动改】—— 改了会覆盖人工维护过的信息。 */
const drifted = [];
for (const p of inScope) {
  const o = orgByJob.get(String(p.id));
  if (!o) continue;
  const nameChanged = String(o.name || '').trim() !== String(p.name || '').trim();
  const deptChanged = String(o.deptName || '').trim() !== String(p.department || '').trim();
  if (nameChanged || deptChanged) {
    drifted.push({
      id: p.id, platName: p.name, orgName: o.name,
      platDept: p.department, orgDept: o.deptName,
      nameChanged, deptChanged
    });
  }
}

/* --- 安全闸（全部只作用于「停用」这一个动作）--- */

const blocked = [];
if (DISABLE_MISSING) {
  if (org.truncated === true) {
    blocked.push('快照 truncated=true —— 这份快照是【不完整】的，按它停用会停掉没拉到的人');
  }
  if (Array.isArray(org.errors) && org.errors.length) {
    blocked.push('快照 errors 非空（' + org.errors.length + ' 条）—— 有部门采集失败，情况同上');
  }
  const limit = Math.max(DISABLE_ABS_LIMIT, Math.ceil(inScope.length * DISABLE_RATIO_LIMIT));
  if (disableCandidates.length > limit) {
    blocked.push('停用候选 ' + disableCandidates.length + ' 人，超过安全阈值 ' + limit
      + ' 人（范围内共 ' + inScope.length + ' 人）—— 这个数量级通常意味着【快照范围不对】，不是真离职');
  }
  if (blocked.length && !FORCE) {
    console.error('\n已阻止停用（新增仍可继续）：');
    blocked.forEach(b => console.error('  ✗ ' + b));
    console.error('\n确认范围无误后加 --force 强制执行。');
    process.exit(2);
  }
}

/* ---------- 4. 执行 ---------- */

const done = { created: [], disabled: [], failed: [] };

if (APPLY) {
  for (const c of toCreate) {
    if (c.clash) continue;      // 与平台已有姓名撞车，不自动建，见上
    try {
      /* 密码留空（password_hash = null）—— 不是偷懒，是刻意的：
         user-import.js 的密码规则要人工提供「密码前缀」，这里没有；
         与其在这里重造一套规则、让平台出现第二种初始密码形态，
         不如留空，让管理员在「用户管理」界面里按人重置。
         db.createUser 明确支持 password 为空。 */
      db.createUser({
        id: c.job, name: c.name, role: ROLE_NEW,
        department: c.deptName, dingtalkId: null, password: null
      });
      db.logAudit({
        user_id: 'system', user: '钉钉对账', module: 'auth', action: '批量建号',
        details: c.job + '（' + c.name + '，' + (c.deptName || '无部门') + '，viewer，无密码，待重置）'
      });
      done.created.push(c);
    } catch (e) {
      done.failed.push({ item: c, reason: e.message });
    }
  }

  for (const p of disableCandidates) {
    try {
      db.get().prepare('UPDATE users SET enabled = 0, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), String(p.id));
      /* 硬约束 3：停用可自动，但必须留痕。 */
      db.logAudit({
        user_id: 'system', user: '钉钉对账', module: 'auth', action: '停用用户',
        details: p.id + '（' + p.name + '）因钉钉对账停用：快照范围「' + SCOPE_LABEL + '」内查无此人'
      });
      done.disabled.push(p);
    } catch (e) {
      done.failed.push({ item: p, reason: e.message });
    }
  }
}

/* ---------- 5. 报告 ---------- */

const now = new Date().toLocaleString('zh-CN');
const L = [];
L.push('钉钉通讯录 ↔ 平台 users 表 对账报告');
L.push('  生成时间：' + now);
L.push('  快照时间：' + (org.syncedAt || '（未记录）'));
L.push('  快照范围：' + SCOPE_LABEL + (SCOPE_DEPT_ID ? '  [deptId ' + SCOPE_DEPT_ID + ']' : ''));
L.push('  模式：' + (APPLY ? '已执行（--apply）' : '干跑（未写库）')
  + (DISABLE_MISSING ? ' + 含停用' : ''));
L.push('');
L.push('── 总览 ─────────────────────────────');
L.push('  快照内人数（有工号）  ：' + orgByJob.size);
L.push('  平台账号总数          ：' + platUsers.length);
L.push('  ├ 被本次快照覆盖      ：' + inScope.length + '   ← 参与停用判断');
L.push('  └ 不在本次快照范围内  ：' + outScope.length + '   ← 一律不动（多半是本地管理员）');
L.push('  平台有、钉钉无（范围内）：' + disableCandidates.length);
L.push('  钉钉有、平台无（待建号）：' + toCreate.length);

L.push('');
L.push('── 1. 钉钉有、平台无（' + toCreate.length + '）──');
if (!toCreate.length) L.push('  （无）');
toCreate.forEach(c => L.push('  ' + c.job + '  ' + c.name
  + '  ' + (c.deptName || '')
  + (c.clash ? '  ⚠ 姓名与平台已有账号撞车（' + c.clash.join('、')
      + '），不自动建号，请确认是换工号还是重名后手动处理' : '')
  + (c.dupInOrg ? '  ⚠ 该姓名在快照里也有重名' : '')));

L.push('');
L.push('── 2. 平台有、钉钉无（范围内，' + disableCandidates.length + '）──');
L.push('  判据：在快照覆盖范围内，但工号在快照里查不到。');
if (!disableCandidates.length) {
  L.push('  （无）' + (DISABLE_MISSING ? '' : '  ← 未加 --disable-missing，本项未参与判定'));
}
disableCandidates.forEach(p => L.push('  ' + p.id + '  ' + p.name + '  '
  + (p.department || '') + '  [' + p.role + ']'
  + (done.disabled.some(d => String(d.id) === String(p.id)) ? '  → 已停用' : '')));

L.push('');
L.push('── 3. 不在本次快照范围内（' + outScope.length + '）──');
L.push('  这些账号可能是本地管理员，或属于快照没覆盖的部门。【不参与任何判定】。');
L.push('  若这里出现了本该属于本次范围的业务账号，说明快照范围选错了，请重跑 sync。');
if (!outScope.length) L.push('  （无）');
outScope.forEach(p => L.push('  ' + p.id + '  ' + p.name + '  '
  + JSON.stringify(p.department || null) + '  [' + p.role + ']'));

L.push('');
L.push('── 4. 建议复核 · 角色（' + privileged.length + '）──');
L.push('  非 viewer 的账号。钉钉里转岗/升职【不会】自动改平台角色（D8），但值得人工过一眼。');
if (!privileged.length) L.push('  （无）');
privileged.forEach(p => L.push('  ' + p.id + '  ' + p.name + '  '
  + (p.department || '') + '  [' + p.role + ']'));

L.push('');
L.push('── 5. 建议复核 · 姓名/部门漂移（' + drifted.length + '）──');
L.push('  工号对上了，但姓名或部门与钉钉不一致。可能是转岗、改名、或平台侧填错。');
if (!drifted.length) L.push('  （无）');
drifted.forEach(d => L.push('  ' + d.id
  + (d.nameChanged ? '  姓名：' + JSON.stringify(d.platName) + ' → ' + JSON.stringify(d.orgName) : '')
  + (d.deptChanged ? '  部门：' + JSON.stringify(d.platDept) + ' → ' + JSON.stringify(d.orgDept) : '')));

if (done.failed.length) {
  L.push('');
  L.push('── 失败（' + done.failed.length + '）──');
  done.failed.forEach(f => L.push('  ' + JSON.stringify(f.item.job || f.item.id) + '：' + f.reason));
}
if (blocked.length) {
  L.push('');
  L.push('── 被安全闸拦下（' + blocked.length + '）──');
  blocked.forEach(b => L.push('  ✗ ' + b));
}

L.push('');
L.push('── 下一步 ───────────────────────────');
if (!APPLY) {
  L.push('  1. 通读上面的第 1、2 项，确认没有误判');
  L.push('  2. 执行：node dingtalk-reconcile.js --apply' + (toCreate.filter(c => !c.dupName).length ? '' : '（当前无待建号）'));
  L.push('  3. 执行完成后到「系统设置 → 用户管理」给新账号重置密码');
} else {
  L.push('  1. 到「系统设置 → 用户管理」给新建的 ' + done.created.length + ' 个账号重置密码');
  L.push('  2. 到「系统设置 → 审计日志」核对本次的「批量建号」「停用用户」记录');
}

const report = L.join('\r\n') + '\r\n';
fs.writeFileSync(REPORT_FILE, report, 'utf8');

/* 控制台只打摘要，全文看报告文件 */
console.log('钉钉对账' + (APPLY ? '（已执行）' : '（干跑，未写库）'));
console.log('  快照范围    ：' + SCOPE_LABEL);
console.log('  快照内 / 覆盖 / 范围外：' + orgByJob.size + ' / ' + inScope.length + ' / ' + outScope.length);
console.log('  钉钉有平台无：' + toCreate.length + (APPLY ? '（已建 ' + done.created.length + '）' : ''));
console.log('  平台有钉钉无：' + disableCandidates.length
  + (DISABLE_MISSING ? (APPLY ? '（已停 ' + done.disabled.length + '）' : '（待停）') : '（未启用停用）'));
console.log('  建议复核    ：角色 ' + privileged.length + ' / 漂移 ' + drifted.length);
if (done.failed.length) console.log('  失败        ：' + done.failed.length);
if (blocked.length) console.log('  安全闸拦下  ：' + blocked.length + ' 条');
console.log('  报告        ：' + path.relative(__dirname, REPORT_FILE)
  + (APPLY ? '' : '\n\n  确认无误后执行：node dingtalk-reconcile.js --apply'));
