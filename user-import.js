/* user-import.js — 批量建号（几百人规模用）

   为什么需要它：部门几百人时，一个个在界面上建账号不现实；
   而账号就是工号、密码是「姓名缩写 + 固定后缀」，规则固定，适合一次性批量导入。

   设计要点：
     - 密码规则从 data/auth-config.json 读，不写死在代码里（见 docs/plan-dingtalk-sso.md D4）
     - 程序不做拼音转换（零依赖是本项目的硬约束）
     - 当前公式：前缀 + 后缀 + 工号后 6 位（defaultPasswordMode: initials+suffix+last6）
     - 「密码前缀」列因此是【可选】的：留空就是「后缀+工号后6位」，能开户、且天然不重名
     - 已存在的工号一律跳过，绝不覆盖密码和角色（重跑安全）

   用法:
     node user-import.js --dry-run docs/samples/员工名单.csv   → 只看会建哪些号，不写库
     node user-import.js docs/samples/员工名单.csv             → 正式导入

   名单格式（CSV，首行表头，UTF-8）:
     工号,姓名,密码前缀[,角色]
     10017xxx,张三,zs
     10018xxx,李四,,pm          ← 前缀可留空
     多出来的列会被忽略（如 dingtalk-roster.js 产出的「部门」列）。

   注意：本脚本直接写平台数据库，请先停掉服务再执行，避免写入竞争。
*/

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

const ROLES = ['admin', 'pm', 'dev', 'viewer'];

/* 已实现的密码公式。加公式时这里和 buildPassword 一起改。 */
const SUPPORTED_MODES = ['initials+suffix', 'initials+suffix+last6'];
/* 公式里含工号段时，前缀就是可选的 —— 判据跟着公式走，不写死。
   readRoster 在 loadConfig 之前被调用，所以这份配置在入口处赋值。 */
let PREFIX_OPTIONAL = false;
let CFG_AT_READ = null;

/* 密码规则配置：与 db.js 同源，落在 data 目录下（已 gitignore） */
const CONFIG_FILE = path.join(
  process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'),
  'auth-config.json'
);
const DEFAULT_CONFIG = {
  defaultPasswordSuffix: '2026',
  defaultPasswordMode: 'initials+suffix+last6',
  forceChangeOnFirstLogin: false
};

const DB_DESC = process.env.DATA_DIR
  ? process.env.DATA_DIR + '/' + (process.env.DB_FILE || 'platform.db')
  : './data/' + (process.env.DB_FILE || 'platform.db');

function fail(msg) {
  console.error('\n失败：' + msg);
  process.exit(1);
}

function usage(code) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''));
  process.exit(code || 0);
}

/* ---------- 配置 ---------- */

/** 读密码规则。读不到（或坏了）用内置默认值并提示，绝不因此中断导入。 */
function loadConfig() {
  let cfg = DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg = Object.assign({}, DEFAULT_CONFIG, raw);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('提示：未找到 ' + CONFIG_FILE + '，本次用内置默认规则（后缀 ' + DEFAULT_CONFIG.defaultPasswordSuffix + '）。');
    } else {
      console.log('提示：' + CONFIG_FILE + ' 读取失败（' + e.message + '），本次用内置默认规则。');
    }
  }
  if (SUPPORTED_MODES.indexOf(cfg.defaultPasswordMode) < 0) {
    fail('不支持的 defaultPasswordMode：' + cfg.defaultPasswordMode
      + '，可选 ' + SUPPORTED_MODES.join(' / '));
  }
  return cfg;
}

/**
 * 拼密码。规则 = 「前缀（名单带来，可空）」+「固定后缀」+「工号后 6 位」。
 *
 * ── 为什么要有工号段（2026-09-24 加）──────────────────────────
 * 原本只有「前缀 + 后缀」。问题出在前缀是人按姓名缩写手填的：
 *   1. 372 行全得手工填，而程序不做拼音转换（零依赖约束），填不了就导入不了；
 *   2. 重名的人前缀一样（两个张磊都是 zl），加同一个后缀后密码完全相同 ——
 *      等于两个人共用一套账号密码，而且谁也没法从密码看出来。
 *
 * 工号段直接解决这两点：它是唯一的（同工号本来就只发一个账号），
 * 是现成的（CSV 里就有），且不需要拼音。前缀那一列因此变成【可选】：
 * 填了是「zl20268531」，不填是「20268531」，都能开户。
 *
 * 保留前缀段而不是直接删掉，是因为老名单（已发出去的）带前缀，
 * 换公式会让那些人按新公式登录不上。老规则仍可通过
 * defaultPasswordMode 切回 'initials+suffix'。
 *
 * ── 为什么取【后 6 位】而不是后 4 位（2026-09-24 实测）────────────
 * 工号是 8 位，但前缀不止一种（1001xxxx / 1004xxxx / 1005xxxx），
 * 所以「后 4 位」不唯一 —— 实测 372 人里有 5 组撞号：
 *   10033343 王卢卢 / 10043343 季星宇    ← 后4位都是 3343
 *   10014295 王志成 / 10044295 王振
 *   10017138 韦凯   / 10047138 陈斌
 *   10019814 王统领 / 10049814 张鸿鹏
 *   10040705 张可涵 / 10050705 王寅
 * 这些人会拿到同一个密码。去掉 2 位前缀后的 6 位是流水号，实测 372 人无重合。
 *
 * 依然只是个约定，不是保证 —— 流水号是 6 位十进制，理论上会回卷。
 * 真要防重复，靠的是库里工号唯一（users.id），密码段只是减小概率。
 */
function buildPassword(prefix, id, cfg) {
  const suffix = String(cfg.defaultPasswordSuffix || '');
  const mode = cfg.defaultPasswordMode || DEFAULT_CONFIG.defaultPasswordMode;
  const tail = String(id || '').slice(-6);
  if (mode === 'initials+suffix') {
    return String(prefix || '') + suffix;           // 老规则，兼容老名单
  }
  return String(prefix || '') + suffix + tail;      // initials+suffix+last6
}

/* ---------- CSV ---------- */

/* 极简 CSV 解析：支持双引号包裹、字段内逗号、双写引号转义。
   名单是人手维护的，不做流式解析，整个读进来即可。 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(function (s) { return s.trim(); });
}

/** 读名单，返回 [{lineNo, id, name, prefix, role}] 或带 bad 字段的错误行。 */
function readRoster(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail('读不到名单文件：' + file + '（' + e.message + '）');
  }
  /* 去掉 UTF-8 BOM。Excel 另存 CSV 时会加，不处理的话第一列表头会多出不可见字符 */
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
  if (!lines.length) fail('名单是空的：' + file);

  const header = parseCsvLine(lines[0]);
  function col(name) { return header.indexOf(name); }
  /* 「密码前缀」原名「口令前缀」。2026-09-22 统一术语时改了列头，
     但**已经发出去的老名单表还在用旧列头** —— 只认新名字的话，
     那些表明了却没有被覆盖，会直接报「表头不对」。所以旧名继续认。
     新名优先：两个都在时以新名为准。 */
  function colPrefix() {
    const i = col('密码前缀');
    return i >= 0 ? i : col('口令前缀');
  }
  const ci = { id: col('工号'), name: col('姓名'), prefix: colPrefix(), role: col('角色') };
  if (ci.id < 0 || ci.name < 0 || ci.prefix < 0) {
    fail('表头至少要有「工号,姓名,密码前缀」三列。实际读到：' + header.join(','));
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const lineNo = i + 1;
    const id = (f[ci.id] || '').trim();
    const name = (f[ci.name] || '').trim();
    const prefix = (f[ci.prefix] || '').trim();
    const role = ci.role >= 0 ? (f[ci.role] || '').trim() : '';

    if (!id && !name) continue;                                  // 整行空，跳过
    if (!id) { rows.push({ lineNo: lineNo, bad: '缺工号' }); continue; }
    if (!name) { rows.push({ lineNo: lineNo, id: id, bad: '缺姓名' }); continue; }
    /* 前缀【可以为空】。当前公式是「前缀+后缀+工号后6位」，前缀只是可选段；
       过去只有「前缀+后缀」，所以前缀是必填。判据是「拼出来的密码够不够长」，
       而不是「前缀填没填」—— 否则 372 行的名单会整份被拒。 */
    if (!prefix && !PREFIX_OPTIONAL) {
      rows.push({ lineNo: lineNo, id: id, name: name, bad: '缺密码前缀' });
      continue;
    }
    if (role && ROLES.indexOf(role) < 0) {
      rows.push({ lineNo: lineNo, id: id, name: name, bad: '角色非法：' + role + '，可选 ' + ROLES.join('/') });
      continue;
    }
    /* 密码太短不值得发。平台改密的下限是 6 位（见 modules/auth/routes.js），
       首发的初始密码没理由比这还弱。 */
    const pwd = buildPassword(prefix, id, CFG_AT_READ);
    if (pwd.length < 6) {
      rows.push({ lineNo: lineNo, id: id, name: name, bad: '拼出的密码只有 ' + pwd.length + ' 位（' + pwd + '），至少要 6 位' });
      continue;
    }
    rows.push({ lineNo: lineNo, id: id, name: name, prefix: prefix, role: role || 'viewer' });
  }
  return rows;
}

/* ---------- 主流程 ---------- */

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.indexOf('--dry-run') >= 0 || argv.indexOf('-n') >= 0;
  const file = argv.filter(function (a) { return a.charAt(0) !== '-'; })[0];
  if (!file) usage(1);

  const cfg = loadConfig();
  /* readRoster 要按公式判断「前缀能不能空」，而它跑在 loadConfig 之后 ——
     把结果挂到模块变量上，避免 readRoster 再读一次配置文件。 */
  CFG_AT_READ = cfg;
  PREFIX_OPTIONAL = String(cfg.defaultPasswordMode).indexOf('last') >= 0;
  const rows = readRoster(file);

  console.log('账号库：  ' + DB_DESC);
  console.log('名单：    ' + file);
  console.log('密码规则：前缀 + 后缀「' + cfg.defaultPasswordSuffix + '」'
    + (cfg.forceChangeOnFirstLogin ? '，要求首次改密' : '，不强制改密仅提示'));
  console.log('模式：    ' + (dryRun ? '干跑，不写库' : '正式导入'));
  console.log('');

  /* 名单自身的格式问题和「库里已存在」分开统计，
     这样「为什么没建成」一眼能看出是名单的问题还是重复的问题 */
  const bad = rows.filter(function (r) { return r.bad; });
  const ok = rows.filter(function (r) { return !r.bad; });

  const toCreate = [];
  const skipped = [];
  const seen = {};
  const dupeInFile = [];

  for (let i = 0; i < ok.length; i++) {
    const r = ok[i];
    if (seen[r.id]) { if (dupeInFile.indexOf(r.id) < 0) dupeInFile.push(r.id); continue; }
    seen[r.id] = true;
    if (db.findUser(r.id)) skipped.push(r);
    else toCreate.push(r);
  }

  /* 先检查、再写：任何一条不合格就整体不写，避免建一半留下半套账号 */
  if (bad.length || dupeInFile.length) {
    if (bad.length) {
      console.log('名单有 ' + bad.length + ' 行不合格，本次不导入：');
      bad.forEach(function (r) {
        console.log('   第 ' + r.lineNo + ' 行  ' + (r.id || '(空)') + '  ' + (r.name || '') + '  → ' + r.bad);
      });
      console.log('');
    }
    if (dupeInFile.length) {
      console.log('名单里有重复工号 ' + dupeInFile.length + ' 个，本次不导入：');
      console.log('   ' + dupeInFile.join('、'));
      console.log('');
    }
    console.log('改好名单后重跑。');
    process.exit(1);
  }

  if (dryRun) {
    console.log('将要新建 ' + toCreate.length + ' 个账号：');
    toCreate.forEach(function (r) {
      console.log('  ' + r.id.padEnd(14) + r.name.padEnd(10) + r.role.padEnd(8) + '密码 ' + buildPassword(r.prefix, r.id, cfg));
    });
    if (skipped.length) {
      console.log('');
      console.log('库中已存在、将跳过 ' + skipped.length + ' 个（不覆盖其密码与角色）：');
      console.log('  ' + skipped.map(function (r) { return r.id; }).join('、'));
    }
    console.log('');
    console.log('干跑结束，数据库未做任何改动。去掉 --dry-run 即可正式导入。');
    return;
  }

  /* 正式导入。逐条建号、出错单独收集，不整体回滚：
     已经建好的账号再跑一次会被跳过，所以重试是安全的。 */
  let created = 0;
  const failed = [];
  for (let i = 0; i < toCreate.length; i++) {
    const r = toCreate[i];
    try {
      db.createUser({
        id: r.id,
        name: r.name,
        role: r.role,
        password: buildPassword(r.prefix, r.id, cfg),
        initialPassword: true
      });
      db.logAudit({
        user_id: r.id,
        user: r.name,
        module: 'auth',
        action: '批量建号',
        details: '角色 ' + r.role + '，初始密码'
      });
      created++;
    } catch (e) {
      failed.push({ id: r.id, why: e.message });
    }
  }

  console.log('导入完成：');
  console.log('  新建 ' + created + ' 个');
  console.log('  跳过 ' + skipped.length + ' 个（库中已存在）');
  console.log('  失败 ' + failed.length + ' 个');
  if (failed.length) {
    console.log('');
    failed.forEach(function (f) { console.log('    ' + f.id + ' → ' + f.why); });
  }

  if (created) {
    console.log('');
    console.log('接下来：');
    console.log('  1. 起服务并设 AUTH_REQUIRED=1，用工号加初始密码登一次');
    console.log('  2. 确认顶部出现「你还在使用初始密码」提示条');
    console.log('  3. 各账号自行到「修改密码」改掉即可，不强制');
    console.log('  4. 要核对全部账号：node user-cli.js list');
  }
}

main();
