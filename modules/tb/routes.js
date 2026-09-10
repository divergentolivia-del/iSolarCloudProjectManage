/* modules/tb/routes.js — Teambition 同步模块服务端路由
   端点：
     GET  /api/tb/config   — 返回看板模板元数据（团队/迭代/维度，不含凭据）+ 凭据是否已配置
     GET  /api/tb/sprints  — 拉取项目下的迭代列表（供前端下拉选择，替代手填 sprintId）
     GET  /api/tb/projects — 按名称/ID 搜索 TB 项目（供项目管理模块建立关联）
     GET  /api/tb/projectSummary — 单个 TB 项目概要（项目名/编码/进行中迭代/任务完成率）
     POST /api/tb/sync     — 触发同步，写入 iteration state，返回统计
     GET  /api/tb/status   — 返回上次同步的统计（data/tb/state.json）

   ⚠️ 凭据来源优先级：环境变量 > data/tb/secret.json。
      应用凭据（appId/appSecret/tenantId/operatorId）优先，缺失时回退 User Token。
      两者都不进 git。前端永远拿不到凭据明文。
*/

'use strict';

const fs = require('fs');
const path = require('path');

const tbConfig = require('../../tb-config');
const tbSync = require('./sync');
const tbClient = require('./client');
const audit = require('../../audit');

/* 数据目录 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');
const TB_DIR = path.join(DATA_DIR, 'tb');
const SECRET_FILE = path.join(TB_DIR, 'secret.json');
const TB_STATE_FILE = path.join(TB_DIR, 'state.json');

/* 迭代模块数据（同步结果写入这里） */
const ITER_DIR = path.join(DATA_DIR, 'iteration');
const ITER_STATE_FILE = path.join(ITER_DIR, 'state.json');
const ITER_HISTORY_DIR = path.join(ITER_DIR, 'history');

/* ---------- 工具 ---------- */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

/** 读取 TB 凭据（应用凭据优先，缺失时回退 User Token）。实际解析逻辑在 client.js */
function readCredentials() {
  return tbClient.readCredentials();
}

/** 兼容旧调用：返回可用的 User Token（应用模式下可能为空，仅用于 /config 展示判断） */
function readToken() {
  const c = readCredentials();
  return c.mode === 'user' ? c.userToken : '';
}

/** 凭据是否可用（应用凭据齐全 或 有 User Token） */
function hasCredentials() {
  return readCredentials().mode !== 'none';
}

/** 原子写文件 */
function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- iteration state 读写（与 iteration 模块一致的落盘规则）---------- */

const EMPTY_ITER_STATE = {
  cycles: [{ name: '方案一', seal: '', online: '', workdays: 0, saturdays: 0, active: true, note: '' }],
  headcount: {}, locked: [], totals: [], board: [], iterations: [], sources: {},
  rev: 0, updatedAt: '', updatedBy: ''
};

function readIterState() {
  if (!fs.existsSync(ITER_STATE_FILE)) return JSON.parse(JSON.stringify(EMPTY_ITER_STATE));
  try {
    return JSON.parse(fs.readFileSync(ITER_STATE_FILE, 'utf8'));
  } catch (e) {
    return JSON.parse(JSON.stringify(EMPTY_ITER_STATE));
  }
}

/** 读取迭代映射：state.tbSprintMap（前端配置） > tb-config.TB_SPRINTS 默认值 */
function readSprintMap() {
  const s = readIterState();
  const configured = (s.tbSprintMap || {});
  // 合并默认表（后端兜底），前端配置优先
  return Object.assign({}, tbConfig.TB_SPRINTS || {}, configured);
}

function writeIterState(s) {
  ensureDir(ITER_DIR);
  ensureDir(ITER_HISTORY_DIR);
  const tmp = ITER_STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, ITER_STATE_FILE);
  // 历史快照
  try {
    const c = (s.cycles || []).find(x => x.active) || {};
    const tag = String(c.online || 'unnamed').replace(/[^\w.-]/g, '_');
    fs.writeFileSync(path.join(ITER_HISTORY_DIR, tag + '-rev' + s.rev + '.json'), JSON.stringify(s), 'utf8');
  } catch (e) { /* 快照失败不影响主流程 */ }
}

/** 重建迭代清单：从 totals + board 提取迭代名，保留已有勾选状态 */
function rebuildIterations(s) {
  const agg = {};
  (s.totals || []).concat(s.board || []).forEach(r => {
    const k = r.iteration;
    if (!k) return;
    agg[k] = (agg[k] || 0) + (Number(r.story) || 0) + (Number(r.est) || 0);
  });
  const prevSel = {};
  (s.iterations || []).forEach(i => { prevSel[i.name] = i.selected; });
  s.iterations = Object.keys(agg)
    .map(k => ({ name: k, weight: agg[k], selected: prevSel[k] !== undefined ? prevSel[k] : true }))
    .sort((a, b) => b.weight - a.weight);
}

/* ---------- 同步结果写入 iteration state ---------- */
function applySyncToState(result, by, sprintMap, boardSprints) {
  const s = readIterState();
  const now = new Date().toLocaleString('zh-CN');

  // 保存迭代映射（前端配置供下次读取）
  if (sprintMap && Object.keys(sprintMap).length) s.tbSprintMap = sprintMap;
  // 保存迭代映射完整配置（含每行 sid/name），供前端刷新后仍能回显
  if (boardSprints && typeof boardSprints === 'object') s.tbBoardSprints = boardSprints;

  s._totalsCloud = result.cloudRows;
  s._totalsMiddle = result.middleRows;
  s.board = result.boardRows;
  s.totals = (s._totalsCloud || []).concat(s._totalsMiddle || []);

  s.sources = s.sources || {};
  s.sources.totals = { fileName: 'TB自动同步·' + result.stats.cloud.name, at: now, rows: result.cloudRows.length, tb: true };
  s.sources.totalsMiddle = { fileName: 'TB自动同步·' + result.stats.middle.name, at: now, rows: result.middleRows.length, tb: true };
  s.sources.board = { fileName: 'TB自动同步·' + result.stats.productLine.name, at: now, rows: result.boardRows.length, tb: true };

  rebuildIterations(s);

  // TB 同步后迭代已自动勾选，无需再提示"请重新勾选"
  s.iterDirty = false;

  s.rev = Number(s.rev || 0) + 1;
  s.updatedAt = now;
  s.updatedBy = String(by || 'TB同步').slice(0, 40);

  writeIterState(s);

  if (typeof global._broadcast === 'function') {
    global._broadcast(s.rev, s.updatedBy);
  }
  return s.rev;
}

/* ---------- 请求体读取 ---------- */
function readBody(req, limit, cb) {
  let body = '';
  req.on('data', c => {
    body += c;
    if (body.length > limit) req.destroy();
  });
  req.on('end', () => cb(body));
}

/* ---------- 模块导出 ---------- */
module.exports = {
  id: 'tb',
  prefix: '/api/tb',

  ensureData() {
    ensureDir(TB_DIR);
    // 若无密钥文件，写一个占位模板（不含真实凭据），提醒用户填写
    if (!fs.existsSync(SECRET_FILE) && readCredentials().mode === 'none') {
      try {
        writeJsonAtomic(SECRET_FILE, {
          _comment: '推荐用应用凭据：填 appId/appSecret/tenantId/operatorId（TB 后台创建企业内部应用后获得）。也可回退填 token（User Token）。本文件已 .gitignore，不会提交。环境变量 TB_APP_ID / TB_APP_SECRET / TB_TENANT_ID / TB_OPERATOR_ID / TB_TOKEN 可覆盖。',
          appId: '',
          appSecret: '',
          tenantId: '',
          operatorId: '',
          token: ''
        });
      } catch (e) { /* 忽略 */ }
    }
  },

  handle(req, res, u) {
    const pathname = u.pathname || '';
    const sub = pathname.replace('/api/tb', '');

    /* GET /api/tb/config — 看板模板元数据（脱敏，不含凭据） */
    if (sub === '/config' && req.method === 'GET') {
      const cred = readCredentials();
      const boards = Object.keys(tbConfig.TB_BOARDS).map(k => {
        const b = tbConfig.TB_BOARDS[k];
        return {
          key: b.key,
          name: b.name,
          dimension: b.dimension,
          filterTaskLevel: b.filterTaskLevel,
          teams: b.teams,
          teamCount: b.teams ? b.teams.length : '全部',
          sprintId: b.sprintId || null,
          sprintIds: b.sprintIds || null,
          sprintName: b.sprintName || ''
        };
      });
      return sendJson(res, 200, {
        projectId: tbConfig.TB_PROJECT_ID,
        // authMode: app=应用凭据 / user=User Token / none=未配置
        authMode: cred.mode,
        tokenConfigured: cred.mode !== 'none',
        operatorConfigured: !!cred.operatorId,
        sprintMap: readSprintMap(),
        boards: boards
      });
    }

    /* GET /api/tb/sprints — 拉取项目下的迭代列表（供前端下拉选择）
       query: projectId?（默认用 tb-config 的 TB_PROJECT_ID）、status?（future/active/complete）
       返回：[{ id, name, status, startDate, dueDate, accomplished }]，按时间倒序 */
    if (sub === '/sprints' && req.method === 'GET') {
      const cred = readCredentials();
      if (cred.mode === 'none') {
        return sendJson(res, 400, { error: '未配置 TB 凭据，无法拉取迭代列表。' });
      }
      // ⚠️ u 来自 url.parse(req.url, true)，query 在 u.query（没有 searchParams）
      const q = u.query || {};
      const projectId = (String(q.projectId || '').trim() || tbConfig.TB_PROJECT_ID || '').trim();
      const status = String(q.status || '').trim();
      tbClient.listSprints(projectId, { status: status || undefined }, cred)
        .then(list => {
          const rows = list.map(s => ({
            id: s.id || s.sprintId || '',
            name: s.name || '',
            status: s.status || '',
            startDate: s.startDate || null,
            dueDate: s.dueDate || null,
            accomplished: s.accomplished || null
          })).filter(r => r.id)
            // 排序：未完成/进行中优先（future=未开始，active=进行中），组内按开始时间倒序。
            // ⚠️ 不能只按 startDate 排：部分迭代 startDate 为 null，会被挤到最后。
            .sort((a, b) => {
              const rank = s => (s === 'active' ? 0 : s === 'future' ? 1 : 2);
              const ra = rank(a.status), rb = rank(b.status);
              if (ra !== rb) return ra - rb;
              const ta = String(a.startDate || a.dueDate || '');
              const tb = String(b.startDate || b.dueDate || '');
              return tb.localeCompare(ta);
            });
          return sendJson(res, 200, { ok: true, projectId: projectId, count: rows.length, sprints: rows });
        })
        .catch(e => {
          const detail = e.body ? (' | ' + JSON.stringify(e.body).slice(0, 300)) : '';
          return sendJson(res, 502, {
            error: '拉取迭代列表失败: ' + e.message + detail,
            statusCode: e.statusCode || null
          });
        });
      return;
    }

    /* GET /api/tb/projects — 搜索 TB 项目（供项目管理模块关联时选择）
       query: name?（模糊搜索关键字）、ids?（逗号分隔的项目 ID，精确查询）
       ⚠️ 企业内项目 200+，不做无参全量返回，必须传 name 或 ids
       返回：[{ id, name, code, isArchived, startDate, endDate }] */
    if (sub === '/projects' && req.method === 'GET') {
      const cred = readCredentials();
      if (cred.mode === 'none') {
        return sendJson(res, 400, { error: '未配置 TB 凭据，无法搜索项目。' });
      }
      const q = u.query || {};
      const name = String(q.name || '').trim();
      const idsRaw = String(q.ids || '').trim();
      const ids = idsRaw ? idsRaw.split(',').map(s => s.trim()).filter(s => /^[0-9a-fA-F]{24}$/.test(s)) : [];
      if (!name && !ids.length) {
        return sendJson(res, 400, { error: '请提供 name（搜索关键字）或 ids（项目ID）。' });
      }
      tbClient.queryProjects({ ids: ids.length ? ids : undefined, name: name || undefined }, cred)
        .then(list => {
          const rows = list.map(p => ({
            id: p.id || '',
            name: p.name || '',
            // 项目编码 = uniqueIdPrefix（任务号前缀，如 ST001）
            code: p.uniqueIdPrefix || '',
            isArchived: !!p.isArchived,
            startDate: p.startDate || null,
            endDate: p.endDate || null
          })).filter(r => r.id)
            // 未归档优先，其次按名称
            .sort((a, b) => (a.isArchived - b.isArchived) || a.name.localeCompare(b.name, 'zh-CN'));
          return sendJson(res, 200, { ok: true, count: rows.length, projects: rows });
        })
        .catch(e => {
          const detail = e.body ? (' | ' + JSON.stringify(e.body).slice(0, 300)) : '';
          return sendJson(res, 502, {
            error: '搜索 TB 项目失败: ' + e.message + detail,
            statusCode: e.statusCode || null
          });
        });
      return;
    }

    /* GET /api/tb/projectSummary — 拉取单个 TB 项目概要（项目名/编码/进行中迭代/任务完成率）
       query: projectId（必填，24 位十六进制）
       只读、手动触发，不写库；子项失败不阻断，原因在 errors 里 */
    if (sub === '/projectSummary' && req.method === 'GET') {
      const cred = readCredentials();
      if (cred.mode === 'none') {
        return sendJson(res, 400, { error: '未配置 TB 凭据，无法拉取项目概要。' });
      }
      const q = u.query || {};
      const projectId = String(q.projectId || '').trim();
      if (!/^[0-9a-fA-F]{24}$/.test(projectId)) {
        return sendJson(res, 400, { error: 'projectId 非法（应为 24 位十六进制）。' });
      }
      tbSync.syncProjectSummary(projectId, cred)
        .then(summary => sendJson(res, 200, { ok: true, summary: summary }))
        .catch(e => {
          const detail = e.body ? (' | ' + JSON.stringify(e.body).slice(0, 300)) : '';
          return sendJson(res, 502, {
            error: '拉取 TB 项目概要失败: ' + e.message + detail,
            statusCode: e.statusCode || null
          });
        });
      return;
    }

    /* GET /api/tb/status — 上次同步统计 */
    if (sub === '/status' && req.method === 'GET') {
      try {
        return sendJson(res, 200, JSON.parse(fs.readFileSync(TB_STATE_FILE, 'utf8')));
      } catch (e) {
        return sendJson(res, 200, { lastSync: null, stats: null });
      }
    }

    /* POST /api/tb/sync — 触发同步
       body: { boardOverrides?: { cloud:{sprintId}, middle:{sprintId}, productLine:{sprintIds} },
               sprintMap?: { sprintId: 迭代名 }, by?: string } */
    if (sub === '/sync' && req.method === 'POST') {
      const cred = readCredentials();
      if (cred.mode === 'none') {
        return sendJson(res, 400, {
          error: '未配置 TB 凭据。请在服务器 data/tb/secret.json 填入 appId/appSecret/tenantId/operatorId（应用凭据），或填入 token（User Token）后重启服务。'
        });
      }
      readBody(req, 1 * 1024 * 1024, async (body) => {
        let incoming = {};
        if (body) {
          try { incoming = JSON.parse(body); }
          catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        }
        try {
          // 迭代映射：优先取请求体传入，否则回退到 state 里已存的 tbSprintMap
          const sprintMap = Object.assign({}, readSprintMap(), incoming.sprintMap || {});
          const result = await tbSync.syncAll(cred, incoming.boardOverrides || {}, sprintMap);
          const rev = applySyncToState(result, incoming.by, sprintMap, incoming.tbBoardSprints);

          // 落盘同步状态
          const status = {
            lastSync: new Date().toLocaleString('zh-CN'),
            by: String(incoming.by || 'TB同步').slice(0, 40),
            iterationRev: rev,
            stats: result.stats
          };
          try { writeJsonAtomic(TB_STATE_FILE, status); } catch (e) { /* 忽略 */ }

          audit.log({
            user: status.by, module: 'tb', action: 'TB自动同步',
            details: `云${result.stats.cloud.taskCount}任务/中后台${result.stats.middle.taskCount}任务/产品线${result.stats.productLine.taskCount}任务 → iteration rev ${rev}`
          });

          return sendJson(res, 200, { ok: true, iterationRev: rev, stats: result.stats });
        } catch (e) {
          const detail = e.body ? (' | ' + JSON.stringify(e.body).slice(0, 300)) : '';
          return sendJson(res, 502, {
            error: 'TB 同步失败: ' + e.message + detail,
            statusCode: e.statusCode || null
          });
        }
      });
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  },

  readToken,
  readCredentials,
  hasCredentials,
  readSprintMap,
  applySyncToState
};
