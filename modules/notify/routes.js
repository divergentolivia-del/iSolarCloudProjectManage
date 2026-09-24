/* modules/notify/routes.js — 钉钉主动推送 + 智能提醒 API
 *
 * 端点（权限资源：notify）：
 *   GET  /api/notify/status        配置状态 + 最近检查摘要 + 待发队列（notify:read）
 *   POST /api/notify/check         立即执行一次检查（notify:write）
 *   POST /api/notify/test          试发一条测试消息到群，验证钉钉连通性（notify:write）
 *   GET  /api/notify/outbox        查看待发队列（notify:read）
 *   POST /api/notify/outbox/flush  补发待发队列（配置好 groupChatId 后调用）（notify:write）
 *
 * 模块挂在 module-loader 下自动加载（modules/<id>/routes.js），
 * 不侵入 server.js —— 与 SSO/登录改造零冲突。
 */

'use strict';

const checker = require('./lib/checker');
const pusher = require('./lib/pusher');
const scheduler = require('./lib/scheduler');

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function handle(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/notify/status') {
    const cfg = pusher.readConfig();
    const ns = checker.notifyState();
    const q = checker.outbox();
    return sendJson(res, 200, {
      config: {
        enabled: cfg.enabled,
        groupChatId: cfg.groupChatId ? '已配置（' + String(cfg.groupChatId).slice(0, 8) + '…）' : '未配置（推送将进入待发队列）',
        agentId: cfg.agentId ? '已配置' : '未配置（责任人仅收群消息，不收单聊）',
        highSeverity: cfg.highSeverity,
        reminders: cfg.reminders,
        schedule: cfg.schedule
      },
      lastCheckAt: ns.lastCheckAt || null,
      lastSummary: ns.lastSummary || null,
      outbox: q.map(x => ({ kind: x.kind, key: x.key || x.resultId || '', at: x.at, error: x.error || '' })),
      outboxCount: q.length
    });
  }

  if (method === 'POST' && p === '/api/notify/check') {
    return scheduler.tick(true).then(r => {
      if (r && r.skipped) return sendJson(res, 200, { ok: true, skipped: true, message: '上一次检查未结束，本次跳过' });
      return sendJson(res, 200, { ok: true, result: r || checker.notifyState().lastSummary });
    }).catch(e => sendJson(res, 500, { ok: false, error: String(e && e.message || e) }));
  }

  if (method === 'POST' && p === '/api/notify/test') {
    return pusher.sendGroupText('✅ 这是一条来自平台「AI 推送」的测试消息。\n如果你在群里看到它，说明钉钉主动推送配置成功。')
      .then(r => {
        if (r.ok) return sendJson(res, 200, { ok: true, detail: r.detail });
        return sendJson(res, 200, { ok: false, error: r.error });
      })
      .catch(e => sendJson(res, 500, { ok: false, error: String(e && e.message || e) }));
  }

  if (method === 'GET' && p === '/api/notify/outbox') {
    const q = checker.outbox();
    return sendJson(res, 200, { count: q.length, entries: q.map(x => ({
      kind: x.kind, key: x.key || x.resultId || '', at: x.at, error: x.error || '',
      text: x.text || ''
    })) });
  }

  if (method === 'POST' && p === '/api/notify/outbox/flush') {
    return checker.flushOutbox().then(r => {
      return sendJson(res, 200, { ok: true, flushed: r.flushed, failed: r.failed });
    }).catch(e => sendJson(res, 500, { ok: false, error: String(e && e.message || e) }));
  }

  return sendJson(res, 404, { error: '未找到 notify 端点' });
}

module.exports = {
  id: 'notify',
  prefix: '/api/notify',
  resource: 'notify',
  ensureData() {
    /* 服务启动时挂定时调度（幂等） */
    try { scheduler.start(); } catch (e) { console.error('[notify] 调度启动失败：' + (e && e.message || e)); }
  },
  handle,
  _internal: { checker, pusher, scheduler }
};