/* audit.js — 操作审计日志
   底层已切到 SQLite（见 db.js），日志不再有 200 条上限、不再每次全量重写文件。

   ★ 对调用方零改动：log() / getRecent() 签名与返回结构保持原样，
     server.js 等处的现存调用不需要动。

   旧的 data/audit-log.json 会在首次启动时自动迁进库（一次性），
    之后该文件只作为历史残档保留，不再被写入。 */

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LEGACY_FILE = path.join(DATA_DIR, 'audit-log.json');

/**
 * 写入一条审计日志
 * @param {{ user: string, module: string, action: string, details?: string, timestamp?: string,
 *           user_id?: string, ai_triggered?: boolean, ai_adopted?: boolean }} entry
 */
function log(entry) {
  try {
    db.logAudit(entry);
  } catch (e) {
    /* 审计失败不能拖垮业务请求 */
    console.error('[audit] 写入失败：', e.message);
  }
}

/**
 * 获取最近的审计日志
 * @param {number} [limit=50] 返回条数
 * @param {{user?:string, module?:string, since?:string}} [filter] 可选过滤条件
 * @returns {Array}
 */
function getRecent(limit, filter) {
  try {
    return db.getAudit(limit, filter).map(r => ({
      user: r.user_name || '',
      user_id: r.user_id || '',
      module: r.module || '',
      action: r.action || '',
      details: r.details || '',
      timestamp: r.ts,
      ai_triggered: !!r.ai_triggered,
      ai_adopted: r.ai_adopted == null ? null : !!r.ai_adopted
    }));
  } catch (e) { return []; }
}

/** 日志总条数（用于验证迁移结果） */
function count() {
  try { return db.auditCount(); } catch (e) { return 0; }
}

/**
 * 把旧的 audit-log.json 迁进 SQLite。幂等：靠 meta 里的标记，只跑一次。
 * 旧文件里 timestamp 是 'zh-CN' 的本地字符串，原样保留不转换，避免时区改写。
 * @returns {{migrated:number, skipped?:string}}
 */
function migrateLegacy() {
  if (db.getMeta('audit_migrated')) return { migrated: 0, skipped: '已迁移过' };
  if (!fs.existsSync(LEGACY_FILE)) {
    db.setMeta('audit_migrated', new Date().toISOString());
    return { migrated: 0, skipped: '无旧文件' };
  }

  let old = [];
  try { old = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8')); } catch (e) { old = []; }
  if (!Array.isArray(old)) old = [];

  /* 旧文件是「新在前」，而 id 是自增的，所以必须倒着写：
     最旧的一条先进、id 最小，最新的一条最后进、id 最大，
     这样「ORDER BY id DESC」拿到的最新记录才和旧文件的第一条一致。 */
  let n = 0;
  old.slice().reverse().forEach(e => {
    if (!e || typeof e !== 'object') return;
    db.logAudit(e);
    n++;
  });
  db.setMeta('audit_migrated', new Date().toISOString());

  /* 留个旁证文件，万一将来要核对迁移是否完整 */
  try {
    fs.renameSync(LEGACY_FILE, LEGACY_FILE + '.migrated');
  } catch (e) { /* 改不了名也无所谓，不再写它了 */ }

  return { migrated: n };
}

module.exports = { log, getRecent, count, migrateLegacy };
