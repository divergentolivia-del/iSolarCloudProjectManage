/* modules/pradapter/routes.js — Git PR adapter：数据自动流入（M2-A）
   采集 Git 仓库提交 → 四级映射（L1/L2/L3/L4 + 置信度）→ 落库 → 静默告警。

   端点（权限资源：pradapter）：
     GET  /api/pradapter/state    → 采集快照 + 映射统计 + 告警（pradapter:read）
     GET  /api/pradapter/alerts   → 告警列表（pradapter:read）
     GET  /api/pradapter/config   → 仓库配置（pradapter:read）
     POST /api/pradapter/refresh  → 重新采集（pradapter:write）
     POST /api/pradapter/confirm  → L2 确认/驳回 {hash, taskId, yes}（pradapter:write）

   配置：data/pradapter/config.json
     { "repos": [ { "id":"可选", "name":"阳光云项目管理", "path":"E:/xxx",
                    "module":"可选，配置后仓库级提交记为 L3" } ] }

   数据：data/pradapter/state.json（lastRefreshAt/repos/commits/mappings/confirms/alerts/rawLog/stats）
   原则（master §4.3）：映射只做佐证，不覆盖手写完成度；L3 代码只取统计特征。 */

'use strict';

const fs = require('fs');
const path = require('path');
const mapLib = require('./lib/map');
const alertLib = require('./lib/alert');
const gitLib = require('./lib/git');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'pradapter');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_CONFIG = { repos: [] };
const EMPTY_STATE = {
  lastRefreshAt: null, repos: [], commits: [], mappings: [],
  confirms: [], alerts: [], rawLog: [], stats: null
};

/* ---------- 数据读写 ---------- */

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  }
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(EMPTY_STATE, null, 2), 'utf8');
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function readBody(req, limit) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > (limit || 65536)) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

/** 平台任务库（统一契约字段 §2；plan 数据到位后自动生效，当前为空） */
function loadTasks() {
  const tasks = [];
  try {
    const plan = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'plan', 'state.json'), 'utf8')
    );
    for (const p of plan.plans || []) {
      if (!p.id || !(p.title || p.name)) continue;
      tasks.push({
        id: String(p.id),
        title: p.title || p.name,
        due: p.due || null,
        status_category: p.status_category || 'todo'
      });
    }
  } catch (e) { /* plan 库不存在时任务库为空，L1/L2 退化为仓库级 */ }
  return tasks;
}

/* ---------- 核心：采集 + 映射 + 告警 ---------- */

function refresh() {
  const cfg = readJson(CONFIG_FILE, DEFAULT_CONFIG);
  const repos = (cfg.repos || []).map(r => ({
    id: r.id || r.name, name: r.name, path: r.path, module: r.module || ''
  }));

  const results = gitLib.collectAll(repos);
  const tasks = loadTasks();
  const state = readJson(STATE_FILE, EMPTY_STATE);

  const commits = [];
  const rawLog = [];
  const repoMeta = {};

  for (const r of results) {
    repoMeta[r.id] = {
      id: r.id, name: r.name, path: r.path, module: r.module || '',
      ok: r.ok, error: r.error, lastCommitAt: r.lastCommitAt,
      branchCount: r.branches.length, commitCount: r.commits.length
    };
    for (const c of r.commits) {
      let m = mapLib.matchCommit(c, tasks);
      const repoMetaEntry = repoMeta[r.id] || {};
      if (m.level === 'L4' && repoMetaEntry.module) {
        // L3 仓库关联：仓库配置了 module，只更新活跃度，不碰任务
        m = { level: 'L3', confidence: 0.3, reason: `仓库「${r.name}」配置关联模块 ${repoMetaEntry.module}`, module: repoMetaEntry.module };
      }
      commits.push({
        hash: c.hash, repoId: r.id, branch: c.branch, author: c.author, at: c.at,
        subject: c.subject, level: m.level, taskId: m.taskId || null,
        confidence: m.confidence, reason: m.reason, module: m.module || null
      });
      rawLog.push({ hash: c.hash, repoId: r.id, branch: c.branch, at: c.at, subject: c.subject });
    }
  }

  // 映射表：历史确认 + 本次 L1（去重）
  const mappings = (state.mappings || []).concat(
    commits.filter(c => c.level === 'L1' && c.taskId)
      .map(c => ({ repoId: c.repoId, taskId: c.taskId }))
  ).filter((m, i, arr) => arr.findIndex(
    x => x.repoId === m.repoId && x.taskId === m.taskId) === i);

  const alerts = alertLib.computeAlerts({
    repos: Object.values(repoMeta), mappings, tasks, now: Date.now()
  });

  state.lastRefreshAt = new Date().toISOString();
  state.repos = Object.values(repoMeta);
  state.commits = commits;
  state.mappings = mappings;
  state.alerts = alerts;
  state.rawLog = rawLog.slice(-2000);
  state.stats = {
    repoCount: Object.keys(repoMeta).length,
    commitCount: commits.length,
    byLevel: {
      L1: commits.filter(c => c.level === 'L1').length,
      L2: commits.filter(c => c.level === 'L2').length,
      L3: commits.filter(c => c.level === 'L3').length,
      L4: commits.filter(c => c.level === 'L4').length
    },
    alertCount: alerts.length
  };
  writeJson(STATE_FILE, state);
  return state;
}

/* ---------- 端点 ---------- */

function handleConfirm(req, res, body) {
  const { hash, taskId, yes } = body;
  if (!hash || !taskId) return sendJson(res, 400, { error: '需要 hash 和 taskId' });
  const state = readJson(STATE_FILE, EMPTY_STATE);
  const c = (state.commits || []).find(x => x.hash === hash);
  if (!c) return sendJson(res, 404, { error: '找不到该提交（先 refresh）' });

  state.confirms = (state.confirms || []).concat({
    hash, repoId: c.repoId, taskId: String(taskId), yes: !!yes, at: new Date().toISOString()
  });
  if (yes) {
    c.level = 'L1';
    c.taskId = String(taskId);
    c.confidence = 0.95;
    c.reason = '人工确认 L2→L1（确认动作训练映射规则）';
    state.mappings = (state.mappings || []).concat([{ repoId: c.repoId, taskId: String(taskId) }])
      .filter((m, i, arr) => arr.findIndex(
        x => x.repoId === m.repoId && x.taskId === m.taskId) === i);
  } else {
    c.level = 'L4';
    c.taskId = null;
    c.confidence = 0;
    c.reason = '人工驳回 L2 建议';
  }
  writeJson(STATE_FILE, state);

  // 审计（尽力而为，不阻塞响应）
  try {
    const auth = require('../auth/routes');
    const me = auth.currentUser(req);
    const db = require('../../db');
    db.logAudit({
      user_id: me ? me.id : '', user: me ? me.name : '',
      module: 'pradapter', action: yes ? '确认映射' : '驳回映射',
      details: `${hash} -> ${taskId}`
    });
  } catch (e) { /* ignore */ }

  return sendJson(res, 200, { ok: true, commit: c });
}

function handle(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/pradapter/state') {
    return sendJson(res, 200, readJson(STATE_FILE, EMPTY_STATE));
  }
  if (method === 'GET' && p === '/api/pradapter/alerts') {
    const st = readJson(STATE_FILE, EMPTY_STATE);
    return sendJson(res, 200, { alerts: st.alerts || [], lastRefreshAt: st.lastRefreshAt || null });
  }
  if (method === 'GET' && p === '/api/pradapter/config') {
    return sendJson(res, 200, readJson(CONFIG_FILE, DEFAULT_CONFIG));
  }
  if (method === 'POST' && p === '/api/pradapter/refresh') {
    const st = refresh();
    return sendJson(res, 200, { ok: true, lastRefreshAt: st.lastRefreshAt, stats: st.stats });
  }
  if (method === 'POST' && p === '/api/pradapter/confirm') {
    return readBody(req).then(body => handleConfirm(req, res, body));
  }
  return sendJson(res, 404, { error: '未找到 pradapter 端点' });
}

module.exports = {
  id: 'pradapter',
  prefix: '/api/pradapter',
  resource: 'pradapter',
  ensureData,
  handle,
  _internal: { refresh, loadTasks }   // 供测试直接调用
};