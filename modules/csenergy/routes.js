/* modules/csenergy/routes.js — 全年度项目管理看板 · 服务端路由
   ★ 数据源与现有 project 模块完全统一：共用 data/project/state.json
     - 在任意模块录入的项目数据双向可见，无需迁移
     - 本模块额外扩展 risks[] / resources{} 两个顶层字段
   路由：
     GET  /api/csenergy/state    — 读取完整状态（含 projects/risks/resources）
     POST /api/csenergy/state    — 提交状态变更（乐观锁，与 project 共享 rev）
     GET  /api/csenergy/summary  — 立项看板汇总指标
*/

'use strict';

const fs = require('fs');
const path = require('path');

/* ★ 复用 project 模块的数据目录，实现数据统一 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');
const PROJ_DIR = path.join(DATA_DIR, 'project');
const STATE_FILE = path.join(PROJ_DIR, 'state.json');
const HISTORY_DIR = path.join(PROJ_DIR, 'history');

/* 枚举（与 project 模块保持一致 + 风险扩展） */
const VALID_STATUSES = ['planned', 'in-progress', 'completed', 'suspended'];
const VALID_RELEASE_LAYERS = ['platform', 'business', 'shared'];
const VALID_RELEASE_RISKS = ['high', 'medium', 'low'];
const VALID_RISK_LEVELS = ['high', 'medium', 'low'];
const VALID_RISK_STATES = ['open', 'closed'];

/* 空状态模板（与 project 兼容，追加 risks/resources） */
const EMPTY_STATE = {
  rev: 0,
  updatedAt: '',
  updatedBy: '',
  year: new Date().getFullYear(),
  projects: [],
  risks: [],
  resources: { month: new Date().toISOString().slice(0, 7), dept: '研发中心', human: [], material: [] }
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

function isValidProjectDateText(value) {
  if (!value) return true;
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(value.trim());
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3] || 1);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/**
 * 读取统一状态。确保 risks/resources 字段存在（老 project 数据没有这两个字段）。
 */
function readState() {
  let state;
  if (!fs.existsSync(STATE_FILE)) {
    state = JSON.parse(JSON.stringify(EMPTY_STATE));
  } else {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      console.error('[csenergy] state.json 解析失败:', e.message);
      const snap = latestSnapshot();
      state = snap ? snap.data : JSON.parse(JSON.stringify(EMPTY_STATE));
    }
  }
  // 补全扩展字段（兼容仅有 projects 的旧数据）
  if (!Array.isArray(state.projects)) state.projects = [];
  if (!Array.isArray(state.risks)) state.risks = [];
  if (!state.resources || typeof state.resources !== 'object') {
    state.resources = { month: new Date().toISOString().slice(0, 7), dept: '研发中心', human: [], material: [] };
  }
  if (!Array.isArray(state.resources.human)) state.resources.human = [];
  if (!Array.isArray(state.resources.material)) state.resources.material = [];
  return state;
}

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

function writeState(s) {
  ensureDir(PROJ_DIR);
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/* 历史快照沿用 project- 前缀，与现有模块共用 history 目录 */
function saveHistory(s) {
  try {
    ensureDir(HISTORY_DIR);
    const name = 'project-rev' + s.rev + '.json';
    fs.writeFileSync(path.join(HISTORY_DIR, name), JSON.stringify(s), 'utf8');
  } catch (e) { /* 归档失败不影响主流程 */ }
}

/* ---------- 数据校验（合并 project 项目规则 + risk/resource 规则） ---------- */
function validateState(next) {
  // 项目校验（与 project 模块一致）
  if (next.projects != null) {
    if (!Array.isArray(next.projects)) return '项目列表必须为数组';
    const ids = new Set();
    for (const p of next.projects) {
      if (!p.id || typeof p.id !== 'string') return '每个项目必须有有效的 id';
      if (ids.has(p.id)) return `项目 ID 重复: ${p.id}`;
      ids.add(p.id);
      if (p.status && !VALID_STATUSES.includes(p.status)) {
        return `项目 "${p.id}" 状态无效: "${p.status}"`;
      }
      if (p.startDate && p.endDate && p.startDate > p.endDate) {
        return `项目 "${p.id}" 开始日期不能晚于结束日期`;
      }
      if (p.releaseLayer && !VALID_RELEASE_LAYERS.includes(p.releaseLayer)) {
        return `项目 "${p.id}" releaseLayer 无效: "${p.releaseLayer}"`;
      }
      if (p.releaseRisk && !VALID_RELEASE_RISKS.includes(p.releaseRisk)) {
        return `项目 "${p.id}" releaseRisk 无效: "${p.releaseRisk}"`;
      }
      if (p.releaseDate && !isValidProjectDateText(p.releaseDate)) {
        return `项目 "${p.id}" releaseDate 必须为 YYYY-MM 或 YYYY-MM-DD`;
      }
      if (p.resourceSummary) {
        const rs = p.resourceSummary;
        const numFields = ['totalManMonths', 'usedManMonths', 'totalCost', 'usedCost', 'outsourceCount', 'durationMonths'];
        for (const f of numFields) {
          if (rs[f] != null && (typeof rs[f] !== 'number' || rs[f] < 0)) {
            return `项目 "${p.id}" ${f} 必须为非负数`;
          }
        }
        if (rs.teams != null && (typeof rs.teams !== 'object' || Array.isArray(rs.teams))) {
          return `项目 "${p.id}" teams 必须为对象`;
        }
      }
    }
  }
  // 风险校验
  if (next.risks != null) {
    if (!Array.isArray(next.risks)) return '风险列表必须为数组';
    const rids = new Set();
    for (const r of next.risks) {
      if (!r.id || typeof r.id !== 'string') return '每个风险必须有有效的 id';
      if (rids.has(r.id)) return `风险 ID 重复: ${r.id}`;
      rids.add(r.id);
      if (r.level && !VALID_RISK_LEVELS.includes(r.level)) return `风险 "${r.id}" 等级无效: "${r.level}"`;
      if (r.state && !VALID_RISK_STATES.includes(r.state)) return `风险 "${r.id}" 状态无效: "${r.state}"`;
      if (r.closeProgress != null && (typeof r.closeProgress !== 'number' || r.closeProgress < 0 || r.closeProgress > 100)) {
        return `风险 "${r.id}" 闭环进度必须为 0-100`;
      }
    }
  }
  return null;
}

/* ---------- 汇总计算（立项看板指标） ---------- */
function computeSummary(state) {
  const projects = state.projects || [];
  const risks = state.risks || [];
  const today = new Date().toISOString().slice(0, 10);

  const approved = projects.filter(p => (p.nodes && p.nodes.BR0) || (p.milestones || []).some(m => /BR0|立项/.test(m.name || ''))).length;
  const pending = projects.filter(p => p.status === 'planned').length;
  const inProgress = projects.filter(p => p.status === 'in-progress').length;
  const managers = new Set(projects.filter(p => p.status === 'in-progress' && (p.manager || p.owner)).map(p => p.manager || p.owner));
  const managerCount = managers.size;

  const riskHigh = risks.filter(r => r.level === 'high' && r.state === 'open').length;
  const riskMedium = risks.filter(r => r.level === 'medium' && r.state === 'open').length;
  const riskLow = risks.filter(r => r.level === 'low' && r.state === 'open').length;
  const riskClosed = risks.filter(r => r.state === 'closed').length;
  const riskOpen = risks.filter(r => r.state === 'open').length;
  const riskTotal = risks.length;

  const progHigh = projects.filter(p => (p.progressRisk === 'high' || p.releaseRisk === 'high') && p.status === 'in-progress').length;
  const progMedium = projects.filter(p => (p.progressRisk === 'medium' || p.releaseRisk === 'medium') && p.status === 'in-progress').length;
  const progLow = projects.filter(p => p.status === 'in-progress' && p.progressRisk !== 'high' && p.progressRisk !== 'medium' && p.releaseRisk !== 'high' && p.releaseRisk !== 'medium').length;

  const closeRate = riskTotal > 0 ? Math.round((riskClosed / riskTotal) * 100) : 0;

  const overdueRisks = risks
    .filter(r => r.state === 'open' && r.planCloseDate && r.planCloseDate < today)
    .map(r => ({ id: r.id, desc: r.desc, projectName: r.projectName, planCloseDate: r.planCloseDate, level: r.level }))
    .sort((a, b) => (a.planCloseDate || '').localeCompare(b.planCloseDate || ''));

  const weekLater = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const rankOrder = { high: 0, medium: 1, low: 2 };
  const upcomingRisks = risks
    .filter(r => r.state === 'open' && r.planCloseDate && r.planCloseDate >= today && r.planCloseDate <= weekLater)
    .map(r => ({ id: r.id, desc: r.desc, projectName: r.projectName, planCloseDate: r.planCloseDate, level: r.level }))
    .sort((a, b) => (rankOrder[a.level] ?? 3) - (rankOrder[b.level] ?? 3));

  const nodeKeys = ['BR0', 'BR1', 'BR2', 'BR3', 'BR4', 'TR1', 'TR2', 'TR3', 'TR4', 'TR5', 'TR6'];
  const milestoneStats = nodeKeys.map(node => {
    let count = 0;
    projects.forEach(p => {
      if (p.nodes && p.nodes[node]) count++;
      else if ((p.milestones || []).some(m => (m.node === node) || (m.name || '').includes(node))) count++;
    });
    return { node, count };
  });

  const ganttProjects = projects
    .filter(p => p.status === 'in-progress')
    .map(p => ({ id: p.id, name: p.name, milestones: p.milestones || [] }));

  return {
    metrics: { approved, pending, inProgress, managerCount, humanProjects: inProgress, efficiency: managerCount > 0 ? +(inProgress / managerCount).toFixed(1) : 0 },
    progressRisk: { high: progHigh, medium: progMedium, low: progLow },
    riskClosure: { closeRate, closed: riskClosed, open: riskOpen, total: riskTotal },
    riskStats: { high: riskHigh, medium: riskMedium, low: riskLow, closed: riskClosed, open: riskOpen, total: riskTotal },
    milestoneStats,
    ganttProjects,
    overdueRisks,
    upcomingRisks,
    year: state.year
  };
}

/* ---------- 模块导出 ---------- */
module.exports = {
  id: 'csenergy',
  prefix: '/api/csenergy',

  ensureData() {
    ensureDir(PROJ_DIR);
    ensureDir(HISTORY_DIR);
    // 不覆盖现有 project 数据；仅在完全无数据时创建空态
    if (!fs.existsSync(STATE_FILE)) {
      writeState(JSON.parse(JSON.stringify(EMPTY_STATE)));
    }
  },

  handle(req, res, u) {
    const pathname = u.pathname || '';
    const sub = pathname.replace('/api/csenergy', '');

    if (sub === '/state' && req.method === 'GET') {
      return sendJson(res, 200, readState());
    }

    if (sub === '/summary' && req.method === 'GET') {
      return sendJson(res, 200, computeSummary(readState()));
    }

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

        if (isFinite(baseRev) && baseRev < curRev) {
          return sendJson(res, 409, { error: '数据已被他人更新', currentRev: cur.rev, state: cur });
        }

        const next = incoming.state || {};
        const err = validateState(next);
        if (err) return sendJson(res, 400, { error: err });

        // 合并：保证不丢字段（若某次提交只带部分字段，用现有值兜底）
        const merged = {
          ...cur,
          ...next,
          projects: next.projects != null ? next.projects : cur.projects,
          risks: next.risks != null ? next.risks : cur.risks,
          resources: next.resources != null ? next.resources : cur.resources
        };

        merged.rev = Math.max(curRev, isFinite(baseRev) ? baseRev : 0) + 1;
        merged.updatedAt = new Date().toLocaleString('zh-CN');
        merged.updatedBy = String(incoming.by || '未署名').slice(0, 40);
        if (!merged.year) merged.year = new Date().getFullYear();

        try { writeState(merged); }
        catch (e) { return sendJson(res, 500, { error: '写入失败: ' + e.message }); }

        saveHistory(merged);

        if (typeof global._broadcast === 'function') {
          global._broadcast(merged.rev, merged.updatedBy);
        }

        sendJson(res, 200, { ok: true, rev: merged.rev, updatedAt: merged.updatedAt });
      });
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  },

  readState
};
