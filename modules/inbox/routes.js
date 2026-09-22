/* modules/inbox/routes.js — 「今日待确认」聚合入口（M2 收口）
   端点（权限资源：inbox）：
     GET  /api/inbox          → 全局待确认项聚合 + 各 Skill 状态（inbox:read）
     POST /api/inbox/confirm  → 确认/驳回 {resultId, itemId, yes}（inbox:write）

   为什么单独做这一个入口：
     路线图里 AI 的输出形态是「一个需要人点确认的待办」，不是「一堆需要人去读的报告」。
     skill 模块自己的 /api/skill 是「按 Skill 看」，用户得挨个 Skill 点进去才知道有没有事。
     这个入口反过来：跨 Skill 把所有 status=pending 的项拉平到一处，按严重度排序，
     打开就是「今天要你拍板的 N 件事」——这才是 AI PMO 真正的落地形态。

   写入一律走 skill 引擎的 confirm()，不另起一套：
     采纳率（adoptRate）是唯一的诚实指标，分母必须只有一处维护。 */

'use strict';

const engine = require('../skill/lib/engine');

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

/* 严重度排序权重：高的先露头。
   这里的 high/medium/low 是引擎 normalizeItems 收敛后的 canonical 值，
   不是各 Skill 的原始输出（risk.js 内部仍写中文，引擎统一翻译）。
   未知值排最后但不丢项 —— 宁可排得难看，也不能让一条待办消失。 */
const SEVERITY_WEIGHT = { high: 0, medium: 1, low: 2 };

/* 把单个 Skill 的结果拉平成候选待确认项。
   只取每个 Skill 的【最近一次结果】——引擎在重跑时会把旧结果的 pending 标为 expired，
   所以同一 Skill 理论上不会有两批 pending；这里仍以 latest 为准，避免历史残留混入。 */
function pendingOf(skillId) {
  const r = engine.latest(skillId);
  if (!r) return { result: null, items: [] };
  const items = (r.items || [])
    .filter(i => i.status === 'pending')
    .map(i => ({
      resultId: r.resultId,
      skill: r.skill,
      skillName: SKILL_NAME[r.skill] || r.skill,
      itemId: i.itemId,
      title: i.title || '',
      detail: i.detail || '',
      action: i.action || '',
      severity: i.severity || 'medium',
      createdAt: i.createdAt || r.at || ''
    }));
  return { result: r, items };
}

/* Skill 中文名。引擎的 meta 里已经有一份，但这里要的是「没数据时也能显示名字」，
   否则空列表下整页看不出这个平台到底有哪些 AI 能力。 */
const SKILL_NAME = {
  risk: '风险识别器',
  report: '周报生成器',
  variance: '偏差分析器'
};

function handle(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/inbox') {
    const skills = engine.listSkills();
    const all = [];
    const bySkill = [];

    for (const s of skills) {
      const { items } = pendingOf(s.id);
      all.push(...items);
      bySkill.push({
        id: s.id,
        name: SKILL_NAME[s.id] || s.name || s.id,
        desc: s.desc || '',
        pendingCount: items.length,
        runs: (s.stats || {}).runCount || 0,
        adopted: (s.stats || {}).adoptCount || 0,
        rejected: (s.stats || {}).rejectCount || 0,
        adoptRate: (s.stats || {}).adoptRate,
        lastAt: (s.stats || {}).lastAt || null
      });
    }

    /* 排序：先严重度，再时间倒序（新的在前）。
       同严重度时新的在前，是因为「今天新冒出来的」比「躺了三天的」更该先看。 */
    all.sort((a, b) => {
      const wa = SEVERITY_WEIGHT[a.severity], wb = SEVERITY_WEIGHT[b.severity];
      const da = wa === undefined ? 9 : wa, db_ = wb === undefined ? 9 : wb;
      if (da !== db_) return da - db_;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

    const high = all.filter(i => i.severity === 'high').length;
    const totalAdopt = bySkill.reduce((a, s) => a + s.adopted, 0);
    const totalReject = bySkill.reduce((a, s) => a + s.rejected, 0);
    const confirmed = totalAdopt + totalReject;

    return sendJson(res, 200, {
      items: all,
      total: all.length,
      high: high,
      bySkill: bySkill,
      adoptRate: confirmed > 0 ? Math.round(100 * totalAdopt / confirmed) : null,
      generatedAt: new Date().toISOString()
    });
  }

  if (p === '/api/inbox/confirm' && method === 'POST') {
    return readBody(req, res).then(body => {
      const { resultId, itemId, yes } = body;
      if (!resultId || !itemId) return sendJson(res, 400, { error: '需要 resultId 和 itemId' });

      /* 操作人姓名：审计要记到人。取不到就留空，不阻断操作。 */
      let who = '';
      try {
        const auth = require('../auth/routes');
        const me = auth.currentUser(req);
        who = me ? me.name : '';
      } catch (e) { /* 无 auth 模块时匿名 */ }

      const r = engine.confirm(resultId, itemId, !!yes, who);
      if (!r.ok) return sendJson(res, 404, { error: r.error });

      try {
        const db = require('../../db');
        db.logAudit({
          user_id: '', user: who, module: 'inbox',
          action: yes ? '采纳' : '驳回',
          details: resultId + ' / ' + itemId
        });
      } catch (e) { /* 审计失败不影响主流程 */ }

      return sendJson(res, 200, r);
    });
  }

  return sendJson(res, 404, { error: '未找到 inbox 端点' });
}

module.exports = {
  id: 'inbox',
  prefix: '/api/inbox',
  resource: 'inbox',
  handle
};
