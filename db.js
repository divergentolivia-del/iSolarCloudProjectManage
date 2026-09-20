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
let initialAdmin = null;   // 首次建库时生成的默认管理员（含一次性明文口令），仅供启动日志使用

/* ---------- 建表 ---------- */

/* 角色取值：admin（全权）/ pm（可改计划迭代资源）/ dev（只能动自己的任务）/ viewer（只读） */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  dingtalk_id   TEXT,                      -- 钉钉 userId，将来扫码登录用
  password_hash TEXT,                      -- scrypt 加盐哈希；纯钉钉登录的用户可为空
  role          TEXT NOT NULL DEFAULT 'viewer',
  enabled       INTEGER NOT NULL DEFAULT 1,
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

/* 默认权限矩阵。admin 不在表里判定——见 hasPermission()，admin 一律放行。 */
const DEFAULT_PERMISSIONS = {
  pm: [
    'plan:read', 'plan:write', 'iteration:read', 'iteration:write',
    'project:read', 'project:write', 'csenergy:read', 'csenergy:write',
    'budget:read', 'token:read', 'dashboard:read', 'archive:read', 'archive:write',
    'ai:doc', 'ai:risk', 'ai:report'          // 可调用文档/风险/周报 Agent
    // 刻意不含 'budget:write' 与 'ai:finance'：PM 不能改预算基准、不能调财务 Agent
  ],
  dev: [
    'plan:read', 'iteration:read', 'project:read', 'csenergy:read',
    'dashboard:read', 'token:read'
    // 无 write：研发改自己的任务状态走单独的 'task:write' 通道（后续用行级权限补齐）
  ],
  viewer: [
    'plan:read', 'iteration:read', 'project:read', 'csenergy:read',
    'budget:read', 'token:read', 'dashboard:read'
  ]
};

/* ---------- 打开与初始化 ---------- */

function open() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');   // 并发读不被写阻塞
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  seedPermissions();
  seedDefaults();
  return db;
}

function get() {
  return db || open();
}

/* 写入默认权限（已存在的角色不覆盖，允许后台改过之后不被重置） */
function seedPermissions() {
  const has = get().prepare('SELECT COUNT(*) AS n FROM permissions WHERE role = ?');
  const ins = get().prepare(
    'INSERT OR IGNORE INTO permissions(role, resource, allowed) VALUES(?, ?, 1)');
  Object.keys(DEFAULT_PERMISSIONS).forEach(role => {
    if (has.get(role).n > 0) return;
    DEFAULT_PERMISSIONS[role].forEach(r => ins.run(role, r));
  });
}

/* 首次启动时建一个默认管理员，口令打印在控制台，强制首次登录后修改 */
function seedDefaults() {
  const n = get().prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return null;

  const pwd = crypto.randomBytes(6).toString('base64url');   // 8 位随机口令
  const now = new Date().toISOString();
  get().prepare(
    'INSERT INTO users(id, name, password_hash, role, enabled, created_at, updated_at) VALUES(?,?,?,?,1,?,?)'
  ).run('admin', '管理员', hashPassword(pwd), 'admin', now, now);
  setMeta('created_at', now);
  initialAdmin = { id: 'admin', password: pwd };
  return initialAdmin;
}

/** 取首次建库时生成的默认管理员口令，取过就没了（避免口令反复出现在日志里） */
function takeInitialAdmin() {
  const r = initialAdmin;
  initialAdmin = null;
  return r;
}

/* ---------- 口令哈希（scrypt 加盐）---------- */

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

/** 校验口令。用 timingSafeEqual 防时序侧信道。 */
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
  return get().prepare(
    'SELECT id, name, role, dingtalk_id, enabled, created_at FROM users ORDER BY created_at'
  ).all();
}

function createUser({ id, name, password, role, dingtalkId }) {
  if (!id || !name) throw new Error('账号和姓名不能为空');
  if (findUser(id)) throw new Error('账号已存在：' + id);
  const now = new Date().toISOString();
  get().prepare(
    'INSERT INTO users(id, name, password_hash, role, dingtalk_id, enabled, created_at, updated_at) VALUES(?,?,?,?,?,1,?,?)'
  ).run(String(id), String(name), password ? hashPassword(password) : null,
        String(role || 'viewer'), dingtalkId || null, now, now);
  return findUser(id);
}

function setPassword(id, plain) {
  get().prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(plain), new Date().toISOString(), String(id));
}

function setRole(id, role) {
  get().prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
    .run(String(role), new Date().toISOString(), String(id));
}

/* ---------- 会话 ---------- */

const SESSION_DAYS = 30;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400000);
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
  hashPassword, verifyPassword,
  findUser, listUsers, createUser, setPassword, setRole, takeInitialAdmin,
  createSession, sessionUser, destroySession, purgeExpiredSessions,
  hasPermission, listPermissions, setPermission,
  logAudit, getAudit, auditCount,
  setMeta, getMeta,
  DEFAULT_PERMISSIONS
};
