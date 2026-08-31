/* modules/csenergy/routes.js — 工商储项目管理模块服务端路由
   数据存储于 data/csenergy/state.json 和 data/csenergy/history/。
   与其他模块数据完全隔离，互不影响。

   路由：
     GET  /api/csenergy/state    — 读取完整状态
     POST /api/csenergy/state    — 提交状态变更（乐观锁）
     GET  /api/csenergy/summary  — 立项看板汇总指标
*/

'use strict';

const fs = require('fs');
const path = require('path');

/* 数据目录配置 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');
const CS_DIR = path.join(DATA_DIR, 'csenergy');
const STATE_FILE = path.join(CS_DIR, 'state.json');
const HISTORY_DIR = path.join(CS_DIR, 'history');

/* 枚举 */
const VALID_STATUSES = ['planned', 'in-progress', 'completed', 'suspended'];
const VALID_RISK_LEVELS = ['high', 'medium', 'low'];
const VALID_RISK_STATES = ['open', 'closed'];

/* ---------- 示例数据（首次启动时写入，便于直接看到完整 UI） ---------- */
const SEED_STATE = {
  rev: 1,
  updatedAt: '',
  updatedBy: 'system',
  year: new Date().getFullYear(),
  projects: [
    {
      id: 'cs-2026-001',
      code: 'CS-BR0-001',
      name: '工商储 100kWh 液冷一体机',
      series: '液冷储能',
      region: '华东',
      versionType: '平台版本',
      status: 'in-progress',
      progressRisk: 'medium',
      manager: '陈丹萍',
      planning: '计划内',
      milestones: [
        { name: 'BR0 立项', node: 'BR0', date: '2026-03-01', status: 'done', level: 1 },
        { name: 'BR1 方案', node: 'BR1', date: '2026-05-15', status: 'done', level: 1 },
        { name: 'TR3 转产', node: 'TR3', date: '2026-09-30', status: 'pending', level: 1 },
        { name: 'TR5 量产', node: 'TR5', date: '2026-12-20', status: 'pending', level: 1 }
      ],
      nodes: { BR0: '2026-03-01', BR1: '2026-05-15', BR2: '', BR3: '', BR4: '', TR1: '', TR2: '', TR3: '2026-09-30', TR4: '', TR5: '2026-12-20', TR6: '' }
    },
    {
      id: 'cs-2026-002',
      code: 'CS-BR0-002',
      name: '工商储 215kWh 风冷柜',
      series: '风冷储能',
      region: '华南',
      versionType: '业务版本',
      status: 'in-progress',
      progressRisk: 'high',
      manager: '陈丹萍',
      planning: '计划内',
      milestones: [
        { name: 'BR0 立项', node: 'BR0', date: '2026-02-10', status: 'done', level: 1 },
        { name: 'BR2 详设', node: 'BR2', date: '2026-06-30', status: 'pending', level: 1 },
        { name: 'TR4 试产', node: 'TR4', date: '2026-11-15', status: 'pending', level: 1 }
      ],
      nodes: { BR0: '2026-02-10', BR1: '2026-04-20', BR2: '2026-06-30', BR3: '', BR4: '', TR1: '', TR2: '', TR3: '', TR4: '2026-11-15', TR5: '', TR6: '' }
    },
    {
      id: 'cs-2026-003',
      code: 'CS-BR0-003',
      name: '工商储 PCS 一体化控制器',
      series: 'PCS',
      region: '海外',
      versionType: '平台版本',
      status: 'planned',
      progressRisk: 'low',
      manager: '李工',
      planning: '规划中',
      milestones: [
        { name: 'BR0 立项', node: 'BR0', date: '2026-08-01', status: 'pending', level: 1 }
      ],
      nodes: { BR0: '2026-08-01', BR1: '', BR2: '', BR3: '', BR4: '', TR1: '', TR2: '', TR3: '', TR4: '', TR5: '', TR6: '' }
    }
  ],
  risks: [
    {
      id: 'risk-001',
      star: true,
      projectId: 'cs-2026-002',
      projectName: '工商储 215kWh 风冷柜',
      desc: '电芯供应商交期延迟，影响 TR4 试产节点',
      impactType: '进度',
      level: 'high',
      state: 'open',
      resourceSupport: '采购部协调备选供应商',
      closeProgress: 40,
      planCloseDate: '2026-09-10',
      createdAt: '2026-08-20'
    },
    {
      id: 'risk-002',
      star: false,
      projectId: 'cs-2026-001',
      projectName: '工商储 100kWh 液冷一体机',
      desc: '液冷板密封工艺验证未通过，需重新打样',
      impactType: '质量',
      level: 'medium',
      state: 'open',
      resourceSupport: '结构团队支持',
      closeProgress: 65,
      planCloseDate: '2026-09-05',
      createdAt: '2026-08-18'
    }
  ],
  resources: {
    month: new Date().toISOString().slice(0, 7),
    dept: '研发中心',
    human: [
      { role: '系统SE', invest: 2.5, color: '#8b6cff' },
      { role: '电气', invest: 3.0, color: '#5277ff' },
      { role: '硬件', invest: 2.0, color: '#52c41a' },
      { role: '结构', invest: 1.5, color: '#f5a524' },
      { role: '软件', invest: 2.8, color: '#f071a8' },
      { role: '电芯', invest: 1.2, color: '#13c2c2' },
      { role: '平台部', invest: 0.8, color: '#597ef7' },
      { role: '测试', invest: 1.5, color: '#eb2f96' }
    ],
    material: []
  }
};

const EMPTY_STATE = {
  rev: 0, updatedAt: '', updatedBy: '',
  year: new Date().getFullYear(),
  projects: [], risks: [],
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

function readState() {
  if (!fs.existsSync(STATE_FILE)) return JSON.parse(JSON.stringify(EMPTY_STATE));
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[csenergy] state.json 解析失败:', e.message);
    const snap = latestSnapshot();
    if (snap) {
      console.error('[csenergy]   已回退到快照:', snap.name);
      return snap.data;
    }
    return JSON.parse(JSON.stringify(EMPTY_STATE));
  }
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
  ensureDir(CS_DIR);
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function saveHistory(s) {
  try {
    ensureDir(HISTORY_DIR);
    const name = 'csenergy-rev' + s.rev + '.json';
    fs.writeFileSync(path.join(HISTORY_DIR, name), JSON.stringify(s), 'utf8');
  } catch (e) { /* 归档失败不影响主流程 */ }
}

/* ---------- 数据校验 ---------- */
function validateState(next) {
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
      if (p.progressRisk && !VALID_RISK_LEVELS.includes(p.progressRisk)) {
        return `项目 "${p.id}" 进度风险无效: "${p.progressRisk}"`;
      }
    }
  }
  if (next.risks != null) {
    if (!Array.isArray(next.risks)) return '风险列表必须为数组';
    const rids = new Set();
    for (const r of next.risks) {
      if (!r.id || typeof r.id !== 'string') return '每个风险必须有有效的 id';
      if (rids.has(r.id)) return `风险 ID 重复: ${r.id}`;
      rids.add(r.id);
      if (r.level && !VALID_RISK_LEVELS.includes(r.level)) {
        return `风险 "${r.id}" 等级无效: "${r.level}"`;
      }
      if (r.state && !VALID_RISK_STATES.includes(r.state)) {
        return `风险 "${r.id}" 状态无效: "${r.state}"`;
      }
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

  // 已立项 = 有 BR0 节点日期的项目
  const approved = projects.filter(p => p.nodes && p.nodes.BR0).length;
  // 待立项 = planned 且无 BR0 日期
  const pending = projects.filter(p => p.status === 'planned' && !(p.nodes && p.nodes.BR0)).length;
  // 进行中
  const inProgress = projects.filter(p => p.status === 'in-progress').length;
  // 项目经理人数（去重）
  const managers = new Set(projects.filter(p => p.status === 'in-progress' && p.manager).map(p => p.manager));
  const managerCount = managers.size;

  // 风险等级统计
  const riskHigh = risks.filter(r => r.level === 'high' && r.state === 'open').length;
  const riskMedium = risks.filter(r => r.level === 'medium' && r.state === 'open').length;
  const riskLow = risks.filter(r => r.level === 'low' && r.state === 'open').length;
  const riskClosed = risks.filter(r => r.state === 'closed').length;
  const riskOpen = risks.filter(r => r.state === 'open').length;
  const riskTotal = risks.length;

  // 项目进度风险分布
  const progHigh = projects.filter(p => p.progressRisk === 'high' && p.status === 'in-progress').length;
  const progMedium = projects.filter(p => p.progressRisk === 'medium' && p.status === 'in-progress').length;
  const progLow = projects.filter(p => p.progressRisk === 'low' && p.status === 'in-progress').length;

  // 闭环率
  const closeRate = riskTotal > 0 ? Math.round((riskClosed / riskTotal) * 100) : 0;

  // 超时未闭环风险（计划闭环日期已过但仍 open）
  const overdueRisks = risks
    .filter(r => r.state === 'open' && r.planCloseDate && r.planCloseDate < today)
    .map(r => ({ id: r.id, desc: r.desc, projectName: r.projectName, planCloseDate: r.planCloseDate, level: r.level }))
    .sort((a, b) => (a.planCloseDate || '').localeCompare(b.planCloseDate || ''));

  // 近一周需闭环风险
  const weekLater = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const rankOrder = { high: 0, medium: 1, low: 2 };
  const upcomingRisks = risks
    .filter(r => r.state === 'open' && r.planCloseDate && r.planCloseDate >= today && r.planCloseDate <= weekLater)
    .map(r => ({ id: r.id, desc: r.desc, projectName: r.projectName, planCloseDate: r.planCloseDate, level: r.level }))
    .sort((a, b) => (rankOrder[a.level] ?? 3) - (rankOrder[b.level] ?? 3));

  // 里程碑统计（按节点聚合当月计划数）
  const nodeKeys = ['BR0', 'BR1', 'BR2', 'BR3', 'BR4', 'TR1', 'TR2', 'TR3', 'TR4', 'TR5', 'TR6'];
  const milestoneStats = nodeKeys.map(node => {
    let count = 0;
    projects.forEach(p => { if (p.nodes && p.nodes[node]) count++; });
    return { node, count };
  });

  // 进行中项目的里程碑（甘特图数据）
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
    ensureDir(CS_DIR);
    ensureDir(HISTORY_DIR);
    // 首次启动写入示例数据，方便直接看到完整界面
    if (!fs.existsSync(STATE_FILE)) {
      const seed = JSON.parse(JSON.stringify(SEED_STATE));
      seed.updatedAt = new Date().toLocaleString('zh-CN');
      writeState(seed);
      saveHistory(seed);
    }
  },

  handle(req, res, u) {
    const pathname = u.pathname || '';
    const sub = pathname.replace('/api/csenergy', '');

    // GET /api/csenergy/state
    if (sub === '/state' && req.method === 'GET') {
      return sendJson(res, 200, readState());
    }

    // GET /api/csenergy/summary
    if (sub === '/summary' && req.method === 'GET') {
      return sendJson(res, 200, computeSummary(readState()));
    }

    // POST /api/csenergy/state
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

        next.rev = Math.max(curRev, isFinite(baseRev) ? baseRev : 0) + 1;
        next.updatedAt = new Date().toLocaleString('zh-CN');
        next.updatedBy = String(incoming.by || '未署名').slice(0, 40);

        try { writeState(next); }
        catch (e) { return sendJson(res, 500, { error: '写入失败: ' + e.message }); }

        saveHistory(next);

        if (typeof global._broadcast === 'function') {
          global._broadcast(next.rev, next.updatedBy);
        }

        sendJson(res, 200, { ok: true, rev: next.rev, updatedAt: next.updatedAt });
      });
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  },

  readState
};
