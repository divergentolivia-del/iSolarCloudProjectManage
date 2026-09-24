#!/usr/bin/env node
/* dingtalk-roster.js — 从通讯录快照产出「可交给平台用」的两张表
 *
 * 前置：先跑 node dingtalk-sync.js 生成 data/dingtalk/org.json
 *
 * 产出（都写到 data/dingtalk/，已 gitignore）：
 *   1. roster.csv       —— users 表开户名单，格式对齐 user-import.js 的入参
 *   2. leavers.csv      —— 已停用但仍可能挂着任务的人，供离职对账
 *   3. report.txt       —— 人看的对账小结
 *
 * 用法：
 *   node dingtalk-roster.js            # 用 org.json 里记录的范围（sync 时选的）
 *   node dingtalk-roster.js --dept 阳光云组   # 再从快照里挑一个子部门
 *
 * ── 为什么密码前缀列留空 ────────────────────────────────────────
 * user-import.js 明确「程序不做拼音转换（零依赖是本项目的硬约束）」，
 * 所以我们也不做。这一列由人工补 —— 这是刻意的，不是没写完。
 * 强行在这里引一个拼音库，等于把零依赖的约束破在了一个辅助脚本上。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data', 'dingtalk');
const ORG_FILE = path.join(DATA_DIR, 'org.json');

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const DEPT_FILTER = arg('dept');

function fail(msg) {
  console.error('\n失败：' + msg);
  process.exit(1);
}

if (!fs.existsSync(ORG_FILE)) {
  fail('读不到 ' + path.relative(__dirname, ORG_FILE) + '，请先跑 node dingtalk-sync.js');
}

let org;
try {
  org = JSON.parse(fs.readFileSync(ORG_FILE, 'utf8'));
} catch (e) {
  fail('org.json 解析失败：' + e.message);
}

/* ---------- 部门范围筛选 ---------- */

/* 快照自身带的范围（sync 时选的）。没带就说明是旧快照，按未知处理。 */
const SNAPSHOT_SCOPE = org.scope && org.scope.deptName
  ? org.scope.deptName + (org.scope.full ? '（全量）' : '')
  : '（快照未记录范围）';

/**
 * 在【快照范围内】再挑一个子部门，返回该部门及其所有子部门的 id 集合。
 * 不传筛选条件时返回 null，表示「快照范围内的全部」。
 *
 * 注意这里筛的是 org.json 里已有的数据，不是重新去钉钉拉。
 * 真正的范围控制在上游的 dingtalk-sync.js —— 从哪个部门开始拉，那里就定死了。
 * 这一层只是「快照里我只要其中一块」的二次筛选。
 */
function scopeDeptIds(filter) {
  if (!filter) return null;

  /* 先找到匹配的部门。名字匹配是「包含」，因为实际部门名常带后缀，
     用户多半只会输入前半段。 */
  const roots = org.departments.filter(d =>
    d.id === filter || d.name === filter || d.name.indexOf(filter) >= 0);

  if (!roots.length) {
    fail('快照里没找到匹配「' + filter + '」的部门。'
      + '快照范围是「' + SNAPSHOT_SCOPE + '」，超出这个范围的部门需要重跑 sync。');
  }
  if (roots.length > 1) {
    console.log('匹配到多个部门，全部纳入范围：');
    roots.forEach(d => console.log('  ' + d.id + '  ' + d.name));
    console.log('');
  }

  /* BFS 展开子树 */
  const inScope = new Set(roots.map(d => d.id));
  let level = roots.map(d => d.id);
  for (let depth = 0; depth < 12 && level.length; depth++) {
    const next = org.departments.filter(d => level.indexOf(d.parentId) >= 0).map(d => d.id);
    const fresh = next.filter(id => !inScope.has(id));
    fresh.forEach(id => inScope.add(id));
    level = fresh;
  }
  return inScope;
}

const scopeIds = scopeDeptIds(DEPT_FILTER);
const inScope = (u) => !scopeIds || scopeIds.has(u.deptId);

const usersInScope = org.users.filter(inScope);

/* ---------- CSV ---------- */

/** CSV 字段转义：含逗号/引号/换行时用双引号包起来 */
function csv(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * 清洗姓名。通讯录里的姓名混着三种形态，实测 372 人里有 11 个带连字符：
 *
 *   1. 外包公司前缀：PWC-陈楚莹、奥美-郭庆
 *      → 【剥掉】。前后缀说的都是同一个人，剥掉没有信息损失。
 *   2. 部门后缀做重名消歧：张磊-智慧能源产品中心、王亚-云服务开发部
 *      → 【保留】。这不是脏数据，是钉钉给重名的人加的区分标识。
 *   3. 英文名连字符：Yen-Tzu Huang
 *      → 【保留】。一刀切按 - 切会把英文名毁掉。
 *
 * ── 为什么 2 必须保留（2026-09-23 踩过）────────────────────────
 * 最初把部门后缀也当脏数据剥了，结果两个张磊变成同名两行：
 *   10013853 张磊-智慧能源产品中心（实际在 产品组）
 *   10033228 张磊        （实际在 ECO测试团队）
 * 剥完 roster.csv 里就是两个一模一样的「张磊」，人工核对时分不出谁是谁，
 * 密码前缀大概率填成同一个，两个人拿到同一套账号密码。
 * 而且这个后缀【本来就不是真实部门名】—— 10013853 后缀写「智慧能源产品中心」，
 * 他本人在「产品组」。所以拿它去还原部门也是错的，它的唯一价值就是「不一样」。
 *
 * 结论：只剥外包前缀，其余一律原样保留。宁可名字长一点，
 * 也不要把两个人合并成一个 —— 后者不可逆。
 */
function cleanName(raw) {
  return String(raw || '').trim()
    .replace(/^(PWC|IBM|埃森哲|德勤|奥美|毕马威|普华永道)[-－—]\s*/i, '');
}

/**
 * 判断是不是「真人」。
 * 通讯录里混着数字员工（CRM Training、rpa01）和纯英文的培训账号 ——
 * 这些账号给它们开户没有意义，反而污染用户列表。
 * 判据用的是保守规则：没有工号的一律不算真人（数字员工不占工号）。
 */
function looksLikePerson(u) {
  return !!u.jobNumber;
}

/* ---------- 1. 开户名单 ---------- */

const roster = usersInScope
  .filter(u => u.active !== false)         // 离职的不开户
  .filter(looksLikePerson)                  // 数字员工/测试账号不开户
  .map(u => ({
    jobNumber: u.jobNumber,
    name: cleanName(u.name),
    deptName: u.deptName,
    rawName: u.name
  }))
  /* 同一工号可能挂在多个部门（兼职/借调），去重保留第一条 ——
     否则 user-import.js 会因「账号已存在」把后面几条全部跳过并报错。 */
  .filter((u, i, arr) => arr.findIndex(x => x.jobNumber === u.jobNumber) === i)
  .sort((a, b) => a.jobNumber.localeCompare(b.jobNumber));

/* 开户列照 user-import.js 的入参写（工号,姓名,密码前缀,角色）；末尾多一列「部门」
   是给人看的 —— 它不在导入契约里，导入时被忽略。
   为什么需要它：方案 A 保留了「张磊-智慧能源产品中心」这种带部门后缀的名字，
   而后缀【不是】这个人的真实部门（10013853 后缀写智慧能源产品中心，人在产品组）。
   列出来，填前缀的人就不用去 org.json 里反查了。 */
const rosterCsv = ['工号,姓名,密码前缀,角色,部门（仅供人工核对，导入时忽略）']
  .concat(roster.map(u => [u.jobNumber, u.name, '', '', u.deptName].map(csv).join(',')))
  .join('\n') + '\n';
fs.writeFileSync(path.join(DATA_DIR, 'roster.csv'), rosterCsv, 'utf8');

/* ---------- 2. 离职对账 ---------- */

const leavers = usersInScope
  .filter(u => u.active === false)
  .map(u => ({ jobNumber: u.jobNumber, name: cleanName(u.name), deptName: u.deptName }))
  .sort((a, b) => (a.deptName || '').localeCompare(b.deptName || ''));

const leaverCsv = ['工号,姓名,原部门']
  .concat(leavers.map(u => [u.jobNumber, u.name, u.deptName].map(csv).join(',')))
  .join('\n') + '\n';
fs.writeFileSync(path.join(DATA_DIR, 'leavers.csv'), leaverCsv, 'utf8');

/* ---------- 3. 对账小结 ---------- */

const noJob = usersInScope.filter(u => u.active !== false && !u.jobNumber);
const dupJob = {};
usersInScope.forEach(u => { if (u.jobNumber) dupJob[u.jobNumber] = (dupJob[u.jobNumber] || 0) + 1; });
const multiDept = Object.keys(dupJob).filter(k => dupJob[k] > 1);

/* 重名（姓名相同但工号不同 = 两个人）。必须单独列出来：
   名字去重只能靠人，而人看两个「张磊」是分不出的 —— 一旦给他们填了
   同一个密码前缀，两人就拿到同一套账号密码。所以这里把工号和部门都打出来，
   让填前缀的人有依据把前缀错开（zl / zl2，或直接用别的规则）。 */
const dupName = {};
roster.forEach(u => { (dupName[u.name] = dupName[u.name] || []).push(u); });
const dupNames = Object.keys(dupName).filter(n => dupName[n].length > 1);

const lines = [];
/* 范围标签用的是快照自带的那个（sync 时选的），不是这里的 --dept。
   --dept 是在快照范围内二次筛选，报告里要同时体现两者，否则看报告的人
   会以为「本次导出的范围 = 快照范围」，这两个是不同的东西。 */
const scopeLine = DEPT_FILTER
  ? '部门「' + DEPT_FILTER + '」及其子树（' + (scopeIds ? scopeIds.size : 0) + ' 个部门）'
    + '，取自快照范围「' + SNAPSHOT_SCOPE + '」'
  : SNAPSHOT_SCOPE;

lines.push('钉钉通讯录对账小结');
lines.push('  快照时间：' + org.syncedAt);
lines.push('  范围：' + scopeLine);
lines.push('');
lines.push('  范围内人数        ：' + usersInScope.length);
lines.push('  在职且有工号      ：' + roster.length + '  ← 可开户');
lines.push('  在职但无工号      ：' + noJob.length + '  ← 数字员工/测试账号，不开户');
lines.push('  已停用            ：' + leavers.length + '  ← 见 leavers.csv');
lines.push('  同工号挂多部门    ：' + multiDept.length + ' 人（开户时已去重）');
lines.push('  重名（不同工号）  ：' + dupNames.length + ' 人' + (dupNames.length ? '  ← 见下方' : ''));
lines.push('');
if (dupNames.length) {
  lines.push('  ⚠ 以下姓名重复，填密码前缀时必须错开（否则两人拿到同一套密码）：');
  dupNames.forEach(n => {
    lines.push('    ' + n);
    dupName[n].forEach(u => {
      lines.push('      工号 ' + u.jobNumber + '   部门 ' + (u.deptName || '—'));
    });
  });
  lines.push('');
}
if (org.truncated) {
  lines.push('  ⚠⚠ 快照被上限截断过，本次结果是【不完整】的。');
  lines.push('     开户前必须重跑一次完整的 sync。');
  lines.push('');
}
if (org.errors && org.errors.length) {
  lines.push('  ⚠ 快照生成时有 ' + org.errors.length + ' 处采集失败，见 org.json 的 errors。');
  lines.push('');
}
lines.push('  下一步：');
lines.push('   1. 打开 roster.csv，补「密码前缀」列（拼音首字母，人工填）');
lines.push('   2. 补「角色」列（不填默认 viewer；pm / dev / admin 看名单定）');
lines.push('   3. 停掉服务，跑：node user-import.js data/dingtalk/roster.csv');
lines.push('   4. 用 leavers.csv 核对：这些人名下是否还挂着任务');

const report = lines.join('\n') + '\n';
fs.writeFileSync(path.join(DATA_DIR, 'report.txt'), report, 'utf8');

console.log(report);
console.log('已写入 data/dingtalk/：roster.csv、leavers.csv、report.txt');
