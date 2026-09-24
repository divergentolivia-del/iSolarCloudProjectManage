#!/usr/bin/env node
/* dingtalk-sync.js — 钉钉通讯录同步（只读拉取）
 *
 * 为什么做这一步（三个具体用途，不是「同步一下显得完整」）：
 *   1. 离职对账 —— 人走了但任务还在他名下，偏差表里的人头数是虚的。
 *      有了通讯录的 active 标记，能直接列出「已停用的账号还挂着任务」。
 *   2. SSO 开户名单 —— SSO 登录要求工号先在 users 表里（见 modules/sso/routes.js
 *      的「账号未开通」分支）。开户要姓名 + 工号，正好从通讯录拿。
 *   3. 团队映射 —— data/pradapter/config.json 的 repos[0].teams 是空的，
 *      导致偏差表的佐证列一直显示「—」。通讯录给出「谁在哪个部门」，
 *      是补这张映射表的依据。
 *
 * 用法：
 *   node dingtalk-sync.js                        # 按 scopes.json 的 defaultScope 拉取
 *   node dingtalk-sync.js --scope smart-energy   # 指定 scope
 *   node dingtalk-sync.js --find "研发中心"       # 按名字找部门 id（不落盘）
 *   node dingtalk-sync.js --all                  # 从根拉全量（很慢，约 2 分钟）
 *   node dingtalk-sync.js --dry                  # 只拉取和统计，不写文件
 *   node dingtalk-sync.js --quiet                # 不打印进度
 *
 * 范围配置：data/dingtalk/scopes.json（已 gitignore）。
 * 要加部门就改那个文件，不用动这里的代码。
 *
 * 凭据来源：data/dingtalk/secret.json（已 gitignore）。
 * 本脚本【只读】钉钉，不写任何东西到钉钉侧。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const client = require('./modules/dingtalk/client');

const OUT_FILE = path.join(__dirname, 'data', 'dingtalk', 'org.json');
const SCOPE_FILE = path.join(__dirname, 'data', 'dingtalk', 'scopes.json');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const QUIET = argv.includes('--quiet');
const ALL = argv.includes('--all');
const arg = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const SCOPE_ID = arg('scope');
const FIND = arg('find');

const ok = s => '\x1b[32m' + s + '\x1b[0m';
const bad = s => '\x1b[31m' + s + '\x1b[0m';
const warn = s => '\x1b[33m' + s + '\x1b[0m';
const dim = s => '\x1b[90m' + s + '\x1b[0m';
const step = n => console.log('\n' + '─'.repeat(60) + '\n' + n);

/** 读取范围配置。读不到就返回空壳，由调用方决定回退到全量还是报错。 */
function readScopes() {
  try {
    return JSON.parse(fs.readFileSync(SCOPE_FILE, 'utf8'));
  } catch (e) {
    return { scopes: [] };
  }
}

/**
 * 按 id 取范围。没指定 id 时取 defaultScope。
 * @returns {{deptId:string, deptName:string, maxDepth:number}|null}
 */
function resolveScope(id) {
  const cfg = readScopes();
  const list = Array.isArray(cfg.scopes) ? cfg.scopes : [];
  if (!list.length) return null;
  const want = id || cfg.defaultScope;
  const hit = list.filter(s => s.id === want)[0];
  if (!hit) {
    console.log(bad('\nscopes.json 里没有 id 为「' + want + '」的范围。'));
    console.log('  已配置的：' + list.map(s => s.id).join(', '));
    process.exit(1);
  }
  return hit;
}

/* ---------- --find：按名字查部门 id ---------- */

/**
 * 只读查询模式：从根遍历部门树，打印名字匹配的部门及其 id。
 * 为什么要它：scopes.json 要填 deptId，而部门 id 在钉钉后台不好找。
 * 这个是只读的，不落盘，可以随便跑。
 */
async function runFind(keyword) {
  console.log('查找部门：' + keyword);
  console.log(dim('  只读查询，不写任何文件。全量遍历较慢，请稍候。'));
  const org = await client.fetchOrg({
    rootDeptId: '1',
    onProgress: (n, st) => {
      if (st) process.stderr.write('\r  已扫 ' + st.done + ' 个部门…        ');
    }
  });
  process.stderr.write('\r' + ' '.repeat(60) + '\r');

  const byId = {};
  org.departments.forEach(d => { byId[d.id] = d; });
  /** 拼出从根到该部门的链路，方便确认是不是要找的那个 */
  function chain(id) {
    const out = [];
    let cur = byId[id];
    for (let g = 0; cur && g < 15; g++) { out.unshift(cur.name); cur = byId[cur.parentId]; }
    return out.join(' > ');
  }

  const hits = org.departments.filter(d => d.name.indexOf(keyword) >= 0);
  if (!hits.length) {
    console.log(warn('\n没找到名字含「' + keyword + '」的部门。'));
    console.log(dim('  注意：--find 只能查到已拉取范围内的部门。'));
    return;
  }
  console.log('\n找到 ' + hits.length + ' 个，填进 scopes.json 的 deptId：\n');
  hits.forEach(d => {
    console.log('  ' + ok(d.id) + '  ' + d.name);
    console.log(dim('     ' + chain(d.id)));
  });
  console.log(dim('\n  取最里层（链路最长的那个）通常是你要的。'));
}

/* ---------- 主流程 ---------- */

(async function main() {
  console.log('钉钉通讯录同步（只读）');
  console.log(dim('  只从钉钉拉取，绝不回写组织架构。'));

  const cfg = client.loadConfig();
  if (!client.isConfigured()) {
    console.log(bad('\n缺少 appKey / appSecret，请填 data/dingtalk/secret.json 后重跑。'));
    process.exit(1);
  }

  if (FIND) return await runFind(FIND);

  /* 决定从哪儿开始拉。三种情况：
       --all          → 根（全量）
       --scope <id>   → 配置里的某个范围
       都不传         → 配置里的 defaultScope；没有配置则回退全量 */
  let rootDeptId = '1';
  let rootDeptName = '根部门（全量）';
  let maxDepth = 8;
  let scopeLabel = '全量';

  if (!ALL) {
    const sc = resolveScope(SCOPE_ID);
    if (sc) {
      rootDeptId = String(sc.deptId);
      rootDeptName = sc.deptName || ('部门 ' + sc.deptId);
      maxDepth = Number(sc.maxDepth) > 0 ? Number(sc.maxDepth) : 8;
      scopeLabel = sc.deptName || sc.id;
    } else if (SCOPE_ID) {
      console.log(bad('\n指定了 --scope 但读不到 data/dingtalk/scopes.json。'));
      process.exit(1);
    } else {
      console.log(warn('\n没有范围配置，回退到全量拉取（约 2 分钟）。'));
      console.log(dim('  要限定范围：先跑 --find 查到部门 id，再写进 data/dingtalk/scopes.json。'));
    }
  }

  console.log(dim('  appKey=' + String(cfg.appKey).slice(0, 8) + '…  凭据已就位'));
  console.log('  范围：' + ok(scopeLabel) + dim('  (deptId=' + rootDeptId + ', maxDepth=' + maxDepth + ')'));

  step('1) 拉取组织架构');
  const started = Date.now();
  let org;
  try {
    org = await client.fetchOrg({
      rootDeptId: rootDeptId,
      rootDeptName: rootDeptName,
      maxDepth: maxDepth,
      /* 进度写到 stderr 并原地刷新。写 stdout 会与结尾的统计输出混在一起，
         而且全量组织有几千个部门，逐条打印会刷屏。 */
      onProgress: QUIET ? null : (name, st) => {
        if (st) process.stderr.write('\r  已扫 ' + st.done + ' / ' + st.total + ' 个部门…        ');
      }
    });
  } catch (e) {
    console.log(bad('❌ 拉取失败：' + e.message));
    if (e.errcode === 60011) {
      console.log(warn('  errcode 60011 = 无权限访问该部门。去开放平台确认应用已开通通讯录权限。'));
    }
    process.exit(1);
  }
  const ms = Date.now() - started;

  step('2) 统计');
  console.log('  部门数：' + ok(String(org.departments.length)));
  console.log('  员工数：' + ok(String(org.users.length)));
  console.log('  耗时：' + dim(ms + ' ms'));

  /* ★ 采集失败必须可见。少一个部门 = 少一批人 = 离职对账漏人，
     这类「少了几个人」不会报错，只会让下游算错。所以错误一律打出来，
     不因为「主流程成功了」就吞掉。
     截断（truncated）单独高亮：它意味着这份快照是【不完整】的，
     拿去开户会漏人，必须让操作的人看见。 */
  if (org.truncated) {
    console.log('\n  ' + bad('⚠⚠ 本次拉取被上限截断，快照不完整，不能用于开户！'));
  }
  if (org.errors.length) {
    console.log('\n  ' + warn('⚠ ' + org.errors.length + ' 处未取到：'));
    org.errors.slice(0, 20).forEach(e => {
      console.log('    - ' + (e.deptName || ('部门 ' + e.deptId)) + '：' + e.reason);
    });
    if (org.errors.length > 20) console.log(dim('    …还有 ' + (org.errors.length - 20) + ' 条'));
  } else {
    console.log('  ' + ok('全量拉取无失败项'));
  }

  /* 工号是 SSO 对齐的唯一键，缺了就没法开户。单独统计出来。 */
  const noJob = org.users.filter(u => !u.jobNumber);
  const activeUsers = org.users.filter(u => u.active !== false);
  const leftUsers = org.users.filter(u => u.active === false);
  console.log('\n  在职 / 已停用：' + ok(String(activeUsers.length)) + ' / ' +
    (leftUsers.length ? warn(String(leftUsers.length)) : String(leftUsers.length)));
  if (noJob.length) {
    console.log('  ' + warn('⚠ ' + noJob.length + ' 人没有工号字段（job_number）—— 这些人无法用于 SSO 开户'));
    noJob.slice(0, 5).forEach(u => console.log(dim('    · ' + u.name + '（' + u.deptName + '）')));
  } else {
    console.log('  ' + ok('所有员工都有工号，可直接用于 SSO 开户'));
  }

  if (DRY) {
    console.log('\n' + dim('--dry 模式，未写入文件。'));
    return;
  }

  step('3) 写入');
  const payload = {
    syncedAt: new Date().toISOString(),
    durationMs: ms,
    /* 记下拉取范围。为什么必须记：docktalk-roster.js 要据此筛选和标注，
       而 org.json 本身看不出「这是全量还是某个部门」—— 曾经因此在小结里
       把 372 人的局部快照标成「范围：全部部门」。 */
    scope: {
      deptId: rootDeptId,
      deptName: rootDeptName,
      maxDepth: maxDepth,
      full: rootDeptId === '1'
    },
    departments: org.departments,
    users: org.users,
    errors: org.errors,
    truncated: !!org.truncated
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log('  ' + ok('✅ 已写入 ') + path.relative(__dirname, OUT_FILE));
  console.log(dim('  下次运行会整体覆盖 —— 通讯录是「当前状态」的快照，不是增量流。'));
})().catch(e => {
  console.log(bad('\n未预期的错误：' + (e && e.stack || e)));
  process.exit(1);
});
