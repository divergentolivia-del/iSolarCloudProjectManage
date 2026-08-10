/* modules/iteration/routes.js — 迭代模块服务端路由
   处理 /api/iteration/state 的 GET/POST 请求。
   数据存储于 data/iteration/state.json 和 data/iteration/history/。
   同时提供归档路由 /api/iteration/archive/*（复用 archive.js 模块）。
*/

'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');

/* 数据目录配置 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');
const ITER_DIR = path.join(DATA_DIR, 'iteration');
const STATE_FILE = path.join(ITER_DIR, 'state.json');
const HISTORY_DIR = path.join(ITER_DIR, 'history');

/* 归档模块复用 */
const archiveMod = require('../../archive');

/* 审计日志 */
const audit = require('../../audit');

/* 加载 compute 函数（需要全局 config 已加载） */
const { compute } = require('../../calc');

/* ---------- 空状态模板 ---------- */
const EMPTY_STATE = {
  cycles: [{ name: '方案一', seal: '', online: '', workdays: 0, saturdays: 0, active: true, note: '' }],
  headcount: {}, locked: [], totals: [], board: [], iterations: [], sources: {},
  rev: 0, updatedAt: '', updatedBy: ''
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
 * 读取迭代模块状态
 * 文件不存在 → 返回空态；文件损坏 → 回退历史快照
 */
function readState() {
  if (!fs.existsSync(STATE_FILE)) return JSON.parse(JSON.stringify(EMPTY_STATE));
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('[iteration] state.json 解析失败: ' + e.message + '，尝试回退快照');
    const snap = latestSnapshot();
    if (snap) {
      console.error('[iteration]   已回退到快照: ' + snap.name);
      return snap.data;
    }
    console.error('[iteration]   无可用快照，返回空态');
    try { fs.copyFileSync(STATE_FILE, STATE_FILE + '.broken'); } catch (x) { }
    return JSON.parse(JSON.stringify(EMPTY_STATE));
  }
}

/**
 * 取 history 中 rev 最大且能正常解析的快照
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
      } catch (e) { /* 这份也坏了，试下一份 */ }
    }
  } catch (e) { }
  return null;
}

/**
 * 原子写入状态文件
 */
function writeState(s) {
  ensureDir(ITER_DIR);
  ensureDir(HISTORY_DIR);
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
    const c = (s.cycles || []).find(x => x.active) || {};
    const tag = String(c.online || 'unnamed').replace(/[^\w.-]/g, '_');
    const name = tag + '-rev' + s.rev + '.json';
    fs.writeFileSync(path.join(HISTORY_DIR, name), JSON.stringify(s), 'utf8');
  } catch (e) { /* 归档失败不影响主流程 */ }
}

/* ---------- 模块导出 ---------- */

module.exports = {
  id: 'iteration',
  prefix: '/api/iteration',

  /**
   * ensureData() — 确保迭代模块数据目录存在
   */
  ensureData() {
    ensureDir(ITER_DIR);
    ensureDir(HISTORY_DIR);
  },

  /**
   * handle(req, res, parsedUrl) — 路由处理
   * 处理：
   *   GET  /api/iteration/state
   *   POST /api/iteration/state
   *   GET  /api/iteration/archive/list
   *   POST /api/iteration/archive
   *   POST /api/iteration/archive/init-next
   *   GET  /api/iteration/archive/:id
   *   DELETE /api/iteration/archive/:id
   */
  handle(req, res, u) {
    const pathname = u.pathname || '';
    const sub = pathname.replace('/api/iteration', '');

    // GET /api/iteration/state — 读取当前迭代状态
    if (sub === '/state' && req.method === 'GET') {
      return sendJson(res, 200, readState());
    }

    // POST /api/iteration/state — 提交迭代状态变更（乐观锁）
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

        // 乐观锁：客户端基于的版本比服务端旧时拒绝
        if (isFinite(baseRev) && baseRev < curRev) {
          return sendJson(res, 409, {
            error: '数据已被他人更新', currentRev: cur.rev, state: cur
          });
        }

        const next = incoming.state || {};
        next.rev = Math.max(curRev, isFinite(baseRev) ? baseRev : 0) + 1;
        next.updatedAt = new Date().toLocaleString('zh-CN');
        next.updatedBy = String(incoming.by || '未署名').slice(0, 40);

        try { writeState(next); }
        catch (e) { return sendJson(res, 500, { error: '写入失败: ' + e.message }); }

        saveHistory(next);

        // 广播通知（通过全局 broadcast，如果可用）
        if (typeof global._broadcast === 'function') {
          global._broadcast(next.rev, next.updatedBy);
        }

        audit.log({ user: next.updatedBy, module: 'iteration', action: '更新数据', details: 'rev ' + next.rev });
        sendJson(res, 200, { ok: true, rev: next.rev, updatedAt: next.updatedAt });
      });
      return;
    }

    // GET /api/iteration/archive/list — 归档列表
    if (sub === '/archive/list' && req.method === 'GET') {
      return sendJson(res, 200, archiveMod.listArchives());
    }

    // POST /api/iteration/archive — 创建归档
    if (sub === '/archive' && req.method === 'POST') {
      let body = '';
      req.on('data', c => {
        body += c;
        if (body.length > 2 * 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        let incoming;
        try { incoming = JSON.parse(body); }
        catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }

        const state = readState();
        const computeResult = compute(state);
        const result = archiveMod.createArchive(state, {
          name: incoming.name || '',
          note: incoming.note || '',
          archivedBy: incoming.archivedBy || '未署名'
        }, computeResult);

        if (result.error) return sendJson(res, 409, result);

        // 广播归档事件
        if (typeof global._broadcast === 'function') {
          global._broadcast(state.rev, `${incoming.archivedBy || '未署名'}(归档)`);
        }
        return sendJson(res, 200, result);
      });
      return;
    }

    // POST /api/iteration/archive/init-next — 初始化下一迭代
    if (sub === '/archive/init-next' && req.method === 'POST') {
      const state = readState();
      const newState = archiveMod.initNextIteration(state);

      try { writeState(newState); }
      catch (e) { return sendJson(res, 500, { error: '写入失败: ' + e.message }); }

      saveHistory(newState);

      if (typeof global._broadcast === 'function') {
        global._broadcast(newState.rev, '系统(初始化新迭代)');
      }

      return sendJson(res, 200, {
        ok: true,
        cleared: ['totals', 'board', 'iterations'],
        preserved: ['cycles', 'headcount', 'locked'],
        newRev: newState.rev
      });
    }

    // GET /api/iteration/archive/:id — 单条归档详情
    if (/^\/archive\/[\w.\-]+$/.test(sub) && req.method === 'GET') {
      const id = sub.split('/').pop();
      if (id === 'list' || id === 'init-next') {
        return sendJson(res, 404, { error: 'Not Found' });
      }
      if (id.includes('..') || id.includes('/')) {
        return sendJson(res, 400, { error: '无效的归档 ID' });
      }
      const data = archiveMod.getArchive(id);
      if (!data) return sendJson(res, 404, { error: '归档不存在' });
      return sendJson(res, 200, data);
    }

    // DELETE /api/iteration/archive/:id — 删除归档
    if (/^\/archive\/[\w.\-]+$/.test(sub) && req.method === 'DELETE') {
      const id = sub.split('/').pop();
      if (id.includes('..') || id.includes('/')) {
        return sendJson(res, 400, { error: '无效的归档 ID' });
      }
      const result = archiveMod.deleteArchive(id);
      if (result.error) return sendJson(res, 404, result);
      return sendJson(res, 200, result);
    }

    // 未匹配到任何路由
    sendJson(res, 404, { error: 'Not Found' });
  },

  /* 暴露 readState 和 compute 供外部（如 dashboard aggregation）使用 */
  readState,
  compute
};
