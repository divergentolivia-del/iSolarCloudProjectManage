/* modules/token/routes.js — AI/Token 使用记录模块服务端路由
   提供 /api/token/state 只读 GET 端点。
   数据存储于 data/token/state.json（低优先级占位模块）。
*/

'use strict';

const fs = require('fs');
const path = require('path');

/* 数据目录配置 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');
const TOKEN_DIR = path.join(DATA_DIR, 'token');
const STATE_FILE = path.join(TOKEN_DIR, 'state.json');
const HISTORY_DIR = path.join(TOKEN_DIR, 'history');
const LOGS_DIR = path.join(TOKEN_DIR, 'logs');

/* ---------- 空状态模板 ---------- */
const EMPTY_STATE = {
  rev: 0,
  updatedAt: '',
  updatedBy: '',
  summary: {
    totalTokens: 0,
    totalCost: 0,
    totalInvocations: 0,
    period: {
      from: new Date().toISOString().slice(0, 8) + '01',
      to: new Date().toISOString().slice(0, 10)
    }
  },
  agents: [],
  dailyLogs: [],
  budgetLimit: {
    monthly: 500,
    alertThreshold: 0.8
  }
};

/* ---------- 工具函数 ---------- */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * 读取 Token 模块状态
 */
function readState() {
  if (!fs.existsSync(STATE_FILE)) return JSON.parse(JSON.stringify(EMPTY_STATE));
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[token] state.json 解析失败:', e.message);
    return JSON.parse(JSON.stringify(EMPTY_STATE));
  }
}

/* ---------- 模块导出 ---------- */

module.exports = {
  id: 'token',
  prefix: '/api/token',

  /**
   * ensureData() — 确保 Token 模块数据目录存在
   */
  ensureData() {
    ensureDir(TOKEN_DIR);
    ensureDir(HISTORY_DIR);
    ensureDir(LOGS_DIR);
    // 初始化空状态文件（如果不存在）
    if (!fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(JSON.stringify(EMPTY_STATE));
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, STATE_FILE);
    }
  },

  /**
   * handle(req, res, parsedUrl) — 路由处理
   * 处理：
   *   GET /api/token/state — 读取 Token 状态（只读）
   */
  handle(req, res, u) {
    const pathname = u.pathname || '';
    const sub = pathname.replace('/api/token', '');

    // GET /api/token/state — 读取当前 Token 状态
    if (sub === '/state' && req.method === 'GET') {
      return sendJson(res, 200, readState());
    }

    // 未匹配到任何路由
    sendJson(res, 404, { error: 'Not Found' });
  },

  /* 暴露 readState 供外部模块（如 dashboard）使用 */
  readState
};
