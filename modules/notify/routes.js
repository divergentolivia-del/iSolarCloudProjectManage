/* modules/notify/routes.js — 钉钉主动推送 + 智能提醒 API
 *
 * 端点（权限资源：notify）：
 *   GET  /api/notify/status         配置状态 + 最近检查摘要 + 待发队列（notify:read）
 *   POST /api/notify/check          立即执行一次检查（notify:write）
 *   POST /api/notify/test           试发一条测试消息到群，验证钉钉连通性（notify:write）
 *   GET  /api/notify/outbox         查看待发队列（notify:read）
 *   POST /api/notify/outbox/flush   补发待发队列（配置好 groupChatId 后调用）（notify:write）
 *   POST /api/notify/send           手动给指定人发消息（单点发送，names + text）（notify:write）
 *   GET  /api/notify/config         读取推送配置原文（notify:read）
 *   POST /api/notify/config         保存推送配置（合并写回 config.json，notify:write）
 *   GET  /api/notify/resolve        按姓名解析钉钉 userId（notify:read）
 *
 * 模块挂在 module-loader 下自动加载（modules/<id>/routes.js），
 * 不侵入 server.js —— 与 SSO/登录改造零冲突。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const checker = require('./lib/checker');
const pusher = require('./lib/pusher');
const scheduler = require('./lib/scheduler');

const CONFIG_FILE = path.join(__dirname, '..', '..', 'data', 'notify', 'config.json');

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

/** 读请求 body（JSON） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1024 * 256) reject(new Error('body 过大')); });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error('body 不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/* 允许配置页修改的字段白名单（_ 开头的说明字段一律不动） */
const CONFIG_WHITELIST = {
  enabled: v => v === true || v === false,
  groupChatId: v => typeof v === 'string',
  agentId: v => typeof v === 'string',
  highSeverity: v => v && typeof v === 'object',
  reminders: v => v && typeof v === 'object',
  schedule: v => v && typeof v === 'object'
};

function saveConfig(patch) {
  const file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  for (const k of Object.keys(patch)) {
    if (!CONFIG_WHITELIST[k]) continue;
    if (k === 'enabled') file.enabled = !!patch.enabled;
    else if (k === 'groupChatId') file.groupChatId = String(patch.groupChatId || '').trim();
    else if (k === 'agentId') file.agentId = String(patch.agentId || '').trim();
    else file[k] = Object.assign({}, file[k], patch[k]);
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(file, null, 2), 'utf8');
  return file;
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

  /* 手动单点发送：按姓名解析钉钉 userId 后发机器人单聊。
     文件头声明的端点曾漏了这一段（saveConfig / checker.sendToUsers 都写好了却没人调），
     groupChatId / agentId 只能手改 config.json —— 而那份文件是被 git 跟踪的，
     手改就等于把企业群 ID 提交进库。这里补上，配置走接口不落 git。 */
  if (method === 'POST' && p === '/api/notify/send') {
    return readBody(req).then(body => {
      const names = String(body.names || '').trim();
      const text = String(body.text || '').trim();
      if (!names) return sendJson(res, 400, { error: '需要 names（姓名，多个用逗号/顿号/空格分隔）' });
      if (!text) return sendJson(res, 400, { error: '需要 text' });
      return checker.sendToUsers(names, text).then(r => {
        if (!r.ok) {
          /* 没匹配到人时带上 missing，让前端能提示是"名字写错了"还是"发不出去" */
          return sendJson(res, 200, { ok: false, error: r.error, missing: r.missing || [], sent: 0 });
        }
        return sendJson(res, 200, { ok: true, sent: r.sent, missing: r.missing || [] });
      });
    })
      .catch(e => sendJson(res, 400, { ok: false, error: String(e && e.message || e) }));
  }

  if (method === 'GET' && p === '/api/notify/config') {
    /* 返回原文，供设置页表单回填。密钥不在这份文件里（在 data/dingtalk/secret.json），
       但仍做一次白名单过滤，避免 _ 说明字段之外的东西被前端原样回写。 */
    let file;
    try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) { return sendJson(res, 500, { ok: false, error: '读取 config.json 失败：' + (e && e.message || e) }); }
    const out = {};
    for (const k of Object.keys(CONFIG_WHITELIST)) if (k in file) out[k] = file[k];
    return sendJson(res, 200, { ok: true, config: out });
  }

  if (method === 'POST' && p === '/api/notify/config') {
    return readBody(req).then(body => {
      let saved;
      try { saved = saveConfig(body || {}); }
      catch (e) { return sendJson(res, 500, { ok: false, error: '保存 config.json 失败：' + (e && e.message || e) }); }
      /* 配置改动不重启即生效：调度和推送每次读盘（readConfig 无缓存）。
         但调度间隔是启动时算好的一次性定时器，改了 intervalMinutes 要重启才换节奏。 */
      return sendJson(res, 200, {
        ok: true,
        config: {
          enabled: saved.enabled,
          groupChatId: saved.groupChatId ? '已配置（' + String(saved.groupChatId).slice(0, 8) + '…）' : '未配置（推送将进入待发队列）',
          agentId: saved.agentId ? '已配置' : '未配置（责任人仅收群消息，不收单聊）',
          highSeverity: saved.highSeverity,
          reminders: saved.reminders,
          schedule: saved.schedule
        },
        note: '已写入 data/notify/config.json。改动立即对推送生效；改了 schedule.intervalMinutes 需重启服务才换检查节奏。'
      });
    })
      .catch(e => sendJson(res, 400, { ok: false, error: String(e && e.message || e) }));
  }

  if (method === 'GET' && p === '/api/notify/resolve') {
    const names = url.searchParams.get('names') || '';
    if (!names.trim()) return sendJson(res, 400, { error: '需要 names 查询参数' });
    const r = checker.resolveUsers(names);
    /* 查人依赖 data/dingtalk/org.json 快照。没跑过同步时 users 为空，
       所有人都会落进 missing —— 这里显式说明，免得以为名字写错了。 */
    const hasOrg = fs.existsSync(path.join(__dirname, '..', '..', 'data', 'dingtalk', 'org.json'));
    return sendJson(res, 200, {
      ok: true, found: r.found, missing: r.missing,
      hint: hasOrg ? '' : '本机还没有通讯录快照，请先跑 node dingtalk-sync.js 再试'
    });
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