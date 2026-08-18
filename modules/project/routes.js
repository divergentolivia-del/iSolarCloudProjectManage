/* modules/project/routes.js — 全年度项目管理模块服务端路由
   处理 /api/project/state 的 GET/POST 请求和 /api/project/milestones。
   数据存储于 data/project/state.json 和 data/project/history/。
*/

'use strict';

const fs = require('fs');
const path = require('path');

/* 数据目录配置 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');
const PROJ_DIR = path.join(DATA_DIR, 'project');
const STATE_FILE = path.join(PROJ_DIR, 'state.json');
const HISTORY_DIR = path.join(PROJ_DIR, 'history');

/* 有效状态枚举 */
const VALID_STATUSES = ['planned', 'in-progress', 'completed', 'suspended'];
const VALID_RELEASE_LAYERS = ['platform', 'business', 'shared'];
const VALID_RELEASE_RISKS = ['high', 'medium', 'low'];

/* ---------- 空状态模板 ---------- */
const EMPTY_STATE = {
  rev: 0,
  updatedAt: '',
  updatedBy: '',
  year: new Date().getFullYear(),
  projects: []
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
 * 读取项目模块状态
 */
function readState() {
  if (!fs.existsSync(STATE_FILE)) return JSON.parse(JSON.stringify(EMPTY_STATE));
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[project] state.json 解析失败:', e.message);
    const snap = latestSnapshot();
    if (snap) {
      console.error('[project]   已回退到快照:', snap.name);
      return snap.data;
    }
    console.error('[project]   无可用快照，返回空态');
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
  ensureDir(PROJ_DIR);
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
    const name = 'project-rev' + s.rev + '.json';
    fs.writeFileSync(path.join(HISTORY_DIR, name), JSON.stringify(s), 'utf8');
  } catch (e) { /* 归档失败不影响主流程 */ }
}

/**
 * 验证项目数据有效性
 * @returns {string|null} 错误消息或 null 表示有效
 */
function validateProjects(projects) {
  if (!Array.isArray(projects)) return '项目列表必须为数组';

  const ids = new Set();
  for (const p of projects) {
    // ID 唯一性
    if (!p.id || typeof p.id !== 'string') return '每个项目必须有有效的 id';
    if (ids.has(p.id)) return `项目 ID 重复: ${p.id}`;
    ids.add(p.id);

    // 状态枚举校验
    if (p.status && !VALID_STATUSES.includes(p.status)) {
      return `项目 "${p.id}" 状态无效: "${p.status}"，有效值为 ${VALID_STATUSES.join(', ')}`;
    }

    // 日期范围校验：startDate ≤ endDate
    if (p.startDate && p.endDate && p.startDate > p.endDate) {
      return `项目 "${p.id}" 开始日期(${p.startDate})不能晚于结束日期(${p.endDate})`;
    }

    // 年度发布字段校验
    if (p.releaseLayer && !VALID_RELEASE_LAYERS.includes(p.releaseLayer)) {
      return `项目 "${p.id}" releaseLayer 无效: "${p.releaseLayer}"，有效值为 ${VALID_RELEASE_LAYERS.join(', ')}`;
    }
    if (p.releaseRisk && !VALID_RELEASE_RISKS.includes(p.releaseRisk)) {
      return `项目 "${p.id}" releaseRisk 无效: "${p.releaseRisk}"，有效值为 ${VALID_RELEASE_RISKS.join(', ')}`;
    }
    if (p.releaseDate && !isValidProjectDateText(p.releaseDate)) {
      return `项目 "${p.id}" releaseDate 必须为 YYYY-MM 或 YYYY-MM-DD`;
    }

    // resourceSummary 数值校验
    if (p.resourceSummary) {
      const rs = p.resourceSummary;
      if (rs.totalManMonths != null && (typeof rs.totalManMonths !== 'number' || rs.totalManMonths < 0)) {
        return `项目 "${p.id}" totalManMonths 必须为非负数`;
      }
      if (rs.usedManMonths != null && (typeof rs.usedManMonths !== 'number' || rs.usedManMonths < 0)) {
        return `项目 "${p.id}" usedManMonths 必须为非负数`;
      }
      if (rs.totalCost != null && (typeof rs.totalCost !== 'number' || rs.totalCost < 0)) {
        return `项目 "${p.id}" totalCost 必须为非负数`;
      }
      if (rs.usedCost != null && (typeof rs.usedCost !== 'number' || rs.usedCost < 0)) {
        return `项目 "${p.id}" usedCost 必须为非负数`;
      }
      if (rs.outsourceCount != null && (typeof rs.outsourceCount !== 'number' || rs.outsourceCount < 0)) {
        return `项目 "${p.id}" outsourceCount 必须为非负数`;
      }
      if (rs.durationMonths != null && (typeof rs.durationMonths !== 'number' || rs.durationMonths < 0)) {
        return `项目 "${p.id}" durationMonths 必须为非负数`;
      }
      // teams should be an object if present
      if (rs.teams != null && (typeof rs.teams !== 'object' || Array.isArray(rs.teams))) {
        return `项目 "${p.id}" teams 必须为对象`;
      }
    }
  }

  return null; // valid
}

/**
 * 提取即将到来的里程碑（未完成的，按日期排序）
 */
function extractUpcomingMilestones(state) {
  const milestones = [];
  const today = new Date().toISOString().slice(0, 10);

  (state.projects || []).forEach(proj => {
    if (proj.status === 'completed' || proj.status === 'suspended') return;
    (proj.milestones || []).forEach(ms => {
      if (ms.status === 'done') return;
      milestones.push({
        projectId: proj.id,
        projectName: proj.name || '',
        name: ms.name || '',
        date: ms.date || '',
        status: ms.status || 'pending',
        overdue: ms.date ? ms.date < today : false
      });
    });
  });

  // 按日期升序排列
  milestones.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return milestones;
}

/* ---------- 模块导出 ---------- */

module.exports = {
  id: 'project',
  prefix: '/api/project',

  /**
   * ensureData() — 确保项目模块数据目录存在
   */
  ensureData() {
    ensureDir(PROJ_DIR);
    ensureDir(HISTORY_DIR);
    // 初始化空状态文件（如果不存在）
    if (!fs.existsSync(STATE_FILE)) {
      writeState(JSON.parse(JSON.stringify(EMPTY_STATE)));
    }
  },

  /**
   * handle(req, res, parsedUrl) — 路由处理
   * 处理：
   *   GET  /api/project/state      — 读取项目状态
   *   POST /api/project/state      — 更新项目状态（乐观锁）
   *   GET  /api/project/milestones — 获取即将到来的里程碑
   */
  handle(req, res, u) {
    const pathname = u.pathname || '';
    const sub = pathname.replace('/api/project', '');

    // GET /api/project/state — 读取当前项目状态
    if (sub === '/state' && req.method === 'GET') {
      return sendJson(res, 200, readState());
    }

    // POST /api/project/state — 提交项目状态变更（乐观锁）
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

        // 验证项目数据
        if (next.projects) {
          const err = validateProjects(next.projects);
          if (err) {
            return sendJson(res, 400, { error: err });
          }
        }

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

    // GET /api/project/milestones — 即将到来的里程碑
    if (sub === '/milestones' && req.method === 'GET') {
      const state = readState();
      const milestones = extractUpcomingMilestones(state);
      return sendJson(res, 200, milestones);
    }

    // 未匹配到任何路由
    sendJson(res, 404, { error: 'Not Found' });
  },

  /* 暴露 readState 供外部模块（如 dashboard）使用 */
  readState
};
