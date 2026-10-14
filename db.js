/* db.js — 平台系统数据库（身份 / 权限 / 审计）
   ★ 定位说明（重要）：
     本文件**不接管**各模块的业务数据。各模块 routes.js 的 state 仍写各自的
     data/<模块>/state.json —— 那是「整体读、整体写」的模式，JSON 天然合适，
     实测 280KB 全量读写仅约 7ms，没有换的理由。
     数据库只负责 JSON 做不了的：按人/按条件查询、追加写、长期留痕。
     详见 docs/plan-ai-m1-foundation.md 第二节。

   选型：node:sqlite（Node v24 内置，零依赖、免原生编译）。
        ⚠️ 该模块目前标记 experimental，启动会有 ExperimentalWarning。
        所有 SQL 都收敛在本文件内，将来若要换 better-sqlite3，只改这里。 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, process.env.DB_FILE || 'platform.db');

let db = null;
let initialAdmin = null;   // 首次建库时生成的默认管理员（含一次性明文密码），仅供启动日志使用

/* ---------- 建表 ---------- */

/* 角色取值（2026-10-14 收敛，用户拍板）：
     admin  —— 全权，hasPermission() 直接放行，不进权限表
     editor —— 可读写。能改哪些模块由【二级权限矩阵】逐模块授权
     reader —— 仅可读。全模块只读，不可配置

   ★ 为什么不保留旧的 admin/pm/dev/viewer：
     pm / dev 是【职能】，viewer 是【访问级别】—— 两个维度揉在一列里，
     界面上用户根本看不出「开发」和「只读」谁大谁小。
     而且旧集合本身是错的：dev 零写权限，viewer 反而多一个 budget:read，
     等于「开发」比「只读」看得还少。现在只留访问级别这一个维度，
     职能信息归 department 字段（钉钉通讯录带入），不要去占用 role。 */
const ROLES = {
  ADMIN: 'admin',
  EDITOR: 'editor',
  READER: 'reader'
};

/** 可用角色清单。所有校验（建号、改角色、批量导入）都从这里取，不再各处硬编码数组。 */
const ROLE_LIST = [ROLES.ADMIN, ROLES.EDITOR, ROLES.READER];

/** 角色中文名。界面文案只有这一处来源，改名不用满仓库找。 */
const ROLE_LABELS = {
  [ROLES.ADMIN]: '管理员',
  [ROLES.EDITOR]: '可读写',
  [ROLES.READER]: '仅可读'
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  dingtalk_id   TEXT,                      -- 钉钉 userId，将来扫码登录用
  password_hash TEXT,                      -- scrypt 加盐哈希；纯钉钉登录的用户可为空
  role          TEXT NOT NULL DEFAULT 'reader',
  department    TEXT,                      -- 部门（钉钉通讯录叶子部门名）。用于部门 admin 只读本部门、按部门筛选
  enabled       INTEGER NOT NULL DEFAULT 1,
  pwd_is_initial INTEGER NOT NULL DEFAULT 0, -- 1 = 还在用批量建号发的初始密码（前端提示可改，不强制）
  created_at    TEXT,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

/* 审计日志：追加写，永不全量重写、永不截断。
   最后两个 AI 字段现在用不上，但它们是 Harness「AI 行为可追溯」的落点——
   等 M3 接上 Agent 才写值。现在建好，将来直接写，不用改表。 */
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  user_id      TEXT,
  user_name    TEXT,
  module       TEXT,
  action       TEXT,
  details      TEXT,
  ai_triggered INTEGER DEFAULT 0,   -- 1 = 该操作由 AI 触发
  ai_adopted   INTEGER              -- 1 = AI 建议被采纳，0 = 被拒绝，NULL = 非 AI 操作
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

/* 权限矩阵：role × resource → 是否允许
   resource 形如 'plan:read' / 'plan:write' / 'budget:write' / 'ai:doc' / 'ai:finance' */
CREATE TABLE IF NOT EXISTS permissions (
  role     TEXT NOT NULL,
  resource TEXT NOT NULL,
  allowed  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role, resource)
);

/* 系统元信息（schema 版本、迁移标记等） */
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/* 默认权限矩阵。admin 不在表里判定——见 hasPermission()，admin 一律放行。

   editor / reader 两档：
     editor 是【基准集】，逐模块的写权限由管理员在「权限矩阵」里按需调整。
     这里给的是「刚建号时的合理默认」，不是天花板。
     reader 只给只读。

   ★ 权限点用【逐条 INSERT OR IGNORE】播种，见下方 seedPermissions() ——
     不要把这里改成按角色整体判断。 */
const DEFAULT_PERMISSIONS = {
  editor: [
    'plan:read', 'plan:write', 'iteration:read', 'iteration:write',
    'project:read', 'project:write', 'csenergy:read', 'csenergy:write',
    'budget:read', 'token:read', 'dashboard:read', 'archive:read', 'archive:write',
    'pradapter:read', 'pradapter:write',   // Git PR adapter：采集/确认映射/看告警
    'skill:read', 'skill:write',            // AI Skill 运行时：风险/周报/偏差 + 确认待确认项
    'inbox:read', 'inbox:write',             // 今日待确认：跨 Skill 聚合入口（AI 输出的统一落点）
    'notify:read', 'notify:write',           // 钉钉主动推送：看配置/待发队列 + 改配置/手动发/补发
    'dingtalk:read', 'dingtalk:write',        // 钉钉身份打通：看绑定状态 + 触发绑定/解绑
    'ai:doc', 'ai:risk', 'ai:report'          // 可调用文档/风险/周报 Agent
    // 刻意不含 'budget:write' 与 'ai:finance'：改预算基准、调财务 Agent 属管理员动作
  ],
  reader: [
    'plan:read', 'iteration:read', 'project:read', 'csenergy:read',
    'budget:read', 'token:read', 'dashboard:read', 'pradapter:read', 'skill:read', 'inbox:read',
    'dingtalk:read'
  ]
};

/* 旧角色名 → 新角色名（2026-10-14 一次性迁移用）。
   dev 落到 reader 而不是 editor：dev 在旧矩阵里【零写权限】，
   直接给 editor 等于顺手放宽了写权限，那是提权不是改名。
   需要写权限的人，改完角色后在权限矩阵里单独开。 */
const ROLE_MIGRATION = {
  pm: 'editor',
  dev: 'reader',
  viewer: 'reader'
};

/* ---------- 打开与初始化 ---------- */

/* 轻量迁移：给已存在的旧库补列。
   CREATE TABLE IF NOT EXISTS 只在建表时生效，旧库不会自动多出新列，所以必须单独 ALTER。
   加列是幂等的（已存在会抛错），按列名存在性判断，避免每次启动都 catch 异常。 */
function migrate() {
  const cols = get().prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('pwd_is_initial')) {
    get().exec('ALTER TABLE users ADD COLUMN pwd_is_initial INTEGER NOT NULL DEFAULT 0');
    console.log('[db] 已为 users 表补列 pwd_is_initial（初始密码标记）');
  }
  if (!cols.includes('department')) {
    get().exec('ALTER TABLE users ADD COLUMN department TEXT');
    console.log('[db] 已为 users 表补列 department（部门，用于部门 admin 与按部门筛选）');
  }
  migrateRoles();
}

/* 角色模型 v2 迁移：admin/pm/dev/viewer → admin/editor/reader（2026-10-14 用户拍板）
   「一把改透，不留映射层」——底层存的就是新名，界面上不再有「显示名 ↔ 存储名」的对应表。

   为什么必须有版本标记：本函数每次启动都跑，没有标记的话
   ① 每次都全表 UPDATE（373 行，白扫一遍）；
   ② 更糟的是——管理员后来手动把某人从 editor 调回 reader，
      下次重启又被「迁移」覆盖一遍，且不报错。用 meta 打标记，跑一次就封存。

   顺带清掉旧的权限行：不清的话 permissions 表里会长期留着 pm/dev/viewer 三条僵尸角色，
   下次有人翻表会以为还有三个角色。新角色的行由 seedPermissions() 补齐。 */
function migrateRoles() {
  if (getMeta('role_model')) return;

  const counts = {};
  Object.keys(ROLE_MIGRATION).forEach(oldRole => {
    const n = get().prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(oldRole).n;
    if (n) {
      counts[oldRole + '→' + ROLE_MIGRATION[oldRole]] = n;
      get().prepare('UPDATE users SET role = ? WHERE role = ?').run(ROLE_MIGRATION[oldRole], oldRole);
    }
  });

  /* 清权限表的旧角色行。注意要在 UPDATE users 之后跑，
     否则「先删权限、后改用户」中间若失败，会出现有角色无权限的空窗。 */
  ['pm', 'dev', 'viewer'].forEach(r => {
    get().prepare('DELETE FROM permissions WHERE role = ?').run(r);
  });

  /* 没被规则覆盖的角色值原样留着并告警：宁可见到一条刺眼的日志，
     也不猜。「不认识的角色就当只读吧」这种兜底会让权限悄悄降级而无人察觉。 */
  const unknown = get().prepare(
    "SELECT role, COUNT(*) AS n FROM users WHERE role NOT IN (?,?,?) GROUP BY role"
  ).all(ROLES.ADMIN, ROLES.EDITOR, ROLES.READER);
  unknown.forEach(u => {
    console.warn('[db] ⚠ 未识别的角色值「' + u.role + '」共 ' + u.n +
      ' 个账号，已原样保留。请用 user-cli.js role <账号> <角色> 逐个确认。');
  });

  setMeta('role_model', 'v2');
  const moved = Object.keys(counts).map(k => k + ' ' + counts[k] + ' 个').join('，');
  console.log('[db] 角色模型已迁移到 v2：' + (moved || '无需迁移') +
    '。新角色：' + ROLE_LIST.join(' / '));
}

function open() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');   // 并发读不被写阻塞
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate();
  seedPermissions();
  seedDefaults();
  return db;
}

function get() {
  return db || open();
}

/* 写入默认权限。
   按【权限点】逐条补齐，不是按【角色】整体跳过 —— 这一点必须说清楚：

   原写法是「该角色一行都没有才播种」。后果是：db.js 里新增一个权限点
   （比如后来的 skill:read / pradapter:read），旧库里的角色早就"已有行"，
   于是整批跳过，新权限点一条都落不了库，而且**全程不报错** ——
   permissions 表看着正常，相关功能却一直 403，极难排查。
   （2026-09-22 实测：库里 skill:read / pradapter:read 一条都没有，
    导致 dataflow.html 全部接口返回「没有权限」。）

   改成逐条 INSERT OR IGNORE 后：
     - 新库：行为与从前一致
     - 旧库：只补缺失的权限点，已存在的行不被动
     - 被管理员手动改成 allowed=0 的行也不会被重置（OR IGNORE 不覆盖已存在行） */
function seedPermissions() {
  const ins = get().prepare(
    'INSERT OR IGNORE INTO permissions(role, resource, allowed) VALUES(?, ?, 1)');
  Object.keys(DEFAULT_PERMISSIONS).forEach(role => {
    DEFAULT_PERMISSIONS[role].forEach(r => ins.run(role, r));
  });
}

/* 首次启动时建一个默认管理员，密码打印在控制台，强制首次登录后修改 */
function seedDefaults() {
  const n = get().prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return null;

  const pwd = crypto.randomBytes(6).toString('base64url');   // 8 位随机密码
  const now = new Date().toISOString();
  get().prepare(
    'INSERT INTO users(id, name, password_hash, role, enabled, created_at, updated_at) VALUES(?,?,?,?,1,?,?)'
  ).run('admin', '管理员', hashPassword(pwd), 'admin', now, now);
  setMeta('created_at', now);
  initialAdmin = { id: 'admin', password: pwd };
  return initialAdmin;
}

/** 取首次建库时生成的默认管理员密码，取过就没了（避免密码反复出现在日志里） */
function takeInitialAdmin() {
  const r = initialAdmin;
  initialAdmin = null;
  return r;
}

/* ---------- 密码哈希（scrypt 加盐）---------- */

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

/** 校验密码。用 timingSafeEqual 防时序侧信道。 */
function verifyPassword(plain, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const calc = crypto.scryptSync(String(plain), parts[1], 64);
    const want = Buffer.from(parts[2], 'hex');
    return calc.length === want.length && crypto.timingSafeEqual(calc, want);
  } catch (e) { return false; }
}

/* ---------- 用户 ---------- */

function findUser(id) {
  return get().prepare('SELECT * FROM users WHERE id = ?').get(String(id || '')) || null;
}

function listUsers() {
  /* 带上 pwd_is_initial：373 个号里 372 个还在用批量建号发的初始密码，
     管理页面必须能一眼看出「谁还没改密码」，否则这个数只能靠数库。
     只 SELECT 展示需要的列，不含 password_hash。 */
  return get().prepare(
    'SELECT id, name, role, department, dingtalk_id, enabled, pwd_is_initial, created_at ' +
    'FROM users ORDER BY department, id'
  ).all();
}

/** 按钉钉 userId 反查人。钉钉登录的第二道匹配用 —— 首次登录前该列为 NULL，查不到是正常的。 */
function findUserByDingtalkId(dingtalkId) {
  if (!dingtalkId) return null;
  return get().prepare('SELECT * FROM users WHERE dingtalk_id = ? LIMIT 1')
    .get(String(dingtalkId)) || null;
}

function createUser({ id, name, password, role, dingtalkId, initialPassword, department }) {
  if (!id || !name) throw new Error('账号和姓名不能为空');
  if (findUser(id)) throw new Error('账号已存在：' + id);
  /* 角色兜底走 reader（最小权限）。不再兜到 admin/pm 之类的宽角色——
     调用方漏传角色时，宁可给只读，也不要静默给写权限。 */
  const r = role ? String(role) : ROLES.READER;
  if (ROLE_LIST.indexOf(r) < 0) throw new Error('角色非法：' + r + '（可选 ' + ROLE_LIST.join(' / ') + '）');
  const now = new Date().toISOString();
  get().prepare(
    'INSERT INTO users(id, name, password_hash, role, department, dingtalk_id, enabled, pwd_is_initial, created_at, updated_at) VALUES(?,?,?,?,?,?,1,?,?,?)'
  ).run(String(id), String(name), password ? hashPassword(password) : null,
        r, department ? String(department) : null,
        dingtalkId || null, initialPassword ? 1 : 0, now, now);
  return findUser(id);
}

/** 改密码。默认清掉「初始密码」标记——用户自己改过就不该再提示。 */
function setPassword(id, plain, opts) {
  const keepInitial = !!(opts && opts.keepInitial);
  get().prepare('UPDATE users SET password_hash = ?, pwd_is_initial = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(plain), keepInitial ? 1 : 0, new Date().toISOString(), String(id));
}

function setRole(id, role) {
  get().prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
    .run(String(role), new Date().toISOString(), String(id));
}

/**
 * 记录某人的钉钉 userId。
 * 钉钉免登成功后回填 —— 首次登录前这一列是空的（373 个存量账号全部为 NULL），
 * 所以它能当「这个人已经用钉钉登录过」的标记，也供后续按钉钉身份反查人。
 * 传空值即清掉（解绑）。
 */
function setDingtalkId(id, dingtalkId) {
  get().prepare('UPDATE users SET dingtalk_id = ?, updated_at = ? WHERE id = ?')
    .run(dingtalkId ? String(dingtalkId) : null, new Date().toISOString(), String(id));
}

/* ---------- 会话 ---------- */

const SESSION_DAYS = 30;

/**
 * 建会话。
 * @param {string} userId
 * @param {number} [ttlSec] 有效期（秒）。不传按本地会话默认 30 天。
 *   为什么留这个口子：SSO 登录时有效期必须用平台返回的 expires_in，
 *   不能再用本地默认值 —— 否则 SSO 那边 token 3 天过期了，
 *   这边还留着 30 天的会话，用户可以不经过 SSO 直接进平台。
 */
function createSession(userId, ttlSec) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const ms = ttlSec > 0 ? ttlSec * 1000 : SESSION_DAYS * 86400000;
  const exp = new Date(now.getTime() + ms);
  get().prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)')
    .run(token, String(userId), now.toISOString(), exp.toISOString());
  return { token, expiresAt: exp.toISOString() };
}

/** 用 token 换用户。过期或不存在返回 null，并顺手清掉这条过期记录。 */
function sessionUser(token) {
  if (!token) return null;
  const row = get().prepare('SELECT * FROM sessions WHERE token = ?').get(String(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    get().prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
    return null;
  }
  const u = findUser(row.user_id);
  if (!u || !u.enabled) return null;
  return { id: u.id, name: u.name, role: u.role };
}

function destroySession(token) {
  if (token) get().prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
}

/** 清理所有过期会话（启动时调一次即可） */
function purgeExpiredSessions() {
  return get().prepare('DELETE FROM sessions WHERE expires_at < ?')
    .run(new Date().toISOString()).changes;
}

/* ---------- 权限 ---------- */

/** admin 一律放行；其余查表。表里没有的记录视为不允许（默认拒绝）。 */
function hasPermission(role, resource) {
  if (role === 'admin') return true;
  const row = get().prepare('SELECT allowed FROM permissions WHERE role = ? AND resource = ?')
    .get(String(role || ''), String(resource || ''));
  return !!(row && row.allowed);
}

function listPermissions(role) {
  return get().prepare('SELECT resource, allowed FROM permissions WHERE role = ?').all(String(role))
    .map(r => r.resource);
}

/**
 * 取某角色的完整权限表（含 allowed 状态）。
 * listPermissions() 只回资源名、丢掉了 allowed，渲染权限矩阵时读不出「这一项到底开没开」，
 * 所以矩阵要的是这个而不是它。两者用途不同，都留着。
 * @returns {Array<{resource:string, allowed:number}>}
 */
function getPermissions(role) {
  return get().prepare('SELECT resource, allowed FROM permissions WHERE role = ?')
    .all(String(role));
}

function setPermission(role, resource, allowed) {
  get().prepare(
    'INSERT INTO permissions(role, resource, allowed) VALUES(?,?,?) ON CONFLICT(role, resource) DO UPDATE SET allowed = excluded.allowed'
  ).run(String(role), String(resource), allowed ? 1 : 0);
}

/* ---------- 审计（追加写，绝不重写、绝不截断）---------- */

/**
 * 写一条审计日志。签名与旧版 audit.js 保持兼容（多出的字段可选）。
 * @param {{user?:string, user_id?:string, module?:string, action?:string, details?:string,
 *          ai_triggered?:boolean, ai_adopted?:boolean}} entry
 */
function logAudit(entry) {
  const e = entry || {};
  get().prepare(
    'INSERT INTO audit_log(ts, user_id, user_name, module, action, details, ai_triggered, ai_adopted) VALUES(?,?,?,?,?,?,?,?)'
  ).run(
    e.timestamp || new Date().toLocaleString('zh-CN'),
    e.user_id || e.userId || null,
    e.user || e.user_name || null,
    e.module || null,
    e.action || null,
    e.details || null,
    e.ai_triggered ? 1 : 0,
    e.ai_adopted == null ? null : (e.ai_adopted ? 1 : 0)
  );
}

function getAudit(limit, filter) {
  const f = filter || {};
  const where = [], args = [];
  if (f.user) { where.push('(user_name = ? OR user_id = ?)'); args.push(f.user, f.user); }
  if (f.module) { where.push('module = ?'); args.push(f.module); }
  if (f.since) { where.push('ts >= ?'); args.push(f.since); }
  const sql = 'SELECT * FROM audit_log' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY id DESC LIMIT ?';
  args.push(Number(limit) || 50);
  return get().prepare(sql).all(...args);
}

/** 审计总条数——用于向用户证明「不再只留 200 条」 */
function auditCount() {
  return get().prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
}

/* ---------- 元信息 ---------- */

function setMeta(key, value) {
  get().prepare('INSERT INTO meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(String(key), String(value));
}

function getMeta(key) {
  const r = get().prepare('SELECT value FROM meta WHERE key = ?').get(String(key));
  return r ? r.value : null;
}

/* ---------- 供测试用：内存库 ---------- */

function useMemory() {
  db = new DatabaseSync(':memory:');
  initialAdmin = null;
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  seedPermissions();
  seedDefaults();
  return db;
}

module.exports = {
  open, get, useMemory, DB_FILE,
  ROLES, ROLE_LIST, ROLE_LABELS,
  hashPassword, verifyPassword,
  findUser, listUsers, findUserByDingtalkId, createUser, setPassword, setRole, setDingtalkId, takeInitialAdmin,
  createSession, sessionUser, destroySession, purgeExpiredSessions,
  hasPermission, listPermissions, getPermissions, setPermission,
  logAudit, getAudit, auditCount,
  setMeta, getMeta,
  migrateRoles,
  DEFAULT_PERMISSIONS
};
