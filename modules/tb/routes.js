/* modules/tb/routes.js — Teambition 同步模块服务端路由
   端点：
     GET  /api/tb/config   — 返回看板模板元数据（团队/迭代/维度，不含 token）+ token 是否已配置
     POST /api/tb/sync     — 触发同步，写入 iteration state，返回统计
     GET  /api/tb/status   — 返回上次同步的统计（data/tb/state.json）

   ⚠️ User Token 来源优先级：环境变量 TB_TOKEN > data/tb/secret.json 的 { "token": "..." }。
      两者都不进 git。前端永远拿不到 token 明文。
*/

'use strict';

const fs = require('fs');
const path = require('path');

const tbConfig = require('../../tb-config');
const tbSync = require('./sync');
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

/** 读取 User Token：环境变量优先，其次密钥文件 */
function readToken() {
  const envTok = (process.env.TB_TOKEN || '').trim();
  if (envTok) return envTok;
  try {
    const j = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    return String(j.token || j.userToken || '').trim();
  } catch (e) {
    return '';
  }
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
function applySyncToState(result, by) {
  const s = readIterState();
  const now = new Date().toLocaleString('zh-CN');

  s._totalsCloud = result.cloudRows;
  s._totalsMiddle = result.middleRows;
  s.board = result.boardRows;
  s.totals = (s._totalsCloud || []).concat(s._totalsMiddle || []);

  s.sources = s.sources || {};
  s.sources.totals = { fileName: 'TB自动同步·' + result.stats.cloud.name, at: now, rows: result.cloudRows.length, tb: true };
  s.sources.totalsMiddle = { fileName: 'TB自动同步·' + result.stats.middle.name, at: now, rows: result.middleRows.length, tb: true };
  s.sources.board = { fileName: 'TB自动同步·' + result.stats.productLine.name, at: now, rows: result.boardRows.length, tb: true };

  rebuildIterations(s);

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
    // 若无密钥文件，写一个占位模板（不含真实 token），提醒用户填写
    if (!fs.existsSync(SECRET_FILE) && !(process.env.TB_TOKEN || '').trim()) {
      try {
        writeJsonAtomic(SECRET_FILE, {
          _comment: '把 TB User Token 填到 token 字段。本文件已 .gitignore，不会提交。也可改用环境变量 TB_TOKEN。',
          token: ''
        });
      } catch (e) { /* 忽略 */ }
    }
  },

  handle(req, res, u) {
    const pathname = u.pathname || '';
    const sub = pathname.replace('/api/tb', '');

    /* GET /api/tb/config — 看板模板元数据（脱敏，不含 token） */
    if (sub === '/config' && req.method === 'GET') {
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
        tokenConfigured: !!readToken(),
        boards: boards
      });
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
       body: { boardOverrides?: { cloud:{sprintId}, middle:{sprintId}, productLine:{sprintIds} }, by?: string } */
    if (sub === '/sync' && req.method === 'POST') {
      const token = readToken();
      if (!token) {
        return sendJson(res, 400, {
          error: '未配置 TB User Token。请在服务器 data/tb/secret.json 填入 token，或设置环境变量 TB_TOKEN 后重启服务。'
        });
      }
      readBody(req, 1 * 1024 * 1024, async (body) => {
        let incoming = {};
        if (body) {
          try { incoming = JSON.parse(body); }
          catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        }
        try {
          const result = await tbSync.syncAll(token, incoming.boardOverrides || {});
          const rev = applySyncToState(result, incoming.by);

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
  applySyncToState
};
