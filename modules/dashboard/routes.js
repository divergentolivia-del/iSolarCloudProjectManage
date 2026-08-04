/* modules/dashboard/routes.js — 仪表盘模块服务端路由
   提供 /api/dashboard/summary 聚合 API。
   从各模块（iteration, project, budget, token）读取状态文件，
   计算并返回汇总指标供前端仪表盘渲染。
*/

'use strict';

const fs = require('fs');
const path = require('path');

/* 数据目录配置 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');

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
 * 安全读取 JSON 文件。文件不存在或解析失败时返回 null。
 */
function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * 获取当前季度对应的 Q 标签 (Q1-Q4)
 */
function getCurrentQuarter() {
  const month = new Date().getMonth(); // 0-11
  if (month < 3) return 'Q1';
  if (month < 6) return 'Q2';
  if (month < 9) return 'Q3';
  return 'Q4';
}

/**
 * 获取当前月份 YYYY-MM 格式
 */
function getCurrentMonth() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

/**
 * 从计划中获取团队当前季度的预算人数
 */
function getCurrentQuarterBudget(plan) {
  const q = getCurrentQuarter();
  const entry = (plan.quarterly || []).find(e => e.q === q);
  return entry ? (Number(entry.budget) || 0) : 0;
}

/**
 * 判断项目是否逾期（status 为 in-progress 且 endDate 已过）
 */
function isOverdue(project) {
  if (project.status !== 'in-progress') return false;
  if (!project.endDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  return project.endDate < today;
}

/**
 * 读取最近的归档记录（从 data/archive/ 目录）
 */
function getRecentArchives(limit) {
  const archiveDir = path.join(DATA_DIR, 'archive');
  try {
    if (!fs.existsSync(archiveDir)) return [];
    const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
    // 按文件名降序（自然排序）获取最新
    files.sort((a, b) => b.localeCompare(a));
    const archives = [];
    for (let i = 0; i < Math.min(limit, files.length); i++) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(archiveDir, files[i]), 'utf8'));
        archives.push({
          id: files[i].replace('.json', ''),
          name: data.name || data.meta?.name || files[i].replace('.json', ''),
          date: data.archivedAt || data.meta?.archivedAt || '',
          note: data.note || data.meta?.note || ''
        });
      } catch (e) { /* skip broken files */ }
    }
    return archives;
  } catch (e) {
    return [];
  }
}

/* ---------- 聚合计算 ---------- */

/**
 * 聚合各模块数据为仪表盘摘要
 */
function aggregateDashboard() {
  // 读取各模块状态
  const iterState = safeReadJson(path.join(DATA_DIR, 'iteration/state.json'));
  const projState = safeReadJson(path.join(DATA_DIR, 'project/state.json'));
  const budgetState = safeReadJson(path.join(DATA_DIR, 'budget/state.json'));
  const tokenState = safeReadJson(path.join(DATA_DIR, 'token/state.json'));

  // --- 迭代偏差 ---
  let iterResult = { iteration: { cycleName: '—', deviation: 0, workload: 0, capacity: 0 } };
  if (iterState) {
    try {
      // 加载配置到上下文（compute 依赖全局 TEAMS 等变量）
      const { compute } = require('../../calc');
      const computed = compute(iterState);
      const capacity = computed.totals ? computed.totals.capacity : 0;
      const workload = computed.totals ? computed.totals.workload : 0;
      const deviation = capacity ? (workload - capacity) / capacity : 0;
      const cycle = computed.cycle;
      iterResult = {
        cycleName: cycle ? (cycle.online || cycle.name || '—') : '—',
        deviation: deviation,
        days: computed.days || 0,
        workload: workload,
        capacity: capacity
      };
    } catch (e) {
      iterResult = { cycleName: '—', deviation: 0, days: 0, workload: 0, capacity: 0 };
    }
  } else {
    iterResult = { cycleName: '—', deviation: 0, days: 0, workload: 0, capacity: 0 };
  }

  // --- 项目进度 ---
  let projectResult = { total: 0, active: 0, overdue: 0 };
  if (projState && Array.isArray(projState.projects)) {
    const projects = projState.projects;
    projectResult = {
      total: projects.length,
      active: projects.filter(p => p.status === 'in-progress').length,
      overdue: projects.filter(p => isOverdue(p)).length
    };
  }

  // --- 预算执行率 ---
  let budgetResult = { rate: 0, alerts: 0 };
  if (budgetState) {
    const currentMonth = getCurrentMonth();
    const actuals = (budgetState.actuals || []).filter(a => a.month === currentMonth);
    const totalActual = actuals.reduce((s, a) => s + (Number(a.total) || 0), 0);
    const totalBudget = (budgetState.plans || []).reduce((s, p) => s + getCurrentQuarterBudget(p), 0);
    budgetResult = {
      rate: totalBudget ? totalActual / totalBudget : 0,
      alerts: (budgetState.alerts || []).length
    };
  }

  // --- Token消耗 ---
  let tokenResult = { monthlyTokens: 0, monthlyCost: 0, invocations: 0 };
  if (tokenState && tokenState.summary) {
    tokenResult = {
      monthlyTokens: Number(tokenState.summary.totalTokens) || 0,
      monthlyCost: Number(tokenState.summary.totalCost) || 0,
      invocations: Number(tokenState.summary.totalInvocations) || 0
    };
  }

  // --- 告警列表 (max 5) ---
  const alerts = [];

  // 项目逾期里程碑告警
  if (projState && Array.isArray(projState.projects)) {
    const today = new Date().toISOString().slice(0, 10);
    projState.projects.forEach(proj => {
      if (proj.status === 'in-progress' && Array.isArray(proj.milestones)) {
        proj.milestones.forEach(ms => {
          if (ms.status !== 'done' && ms.date && ms.date < today) {
            alerts.push({
              type: 'milestone-overdue',
              module: 'project',
              message: `${proj.name}-${ms.name} 里程碑逾期`,
              date: ms.date
            });
          }
        });
      }
    });
  }

  // 预算告警
  if (budgetState && Array.isArray(budgetState.alerts)) {
    budgetState.alerts.forEach(a => {
      alerts.push({
        type: 'budget-' + (a.type || 'alert'),
        module: 'budget',
        message: `${a.team} ${a.message || '预算异常'}`,
        date: a.month || ''
      });
    });
  }

  // Token 预算预警
  if (tokenState && tokenState.summary && tokenState.budgetLimit) {
    const cost = Number(tokenState.summary.totalCost) || 0;
    const limit = Number(tokenState.budgetLimit.monthly) || 0;
    const threshold = Number(tokenState.budgetLimit.alertThreshold) || 0.8;
    if (limit > 0 && cost >= limit * threshold) {
      alerts.push({
        type: 'token-warning',
        module: 'token',
        message: `Token预算已使用 ${(cost / limit * 100).toFixed(0)}%`,
        date: getCurrentMonth()
      });
    }
  }

  // 限制最多5条
  const alertsLimited = alerts.slice(0, 5);

  // --- 月度偏差摘要（按团队） ---
  let deviationByTeam = [];
  if (iterState) {
    try {
      const { compute } = require('../../calc');
      const computed = compute(iterState);
      if (computed.deviation) {
        deviationByTeam = computed.deviation
          .filter(d => d.capacity > 0)
          .map(d => ({
            team: d.team,
            dept: d.dept,
            ratio: d.ratio,
            verdict: d.verdict
          }));
      }
    } catch (e) { /* ignore */ }
  }

  // --- 最近归档 ---
  const recentArchives = getRecentArchives(3);

  return {
    iteration: iterResult,
    project: projectResult,
    budget: budgetResult,
    token: tokenResult,
    alerts: alertsLimited,
    alertsTotal: alerts.length,
    deviationByTeam: deviationByTeam,
    recentArchives: recentArchives,
    updatedAt: new Date().toLocaleString('zh-CN')
  };
}

/* ---------- 模块导出 ---------- */

module.exports = {
  id: 'dashboard',
  prefix: '/api/dashboard',

  /**
   * ensureData() — 仪表盘模块不需要独立数据目录
   */
  ensureData() {
    // Dashboard reads from other modules, no own data dir needed
  },

  /**
   * handle(req, res, parsedUrl) — 路由处理
   * 处理：
   *   GET /api/dashboard/summary — 聚合指标
   */
  handle(req, res, u) {
    const pathname = u.pathname || '';
    const sub = pathname.replace('/api/dashboard', '');

    // GET /api/dashboard/summary — 聚合各模块数据
    if ((sub === '/summary' || sub === '/summary/') && req.method === 'GET') {
      try {
        const data = aggregateDashboard();
        return sendJson(res, 200, data);
      } catch (e) {
        console.error('[dashboard] 聚合失败:', e.message);
        return sendJson(res, 200, {
          iteration: { cycleName: '—', deviation: 0, days: 0, workload: 0, capacity: 0 },
          project: { total: 0, active: 0, overdue: 0 },
          budget: { rate: 0, alerts: 0 },
          token: { monthlyTokens: 0, monthlyCost: 0, invocations: 0 },
          alerts: [],
          alertsTotal: 0,
          deviationByTeam: [],
          recentArchives: [],
          updatedAt: new Date().toLocaleString('zh-CN'),
          _error: '部分数据聚合失败'
        });
      }
    }

    sendJson(res, 404, { error: 'Not Found' });
  }
};
