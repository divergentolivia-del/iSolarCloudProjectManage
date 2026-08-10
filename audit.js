/* audit.js — 操作审计日志
   记录平台所有写操作（模块数据提交、配置变更等），
   按时间倒序存储，最多保留 200 条。 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'audit-log.json');
const MAX_ENTRIES = 200;

/**
 * 写入一条审计日志
 * @param {{ user: string, module: string, action: string, details?: string, timestamp?: string }} entry
 */
function log(entry) {
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) { /* 文件不存在或解析失败 */ }
  logs.unshift({
    ...entry,
    timestamp: entry.timestamp || new Date().toLocaleString('zh-CN')
  });
  if (logs.length > MAX_ENTRIES) logs = logs.slice(0, MAX_ENTRIES);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf8');
}

/**
 * 获取最近的审计日志
 * @param {number} [limit=50] 返回条数
 * @returns {Array}
 */
function getRecent(limit) {
  try {
    const logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    return logs.slice(0, limit || 50);
  } catch (e) { return []; }
}

module.exports = { log, getRecent };
