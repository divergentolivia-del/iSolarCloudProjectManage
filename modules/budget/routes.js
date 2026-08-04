/* modules/budget/routes.js — 人力预算管理模块服务端路由
   处理 /api/budget/state 的 GET/POST 请求。
   数据存储于 data/budget/state.json 和 data/budget/history/。
   自动生成预算告警（实际超计划 >10%）。
*/

'use strict';

const fs = require('fs');
const path = require('path');

/* 数据目录配置 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');
const BUDGET_DIR = path.join(DATA_DIR, 'budget');
const STATE_FILE = path.join(BUDGET_DIR, 'state.json');
const HISTORY_DIR = path.join(BUDGET_DIR, 'history');

/* 预算告警阈值 */
const ALERT_THRESHOLD = 0.10; // 超 10% 触发告警

/* ---------- 空状态模板 ---------- */
const EMPTY_STATE = {
  rev: 0,
  updatedAt: '',
  updatedBy: '',
  year: new Date().getFullYear(),
  plans: [],
  actuals: [],
  alerts: []
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
 * 获取 TEAMS 配置（从全局变量，由 server.js 在启动时加载）
 */
function getTeamKeys() {
  if (typeof global.TEAMS !== 'undefined' && Array.isArray(global.TEAMS)) {
    return global.TEAMS.map(t => t.key);
  }
  // 回退：尝试从 config.js 加载
  try {
    const configSource = fs.readFileSync(path.join(__dirname, '../../config.js'), 'utf8');
    const fn = new Function(configSource + '\nreturn TEAMS;');
    return fn().map(t => t.key);
  } catch (e) {
    return [];
  }
}

/**
 * 读取预算模块状态
 */
function readState() {
  if (!fs.existsSync(STATE_FILE)) return JSON.parse(JSON.stringify(EMPTY_STATE));
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[budget] state.json 解析失败:', e.message);
    const snap = latestSnapshot();
    if (snap) {
      console.error('[budget]   已回退到快照:', snap.name);
      return snap.data;
    }
    console.error('[budget]   无可用快照，返回空态');
    return JSON.parse(JSON.stringify(EMPTY_STATE));
  }
}

/**
 * 取 history 中 rev 最大的快照
 */
function latestSnapshot() {
  try {
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
    const sorted = files.map(f => ({
      name: f, rev: Number((/-rev(\d+)\.json$/.exec(f) || [])[1] || 0)
    })).sort((a, b) => b.rev - a.rev);
    for (const s of sorted) {
      try {
        return { name: s.name, data: JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, s.name), 'utf8')) };
      } catch (e) { /* skip broken */ }
    }
  } catch (e) { }
  return null;
}

/**
 * 原子写入状态文件
 */
function writeState(s) {
  ensureDir(BUDGET_DIR);
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * 保存历史快照
 */
function saveHistory(s) {
  try {
    ensureDir(HISTORY_DIR);
    const name = 'budget-rev' + s.rev + '.json';
    fs.writeFileSync(path.join(HISTORY_DIR, name), JSON.stringify(s), 'utf8');
  } catch (e) { /* 归档失败不影响主流程 */ }
}

/**
 * 获取当前季度标签
 */
function getCurrentQuarter() {
  const month = new Date().getMonth();
  if (month < 3) return 'Q1';
  if (month < 6) return 'Q2';
  if (month < 9) return 'Q3';
  return 'Q4';
}

/**
 * 验证预算数据
 * @returns {string|null} 错误消息或 null 表示有效
 */
function validateBudgetState(state) {
  const teamKeys = getTeamKeys();

  // 验证计划中的团队名
  if (Array.isArray(state.plans)) {
    for (const plan of state.plans) {
      if (teamKeys.length > 0 && !teamKeys.includes(plan.team)) {
        return `团队 "${plan.team}" 不在配置的 TEAMS 列表中`;
      }
      // 验证 quarterly 有 Q1-Q4
      if (!Array.isArray(plan.quarterly) || plan.quarterly.length !== 4) {
        return `团队 "${plan.team}" 的季度计划必须包含 Q1-Q4 共4项`;
      }
      const qs = plan.quarterly.map(q => q.q).sort();
      if (qs.join(',') !== 'Q1,Q2,Q3,Q4') {
        return `团队 "${plan.team}" 的季度计划必须包含 Q1, Q2, Q3, Q4`;
      }
    }
  }

  // 验证实际数据中的团队名
  if (Array.isArray(state.actuals)) {
    for (const actual of state.actuals) {
      if (teamKeys.length > 0 && !teamKeys.includes(actual.team)) {
        return `实际数据中团队 "${actual.team}" 不在配置的 TEAMS 列表中`;
      }
    }
  }

  return null;
}

/**
 * 自动生成预算告警
 * 当实际人数超过计划超过阈值 (10%) 时生成告警
 */
function generateAlerts(state) {
  const alerts = [];
  const currentQ = getCurrentQuarter();

  if (!Array.isArray(state.plans) || !Array.isArray(state.actuals)) return alerts;

  // 按团队+月份聚合实际数据
  const actualsByTeamMonth = {};
  state.actuals.forEach(a => {
    const key = a.team + '|' + a.month;
    actualsByTeamMonth[key] = a;
  });

  // 对每个团队，检查当前季度的预算 vs 实际
  state.plans.forEach(plan => {
    const qPlan = (plan.quarterly || []).find(q => q.q === currentQ);
    if (!qPlan) return;
    const planned = Number(qPlan.budget) || 0;
    if (planned === 0) return;

    // 检查该团队各月的实际数据
    state.actuals
      .filter(a => a.team === plan.team)
      .forEach(actual => {
        const totalActual = Number(actual.total) || 0;
        if (totalActual > planned * (1 + ALERT_THRESHOLD)) {
          const deviation = (totalActual - planned) / planned;
          alerts.push({
            team: plan.team,
            month: actual.month,
            type: 'over-budget',
            threshold: ALERT_THRESHOLD,
            actual: Math.round(deviation * 100) / 100,
            message: `实际人数超预算 ${(deviation * 100).toFixed(0)}%`
          });
        }
      });
  });

  return alerts;
}

/* ---------- 模块导出 ---------- */

module.exports = {
  id: 'budget',
  prefix: '/api/budget',

  /**
   * ensureData() — 确保预算模块数据目录存在
   */
  ensureData() {
    ensureDir(BUDGET_DIR);
    ensureDir(HISTORY_DIR);
    // 初始化空状态文件（如果不存在）
    if (!fs.existsSync(STATE_FILE)) {
      writeState(JSON.parse(JSON.stringify(EMPTY_STATE)));
    }
  },

  /**
   * handle(req, res, parsedUrl) — 路由处理
   * 处理：
   *   GET  /api/budget/state — 读取预算状态
   *   POST /api/budget/state — 更新预算状态（乐观锁）
   */
  handle(req, res, u) {
    const pathname = u.pathname || '';
    const sub = pathname.replace('/api/budget', '');

    // GET /api/budget/state — 读取当前预算状态
    if (sub === '/state' && req.method === 'GET') {
      return sendJson(res, 200, readState());
    }

    // POST /api/budget/state — 提交预算状态变更（乐观锁）
    if (sub === '/state' && req.method === 'POST') {
      let body = '';
      req.on('data', c => {
        body += c;
        if (body.length > 64 * 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        let incoming;
        try { incoming = JSON.parse(body); }
        catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }

        const cur = readState();
        const baseRev = Number(incoming.baseRev);
        const curRev = Number(cur.rev || 0);

        // 乐观锁检查
        if (isFinite(baseRev) && baseRev < curRev) {
          return sendJson(res, 409, {
            error: '数据已被他人更新', currentRev: cur.rev, state: cur
          });
        }

        const next = incoming.state || {};

        // 验证预算数据
        const err = validateBudgetState(next);
        if (err) {
          return sendJson(res, 400, { error: err });
        }

        // 自动生成告警
        next.alerts = generateAlerts(next);

        next.rev = Math.max(curRev, isFinite(baseRev) ? baseRev : 0) + 1;
        next.updatedAt = new Date().toLocaleString('zh-CN');
        next.updatedBy = String(incoming.by || '未署名').slice(0, 40);

        try { writeState(next); }
        catch (e) { return sendJson(res, 500, { error: '写入失败: ' + e.message }); }

        saveHistory(next);

        // SSE 广播
        if (typeof global._broadcast === 'function') {
          global._broadcast(next.rev, next.updatedBy);
        }

        sendJson(res, 200, { ok: true, rev: next.rev, updatedAt: next.updatedAt });
      });
      return;
    }

    // 未匹配到任何路由
    sendJson(res, 404, { error: 'Not Found' });
  },

  /* 暴露 readState 供外部模块（如 dashboard）使用 */
  readState
};
