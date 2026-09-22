/* modules/skill/routes.js — AI Skill 运行时 API（M2-B）
   端点（权限资源：skill）：
     GET  /api/skill              → Skill 列表 + 采纳率统计（skill:read）
     POST /api/skill/:id/run      → 运行 Skill（skill:write）
     GET  /api/skill/:id/latest   → 最近一次结果 + 待确认项（skill:read）
     POST /api/skill/confirm      → 确认/驳回 {resultId, itemId, yes}（skill:write）

   设计（master §7/§9）：输出统一为待确认项；采纳率唯一诚实指标；
   数据注入全部走脱敏口径（仓库只取统计特征）。 */

'use strict';

const engine = require('./lib/engine');

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, res) {
  return new Promise(resolve => {
    let body = '';
    let done = false;
    const finish = obj => { if (!done) { done = true; resolve(obj); } };
    req.on('data', c => {
      body += c;
      if (body.length > 65536 && !done) {
        // 超限：给前端明确的 413 报错，而不是静默断开连接
        done = true;
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: '请求体过大（上限 64KB）' }));
        }
        req.destroy();
      }
    });
    req.on('end', () => {
      if (done) return;
      try { finish(JSON.parse(body || '{}')); } catch (e) { finish({}); }
    });
    req.on('error', () => finish({}));
  });
}

function handle(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/skill') {
    return sendJson(res, 200, { skills: engine.listSkills() });
  }

  const mRun = /^\/api\/skill\/(\w+)\/run$/.exec(p);
  if (mRun && method === 'POST') {
    const r = engine.run(mRun[1]);
    if (!r.ok) return sendJson(res, 400, { error: r.error });
    return sendJson(res, 200, {
      ok: true, resultId: r.result.resultId, skill: r.result.skill,
      at: r.result.at, itemCount: r.result.items.length, expired: r.expired || 0,
      stats: (engine.listSkills().find(s => s.id === r.result.skill) || {}).stats
    });
  }

  const mLatest = /^\/api\/skill\/(\w+)\/latest$/.exec(p);
  if (mLatest && method === 'GET') {
    const r = engine.latest(mLatest[1]);
    if (!r) return sendJson(res, 200, { result: null });
    return sendJson(res, 200, { result: r });
  }

  if (p === '/api/skill/confirm' && method === 'POST') {
    return readBody(req, res).then(body => {
      const { resultId, itemId, yes } = body;
      if (!resultId || !itemId) return sendJson(res, 400, { error: '需要 resultId 和 itemId' });
      const who = '';
      try {
        const auth = require('../auth/routes');
        const me = auth.currentUser(req);
        who = me ? me.name : '';
      } catch (e) { /* 无 auth 模块时匿名 */ }
      const r = engine.confirm(resultId, itemId, !!yes, who);
      if (!r.ok) return sendJson(res, 404, { error: r.error });
      // 审计
      try {
        const db = require('../../db');
        db.logAudit({
          user_id: '', user: who, module: 'skill', action: yes ? '采纳' : '驳回',
          details: resultId + ' / ' + itemId
        });
      } catch (e) { /* ignore */ }
      return sendJson(res, 200, r);
    });
  }

  return sendJson(res, 404, { error: '未找到 skill 端点' });
}

module.exports = {
  id: 'skill',
  prefix: '/api/skill',
  resource: 'skill',
  ensureData: engine.ensureData,
  handle,
  _internal: { engine }
};