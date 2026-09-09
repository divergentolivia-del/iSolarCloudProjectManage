/* modules/plan/routes.js — 项目计划模块 · 服务端路由
   数据完全独立：data/plan/state.json（不触碰 TB 工作台真实数据）
   可选项：与全年度项目（csenergy/project）通过 projectId 弱关联，仅用于展示跳转
   路由：
     GET  /api/plan/state    — 读取完整状态（plans[]）
     POST /api/plan/state    — 提交状态变更（乐观锁）
     GET  /api/plan/summary  — 各计划的执行汇总（WBS/里程碑/资源/风险）
*/

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');
const PLAN_DIR = path.join(DATA_DIR, 'plan');
const STATE_FILE = path.join(PLAN_DIR, 'state.json');
const HISTORY_DIR = path.join(PLAN_DIR, 'history');

/* 枚举 */
const VALID_PLAN_STATUS = ['draft', 'active', 'completed', 'archived'];
const VALID_TASK_STATUS = ['not-started', 'in-progress', 'completed', 'blocked'];
const VALID_TASK_PRIORITY = ['high', 'medium', 'low'];
const VALID_MILESTONE_STATUS = ['pending', 'in-progress', 'done'];
const VALID_RES_KIND = ['team', 'person'];
/* 二阶段板块枚举 */
const VALID_ISSUE_STATUS = ['pending', 'processing', 'resolved', 'closed'];
const VALID_RISK_TYPE = ['tech', 'market', 'quality', 'schedule', 'resource', 'other'];
const VALID_RISK_STATUS = ['occurring', 'watching', 'mitigated', 'closed'];
const VALID_REF_STAGE = ['TR2', 'TR3', 'TR4', 'TR5', 'other'];
const VALID_REF_DOC_STATUS = ['pending', 'submitted', 'reviewing', 'passed', 'na'];

/* 空状态模板 */
const EMPTY_STATE = {
  rev: 0,
  updatedAt: '',
  updatedBy: '',
  plans: []
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

function isValidDate(value) {
  if (!value) return true;
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(value.trim())) return false;
  const d = new Date(value.trim());
  return !isNaN(d.getTime());
}

function readState() {
  let state;
  if (!fs.existsSync(STATE_FILE)) {
    state = JSON.parse(JSON.stringify(EMPTY_STATE));
  } else {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      console.error('[plan] state.json 解析失败:', e.message);
      const snap = latestSnapshot();
      state = snap ? snap.data : JSON.parse(JSON.stringify(EMPTY_STATE));
    }
  }
  if (!Array.isArray(state.plans)) state.plans = [];
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
  ensureDir(PLAN_DIR);
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function saveHistory(s) {
  try {
    ensureDir(HISTORY_DIR);
    const name = 'plan-rev' + s.rev + '.json';
    fs.writeFileSync(path.join(HISTORY_DIR, name), JSON.stringify(s), 'utf8');
  } catch (e) { /* 归档失败不影响主流程 */ }
}

/* ---------- 数据校验 ---------- */
function validateState(next) {
  if (next.plans != null) {
    if (!Array.isArray(next.plans)) return '计划列表必须为数组';
    const ids = new Set();
    for (const p of next.plans) {
      if (!p.id || typeof p.id !== 'string') return '每个计划必须有有效的 id';
      if (ids.has(p.id)) return `计划 ID 重复: ${p.id}`;
      ids.add(p.id);
      if (p.status && !VALID_PLAN_STATUS.includes(p.status)) return `计划 "${p.id}" 状态无效: "${p.status}"`;
      if (p.startDate && p.endDate && p.startDate > p.endDate) return `计划 "${p.id}" 开始日期不能晚于结束日期`;

      // 任务校验
      if (p.tasks != null) {
        if (!Array.isArray(p.tasks)) return `计划 "${p.id}" tasks 必须为数组`;
        const tids = new Set();
        for (const t of p.tasks) {
          if (!t.id || typeof t.id !== 'string') return `计划 "${p.id}" 每个任务必须有 id`;
          if (tids.has(t.id)) return `计划 "${p.id}" 任务 ID 重复: ${t.id}`;
          tids.add(t.id);
          if (t.status && !VALID_TASK_STATUS.includes(t.status)) return `任务 "${t.id}" 状态无效: "${t.status}"`;
          if (t.priority && !VALID_TASK_PRIORITY.includes(t.priority)) return `任务 "${t.id}" 优先级无效: "${t.priority}"`;
          if (t.progress != null && (typeof t.progress !== 'number' || t.progress < 0 || t.progress > 100)) return `任务 "${t.id}" 进度必须为 0-100`;
          if (t.plannedHours != null && (typeof t.plannedHours !== 'number' || t.plannedHours < 0)) return `任务 "${t.id}" 计划工时必须为非负数`;
          if (t.startDate && !isValidDate(t.startDate)) return `任务 "${t.id}" startDate 必须为 YYYY-MM-DD`;
          if (t.endDate && !isValidDate(t.endDate)) return `任务 "${t.id}" endDate 必须为 YYYY-MM-DD`;
          if (t.startDate && t.endDate && t.startDate > t.endDate) return `任务 "${t.id}" 开始日期不能晚于结束日期`;
        }
      }

      // 里程碑校验
      if (p.milestones != null) {
        if (!Array.isArray(p.milestones)) return `计划 "${p.id}" milestones 必须为数组`;
        for (const m of p.milestones) {
          if (!m.id || typeof m.id !== 'string') return `计划 "${p.id}" 里程碑必须有 id`;
          if (m.status && !VALID_MILESTONE_STATUS.includes(m.status)) return `里程碑 "${m.id}" 状态无效: "${m.status}"`;
          if (m.date && !isValidDate(m.date)) return `里程碑 "${m.id}" 日期必须为 YYYY-MM-DD`;
        }
      }

      // 资源校验
      if (p.resources != null) {
        if (!Array.isArray(p.resources)) return `计划 "${p.id}" resources 必须为数组`;
        for (const r of p.resources) {
          if (!r.id || typeof r.id !== 'string') return `计划 "${p.id}" 资源必须有 id`;
          if (r.kind && !VALID_RES_KIND.includes(r.kind)) return `资源 "${r.id}" kind 无效: "${r.kind}"`;
          if (r.total != null && (typeof r.total !== 'number' || r.total < 0)) return `资源 "${r.id}" total 必须为非负数`;
        }
      }

      // 团队成员校验（新增板块，弱约束：数组 + 每项有 id）
      if (p.members != null) {
        if (!Array.isArray(p.members)) return `计划 "${p.id}" members 必须为数组`;
        for (const mb of p.members) {
          if (!mb.id || typeof mb.id !== 'string') return `计划 "${p.id}" 团队成员必须有 id`;
        }
      }

      // 参考文档 / 交付件校验（支持多层级 parentId；阶段/状态/日期在提供时校验，兼容历史数据）
      if (p.references != null) {
        if (!Array.isArray(p.references)) return `计划 "${p.id}" references 必须为数组`;
        const rfIds = new Set();
        for (const rf of p.references) {
          if (!rf.id || typeof rf.id !== 'string') return `计划 "${p.id}" 参考文档必须有 id`;
          if (rfIds.has(rf.id)) return `计划 "${p.id}" 参考文档 ID 重复: ${rf.id}`;
          rfIds.add(rf.id);
          if (rf.stage && !VALID_REF_STAGE.includes(rf.stage)) return `交付件 "${rf.id}" 评审阶段无效: "${rf.stage}"`;
          if (rf.status && !VALID_REF_DOC_STATUS.includes(rf.status)) return `交付件 "${rf.id}" 状态无效: "${rf.status}"`;
          if (rf.date && !isValidDate(rf.date)) return `交付件 "${rf.id}" 提交日期必须为 YYYY-MM-DD`;
        }
      }

      // RPD 模板库链接
      if (p.rpdTemplateUrl != null && typeof p.rpdTemplateUrl !== 'string') return `计划 "${p.id}" rpdTemplateUrl 必须为字符串`;

      // 项目总览校验（固定阶段大纲，独立于 tasks；弱约束：数组 + 每项有 id + 进度/状态合法）
      if (p.overview != null) {
        if (!Array.isArray(p.overview)) return `计划 "${p.id}" overview 必须为数组`;
        for (const ov of p.overview) {
          if (!ov.id || typeof ov.id !== 'string') return `计划 "${p.id}" 项目总览阶段必须有 id`;
          if (ov.status && !VALID_TASK_STATUS.includes(ov.status)) return `总览阶段 "${ov.id}" 状态无效: "${ov.status}"`;
          if (ov.progress != null && (typeof ov.progress !== 'number' || ov.progress < 0 || ov.progress > 100)) return `总览阶段 "${ov.id}" 进度必须为 0-100`;
          if (ov.startDate && !isValidDate(ov.startDate)) return `总览阶段 "${ov.id}" startDate 必须为 YYYY-MM-DD`;
          if (ov.endDate && !isValidDate(ov.endDate)) return `总览阶段 "${ov.id}" endDate 必须为 YYYY-MM-DD`;
          if (ov.startDate && ov.endDate && ov.startDate > ov.endDate) return `总览阶段 "${ov.id}" 开始日期不能晚于结束日期`;
        }
      }

      // 上市计划（树形：parentId 为空=阶段）
      if (p.marketPlan != null) {
        if (!Array.isArray(p.marketPlan)) return `计划 "${p.id}" marketPlan 必须为数组`;
        const mkIds = new Set();
        for (const mk of p.marketPlan) {
          if (!mk.id || typeof mk.id !== 'string') return `计划 "${p.id}" 上市计划任务必须有 id`;
          if (mkIds.has(mk.id)) return `计划 "${p.id}" 上市计划任务 ID 重复: ${mk.id}`;
          mkIds.add(mk.id);
          if (mk.status && !VALID_TASK_STATUS.includes(mk.status)) return `上市计划任务 "${mk.id}" 状态无效: "${mk.status}"`;
          if (mk.startDate && !isValidDate(mk.startDate)) return `上市计划任务 "${mk.id}" startDate 必须为 YYYY-MM-DD`;
          if (mk.endDate && !isValidDate(mk.endDate)) return `上市计划任务 "${mk.id}" endDate 必须为 YYYY-MM-DD`;
          if (mk.startDate && mk.endDate && mk.startDate > mk.endDate) return `上市计划任务 "${mk.id}" 开始日期不能晚于结束日期`;
        }
      }

      // 遗留问题
      if (p.issues != null) {
        if (!Array.isArray(p.issues)) return `计划 "${p.id}" issues 必须为数组`;
        for (const it of p.issues) {
          if (!it.id || typeof it.id !== 'string') return `计划 "${p.id}" 遗留问题必须有 id`;
          if (it.status && !VALID_ISSUE_STATUS.includes(it.status)) return `遗留问题 "${it.id}" 状态无效: "${it.status}"`;
          if (it.dueDate && !isValidDate(it.dueDate)) return `遗留问题 "${it.id}" dueDate 必须为 YYYY-MM-DD`;
        }
      }

      // 项目风险
      if (p.risks != null) {
        if (!Array.isArray(p.risks)) return `计划 "${p.id}" risks 必须为数组`;
        for (const rk of p.risks) {
          if (!rk.id || typeof rk.id !== 'string') return `计划 "${p.id}" 项目风险必须有 id`;
          if (rk.type && !VALID_RISK_TYPE.includes(rk.type)) return `项目风险 "${rk.id}" 类型无效: "${rk.type}"`;
          if (rk.status && !VALID_RISK_STATUS.includes(rk.status)) return `项目风险 "${rk.id}" 状态无效: "${rk.status}"`;
          if (rk.dueDate && !isValidDate(rk.dueDate)) return `项目风险 "${rk.id}" dueDate 必须为 YYYY-MM-DD`;
        }
      }
    }
  }
  return null;
}

/* ---------- 计划执行汇总（高管视图数据源） ---------- */
function parseDate(value) {
  if (!value) return null;
  const t = new Date(value);
  return isNaN(t.getTime()) ? null : t;
}

function computePlanSummary(plan) {
  const tasks = plan.tasks || [];
  const milestones = plan.milestones || [];
  const resources = plan.resources || [];
  const today = new Date().toISOString().slice(0, 10);

  // WBS
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === 'completed' || t.progress >= 100).length;
  const inProgressTasks = tasks.filter(t => t.status === 'in-progress').length;
  const blockedTasks = tasks.filter(t => t.status === 'blocked').length;
  const notStartedTasks = tasks.filter(t => t.status === 'not-started').length;
  const sumHours = tasks.reduce((s, t) => s + (t.plannedHours || 0), 0);
  const finishedHours = tasks.filter(t => t.status === 'completed').reduce((s, t) => s + (t.plannedHours || 0), 0);
  const taskDone = tasks.filter(t => t.status === 'completed').length;
  const overallProgress = totalTasks
    ? Math.round(tasks.reduce((s, t) => s + (t.progress || 0), 0) / totalTasks)
    : 0;
  const topLevel = tasks.filter(t => !t.parentId).length;
  // 阶段汇总：输出为数组，字段与客户端渲染保持一致
  const phaseMap = {};
  tasks.forEach(t => {
    const key = t.phase || t.type || '未分组';
    phaseMap[key] = phaseMap[key] || { name: key, total: 0, completed: 0, sumHours: 0 };
    phaseMap[key].total++;
    phaseMap[key].sumHours += t.plannedHours || 0;
    if (t.status === 'completed') phaseMap[key].completed++;
  });
  const phases = Object.keys(phaseMap).map(k => phaseMap[k]);

  // 里程碑
  const msDone = milestones.filter(m => m.status === 'done').length;
  const msInProgress = milestones.filter(m => m.status === 'in-progress').length;
  const msPending = milestones.filter(m => m.status === 'pending').length;

  // 资源负载
  const ownerHours = {};
  tasks.forEach(t => {
    const owner = t.owner || (t.dept ? t.dept : '未分配');
    ownerHours[owner] = (ownerHours[owner] || 0) + (t.plannedHours || 0);
  });
  const resourceLoad = resources.map(r => ({
    id: r.id, name: r.name, kind: r.kind, dept: r.dept || '', team: r.team || '',
    total: r.total || 0, used: r.used || 0,
    hours: ownerHours[r.name] || 0,
    load: r.total ? Math.round(((r.used || 0) + (ownerHours[r.name] || 0)) / r.total * 100) : 0
  })).sort((a, b) => b.load - a.load);

  // 风险：逾期/阻塞任务、临期里程碑
  const riskyTasks = tasks
    .filter(t => {
      if (t.status === 'completed') return false;
      const overdue = t.endDate && t.endDate < today && t.progress < 100;
      const stuck = t.status === 'blocked';
      return overdue || stuck;
    })
    .map(t => {
      const overdue = t.endDate && t.endDate < today && t.progress < 100;
      return { type: overdue ? 'overdue' : 'blocked', id: t.id, name: t.name, owner: t.owner || '', endDate: t.endDate || '', progress: t.progress || 0, priority: t.priority || 'medium' };
    })
    .sort((a, b) => (a.endDate || '').localeCompare(b.endDate || ''));

  const upcomingMilestones = milestones
    .filter(m => m.status !== 'done')
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))
    .slice(0, 5);

  return {
    id: plan.id,
    name: plan.name || '',
    year: plan.year || new Date().getFullYear(),
    status: plan.status || 'draft',
    owner: plan.owner || '',
    projectId: plan.projectId || '',
    projectName: plan.projectName || '',
    startDate: plan.startDate || '',
    endDate: plan.endDate || '',
    wbs: {
      total: totalTasks, completed: completedTasks, inProgress: inProgressTasks,
      blocked: blockedTasks, notStarted: notStartedTasks,
      sumHours, finishedHours, taskDoneRate: totalTasks ? Math.round(completedTasks / totalTasks * 100) : 0,
      overallProgress, topLevel, phases
    },
    milestone: { total: milestones.length, done: msDone, inProgress: msInProgress, pending: msPending },
    resource: { load: resourceLoad, total: resources.length, overloaded: resourceLoad.filter(r => r.load >= 100).length },
    risks: riskyTasks,
    upcomingMilestones,
    today
  };
}

function computeSummary(state) {
  const plans = state.plans || [];
  const summaries = plans.map(computePlanSummary);

  const agg = {
    planCount: plans.length,
    activeCount: plans.filter(p => p.status === 'active').length,
    draftCount: plans.filter(p => p.status === 'draft').length,
    totalTasks: summaries.reduce((s, x) => s + x.wbs.total, 0),
    totalHours: summaries.reduce((s, x) => s + x.wbs.sumHours, 0),
    avgProgress: summaries.length ? Math.round(summaries.reduce((s, x) => s + x.wbs.overallProgress, 0) / summaries.length) : 0,
    riskCount: summaries.reduce((s, x) => s + x.risks.length, 0)
  };

  return { plans: summaries, agg };
}

/* ---------- 模块导出 ---------- */
module.exports = {
  id: 'plan',
  prefix: '/api/plan',

  ensureData() {
    ensureDir(PLAN_DIR);
    ensureDir(HISTORY_DIR);
    if (!fs.existsSync(STATE_FILE)) {
      writeState(JSON.parse(JSON.stringify(EMPTY_STATE)));
    }
  },

  handle(req, res, u) {
    const pathname = u.pathname || '';
    const sub = pathname.replace('/api/plan', '');

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
        if (body.length > 32 * 1024 * 1024) req.destroy();
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

        const merged = {
          ...cur,
          ...next,
          plans: next.plans != null ? next.plans : cur.plans
        };

        merged.rev = Math.max(curRev, isFinite(baseRev) ? baseRev : 0) + 1;
        merged.updatedAt = new Date().toLocaleString('zh-CN');
        merged.updatedBy = String(incoming.by || '未署名').slice(0, 40);

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
