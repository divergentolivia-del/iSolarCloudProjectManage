/* user-import.js — 批量建号（几百人规模用）

   为什么需要它：部门几百人时，一个个在界面上建账号不现实；
   而账号就是工号、口令是「姓名缩写 + 固定后缀」，规则固定，适合一次性批量导入。

   设计要点：
     - 口令规则从 data/auth-config.json 读，不写死在代码里（见 docs/plan-dingtalk-sso.md D4）
     - 程序不做拼音转换（零依赖是本项目的硬约束），姓名缩写出 CSV 的「口令前缀」列带进来
     - 已存在的工号一律跳过，绝不覆盖口令和角色（重跑安全）

   用法:
     node user-import.js --dry-run docs/samples/员工名单.csv   → 只看会建哪些号，不写库
     node user-import.js docs/samples/员工名单.csv             → 正式导入

   名单格式（CSV，首行表头，UTF-8）:
     工号,姓名,口令前缀[,角色]
     10017xxx,张三,zs
     10018xxx,李四,ls,pm

   注意：本脚本直接写平台数据库，请先停掉服务再执行，避免写入竞争。
*/

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

const ROLES = ['admin', 'pm', 'dev', 'viewer'];

/* 口令规则配置：与 db.js 同源，落在 data 目录下（已 gitignore） */
const CONFIG_FILE = path.join(
  process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'),
  'auth-config.json'
);
const DEFAULT_CONFIG = {
  defaultPasswordSuffix: '2026',
  defaultPasswordMode: 'initials+suffix',
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

/** 读口令规则。读不到（或坏了）用内置默认值并提示，绝不因此中断导入。 */
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
  if (cfg.defaultPasswordMode !== 'initials+suffix') {
    fail('不支持的 defaultPasswordMode：' + cfg.defaultPasswordMode + '，当前只实现了 initials+suffix');
  }
  return cfg;
}

/** 拼口令。前缀由名单带进来（程序不做拼音转换），这里只负责「前缀 + 后缀」。 */
function buildPassword(prefix, cfg) {
  return String(prefix || '') + String(cfg.defaultPasswordSuffix || '');
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
  const ci = { id: col('工号'), name: col('姓名'), prefix: col('口令前缀'), role: col('角色') };
  if (ci.id < 0 || ci.name < 0 || ci.prefix < 0) {
    fail('表头至少要有「工号,姓名,口令前缀」三列。实际读到：' + header.join(','));
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
    if (!prefix) { rows.push({ lineNo: lineNo, id: id, name: name, bad: '缺口令前缀' }); continue; }
    if (role && ROLES.indexOf(role) < 0) {
      rows.push({ lineNo: lineNo, id: id, name: name, bad: '角色非法：' + role + '，可选 ' + ROLES.join('/') });
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
  const rows = readRoster(file);

  console.log('账号库：  ' + DB_DESC);
  console.log('名单：    ' + file);
  console.log('口令规则：前缀 + 后缀「' + cfg.defaultPasswordSuffix + '」'
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
      console.log('  ' + r.id.padEnd(14) + r.name.padEnd(10) + r.role.padEnd(8) + '口令 ' + buildPassword(r.prefix, cfg));
    });
    if (skipped.length) {
      console.log('');
      console.log('库中已存在、将跳过 ' + skipped.length + ' 个（不覆盖其口令与角色）：');
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
        password: buildPassword(r.prefix, cfg),
        initialPassword: true
      });
      db.logAudit({
        user_id: r.id,
        user: r.name,
        module: 'auth',
        action: '批量建号',
        details: '角色 ' + r.role + '，初始口令'
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
    console.log('  1. 起服务并设 AUTH_REQUIRED=1，用工号加初始口令登一次');
    console.log('  2. 确认顶部出现「你还在使用初始口令」提示条');
    console.log('  3. 各账号自行到「修改口令」改掉即可，不强制');
    console.log('  4. 要核对全部账号：node user-cli.js list');
  }
}

main();
