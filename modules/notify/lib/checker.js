/* modules/notify/lib/checker.js — 主动推送 + 智能提醒的业务核心
 *
 * 两类检查：
 *   1. 高严重度推送（checkHighSeverity）
 *      扫描 skill 引擎的全部留存结果（data/skill/state.json），
 *      把 status=pending 且 severity 命中配置的待确认项推送到群。
 *      同一条目只推一次（itemId 去重，状态存 data/notify/state.json）。
 *   2. 智能提醒（checkReminders）
 *      迭代封版（cycle.seal）/ 上线（cycle.online）/ 里程碑（plan.due）
 *      倒计时命中阈值时提醒一次（按 key 去重，如 seal:10.26:7）。
 *      群消息全员可见；若配置了 agentId，还给团队负责人（headcount.owner）
 *      发工作通知（姓名 → org.json 的 userId 映射）。
 *
 * 推送降级策略：
 *   未配置 groupChatId 时，待推送内容写入 data/notify/outbox.json，
 *   配置好后下一次检查自动补发（或 POST /api/notify/outbox/flush 手动补发）。
 *   任何推送失败都不抛异常 —— 推送是锦上添花，不能拖垮检查主流程。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const pusher = require('./pusher');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const SKILL_STATE = path.join(DATA_DIR, 'skill', 'state.json');
const ITER_STATE = path.join(DATA_DIR, 'iteration', 'state.json');
const PLAN_STATE = path.join(DATA_DIR, 'plan', 'state.json');
const ORG_FILE = path.join(DATA_DIR, 'dingtalk', 'org.json');
const NOTIFY_STATE = path.join(DATA_DIR, 'notify', 'state.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'notify', 'outbox.json');

/* 严重度别名（历史数据里混过中文，这里统一收敛） */
const SEV_ALIAS = { '高': 'high', '中': 'medium', '低': 'low', high: 'high', medium: 'medium', low: 'low', critical: 'high' };
function sevOf(v) {
  const k = String(v == null ? '' : v).trim().toLowerCase();
  return SEV_ALIAS[k] || SEV_ALIAS[v] || 'medium';
}

/* ---------- 数据存取（全部容错，文件缺失/损坏按空处理） ---------- */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) { return false; }
}

function notifyState() {
  return readJson(NOTIFY_STATE, { pushed: {}, reminded: {}, lastCheckAt: '', lastSummary: null });
}

function saveNotifyState(s) {
  s.lastCheckAt = new Date().toISOString();
  writeJson(NOTIFY_STATE, s);
}

/* ---------- 待发队列（未配置群时的降级落点） ---------- */

function outbox() {
  return readJson(OUTBOX_FILE, []);
}

function pushOutbox(entry) {
  const q = outbox();
  q.push(Object.assign({ at: new Date().toISOString() }, entry));
  writeJson(OUTBOX_FILE, q);
}

function clearOutbox() {
  writeJson(OUTBOX_FILE, []);
}

/* ---------- 消息构造 ---------- */

function inboxHint() {
  return '（在平台「今日待确认」中查看并确认：登录系统 → 今日待确认）';
}

/** 高严重度条目 → 消息文本 */
function buildHighSeverityText(skillName, items, prefix) {
  const lines = [];
  lines.push(prefix + ' 风险识别｜高严重度项 ' + items.length + ' 条');
  items.forEach((it, i) => {
    lines.push('');
    lines.push((i + 1) + '. ' + it.title);
    if (it.detail) lines.push('   证据：' + it.detail);
    if (it.action) lines.push('   建议：' + it.action);
  });
  lines.push('');
  lines.push(inboxHint());
  return lines.join('\n');
}

/** 提醒消息文本 */
function buildReminderText(kind, title, lines) {
  const out = [];
  out.push(kind + ' ' + title);
  (lines || []).forEach(l => out.push(l));
  out.push('');
  out.push(inboxHint());
  return out.join('\n');
}

/* ---------- 检查 1：高严重度推送 ---------- */

/**
 * 扫描 skill 结果，推送未推送过的高严重度待确认项。
 * @returns {Promise<{newItems:number, pushed:number, queued:number, skipped:number}>}
 */
async function checkHighSeverity() {
  const cfg = pusher.readConfig();
  const st = readJson(SKILL_STATE, { results: [], stats: {} });
  const ns = notifyState();
  const wanted = cfg.highSeverity && cfg.highSeverity.severities
    ? cfg.highSeverity.severities.map(s => String(s).toLowerCase())
    : ['high'];
  const maxPerRun = (cfg.highSeverity && cfg.highSeverity.maxPerRun) || 8;

  /* 按 skill 分组收集新条目（保持 engine 结果顺序） */
  const fresh = [];
  for (const r of (st.results || [])) {
    for (const it of (r.items || [])) {
      if (it.status !== 'pending') continue;
      if (!wanted.includes(sevOf(it.severity))) continue;
      if (ns.pushed[it.itemId]) continue; // 已推送过
      fresh.push({ item: it, result: r });
    }
  }
  if (!fresh.length) return { newItems: 0, pushed: 0, queued: 0, skipped: 0 };

  /* 按 resultId 聚合 → 每条 result 一条消息（同批同推） */
  const byResult = new Map();
  for (const f of fresh) {
    if (!byResult.has(f.result.resultId)) byResult.set(f.result.resultId, []);
    byResult.get(f.result.resultId).push(f.item);
  }

  let pushed = 0, queued = 0, skipped = 0;
  let index = 0;
  for (const [resultId, items] of byResult) {
    if (index >= maxPerRun) { skipped += items.length; continue; }
    index += items.length;
    const skill = (items[0] && items[0].skill) || 'risk';
    const text = buildHighSeverityText(skill, items, '⚠️');
    if (pusher.groupReady()) {
      const r = await pusher.sendGroupText(text);
      if (r.ok) pushed += items.length;
      else {
        pushOutbox({ kind: 'highSeverity', resultId, skill, items, text, error: r.error });
        queued += items.length;
      }
    } else {
      pushOutbox({ kind: 'highSeverity', resultId, skill, items, text, error: '未配置 groupChatId' });
      queued += items.length;
    }
    for (const it of items) ns.pushed[it.itemId] = new Date().toISOString();
  }

  saveNotifyState(ns);
  return { newItems: fresh.length, pushed, queued, skipped };
}

/* ---------- 检查 2：智能提醒 ---------- */

/** '10.26' → 最近的该日期 Date（跨年：今天之后的今年，否则明年） */
function parseMD(v) {
  const m = /^(\d{1,2})\.(\d{1,2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const now = new Date();
  const month = Number(m[1]) - 1;
  const day = Number(m[2]);
  let d = new Date(now.getFullYear(), month, day);
  if (d.getTime() < now.getTime() - 86400000) d = new Date(now.getFullYear() + 1, month, day);
  return d;
}

/** 距今整天数（负数=已过） */
function daysUntil(date) {
  if (!date) return null;
  const now = new Date();
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const b = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((b - a) / 86400000);
}

/** headcount.owner '王亚-2026-08-17 14:24' → '王亚' */
function ownerName(owner) {
  const s = String(owner || '').trim();
  if (!s) return '';
  return s.split('-')[0].trim();
}

/** 姓名 → 钉钉 userId（org.json 快照；无快照或查不到返回空） */
function userIdOf(name) {
  if (!name) return '';
  const org = readJson(ORG_FILE, { users: [] });
  const u = (org.users || []).find(x => x && x.name === name && x.active !== false);
  return u ? u.userId : '';
}

/** 迭代团队 → 责任人 userId 列表（headcount.owner 姓名映射） */
function teamOwnerUserIds() {
  const iter = readJson(ITER_STATE, { headcount: {} });
  const ids = new Set();
  for (const team of Object.keys(iter.headcount || {})) {
    const uid = userIdOf(ownerName(iter.headcount[team].owner));
    if (uid) ids.add(uid);
  }
  return Array.from(ids);
}

/**
 * 封版/上线/里程碑倒计时提醒。
 * @returns {Promise<{reminded:Array, queued:number, pushed:number}>}
 */
async function checkReminders() {
  const cfg = pusher.readConfig();
  const rm = (cfg.reminders && cfg.reminders.on !== false) ? cfg.reminders : null;
  if (!rm) return { reminded: [], queued: 0, pushed: 0 };

  const iter = readJson(ITER_STATE, { cycles: [], headcount: {} });
  const plan = readJson(PLAN_STATE, { plans: [] });
  const ns = notifyState();
  const targets = [];

  /* 迭代封版 / 上线 */
  const cycle = (iter.cycles || []).find(c => c.active) || (iter.cycles || [])[0];
  if (cycle) {
    const seal = parseMD(cycle.seal);
    const online = parseMD(cycle.online);
    if (seal) {
      const d = daysUntil(seal);
      if (d !== null && (rm.sealDays || []).includes(d)) {
        targets.push({ key: 'seal:' + cycle.name + ':' + d, title: '封版提醒｜' + cycle.name, lines: [
          '距封版仅 ' + d + ' 天（封版日：' + cycle.seal + '）',
          '上线日：' + (cycle.online || '未定'),
          '请各团队确认交付物状态，未完成的排期尽早暴露'
        ], ownerTarget: true });
      }
    }
    if (online) {
      const d = daysUntil(online);
      if (d !== null && (rm.onlineDays || []).includes(d)) {
        targets.push({ key: 'online:' + cycle.name + ':' + d, title: '上线提醒｜' + cycle.name, lines: [
          '距上线仅 ' + d + ' 天（上线日：' + cycle.online + '）',
          '封版后遗留问题请提前安排回归验证'
        ], ownerTarget: true });
      }
    }
  }

  /* 里程碑（plan.due） */
  for (const p of (plan.plans || [])) {
    if (!p || !p.due) continue;
    const d = daysUntil(new Date(String(p.due).slice(0, 10) + 'T00:00:00'));
    if (d === null) continue;
    if ((rm.dueDays || []).includes(d)) {
      targets.push({ key: 'due:' + (p.id || p.title) + ':' + d, title: '里程碑提醒｜' + (p.title || p.id), lines: [
        '「' + (p.title || p.id) + '」' + (d === 0 ? '今天到期' : '还有 ' + d + ' 天到期'),
        '到期日：' + String(p.due).slice(0, 10)
      ], ownerTarget: false });
    }
  }

  /* 去重 + 推送 */
  const reminded = [];
  let queued = 0, pushed = 0;
  for (const t of targets) {
    if (ns.reminded[t.key]) continue; // 同一天同一件事只提醒一次
    const text = buildReminderText('📌', t.title, t.lines);

    /* 群消息 */
    if (pusher.groupReady()) {
      const r = await pusher.sendGroupText(text);
      if (r.ok) pushed++;
      else { pushOutbox({ kind: 'reminder', key: t.key, title: t.title, text, error: r.error }); queued++; }
    } else {
      pushOutbox({ kind: 'reminder', key: t.key, title: t.title, text, error: '未配置 groupChatId' });
      queued++;
    }

    /* 单聊：给团队负责人发。有 agentId 用工作通知（更正式），否则机器人单聊 */
    if (t.ownerTarget) {
      const uids = teamOwnerUserIds();
      if (uids.length) {
        let r;
        if (pusher.workNoticeReady()) r = await pusher.sendWorkNotice(uids, text);
        else r = await pusher.sendUserText(uids, text);
        if (!r.ok) pushOutbox({ kind: 'workNotice', key: t.key, userIds: uids, text, error: r.error });
      }
    }

    ns.reminded[t.key] = new Date().toISOString();
    reminded.push({ key: t.key, title: t.title, days: t.lines[0] });
  }
  if (reminded.length) saveNotifyState(ns);
  return { reminded, queued, pushed };
}

/* ---------- 手动单点发送 ---------- */

/**
 * 按姓名（支持多个，用英文逗号/中文顿号/空格分隔）解析钉钉 userId。
 * @returns {{found:Array, missing:Array}}
 */
function resolveUsers(namesText) {
  const names = String(namesText || '')
    .split(/[,，、\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const org = readJson(ORG_FILE, { users: [] });
  const found = [];
  const missing = [];
  for (const name of names) {
    const u = (org.users || []).find(x => x && x.name === name && x.active !== false);
    if (u) found.push({ name, userId: u.userId, dept: u.deptName || '' });
    else missing.push(name);
  }
  return { found, missing };
}

/**
 * 给指定姓名的人发一条消息（机器人单聊）。
 * @returns {Promise<{ok:boolean, sent:number, missing:Array, error?:string}>}
 */
async function sendToUsers(namesText, text) {
  const { found, missing } = resolveUsers(namesText);
  if (!found.length) return { ok: false, sent: 0, missing, error: '没有匹配到可发送的人' };
  const r = await pusher.sendUserText(found.map(f => f.userId), text);
  return { ok: r.ok, sent: r.ok ? found.length : 0, missing, error: r.ok ? '' : r.error };
}

/* ---------- 对外：一次完整检查 ---------- */

/**
 * 执行一次完整检查（高严重度 + 智能提醒）。
 * @returns {Promise<object>} 汇总结果
 */
async function checkAll() {
  const cfg = pusher.readConfig();
  const hs = await checkHighSeverity();
  const rm = await checkReminders();
  const summary = {
    at: new Date().toISOString(),
    config: {
      enabled: cfg.enabled,
      groupReady: pusher.groupReady(),
      workNoticeReady: pusher.workNoticeReady()
    },
    highSeverity: hs,
    reminders: rm
  };
  const ns = notifyState();
  ns.lastSummary = summary;
  saveNotifyState(ns);
  return summary;
}

/* ---------- 待发队列补发 ---------- */

/**
 * 把 outbox 里的待发消息推送出去（配置好 groupChatId 后调用）。
 * @returns {Promise<{flushed:number, failed:Array}>}
 */
async function flushOutbox() {
  const q = outbox();
  if (!q.length) return { flushed: 0, failed: [] };
  const remaining = [];
  let flushed = 0;
  const failed = [];
  for (const entry of q) {
    if (entry.kind === 'workNotice') {
      if (pusher.workNoticeReady()) {
        const r = await pusher.sendWorkNotice(entry.userIds || [], entry.text);
        if (r.ok) flushed++; else { entry.error = r.error; remaining.push(entry); failed.push(entry); }
      } else { remaining.push(entry); failed.push(entry); }
      continue;
    }
    if (pusher.groupReady()) {
      const r = await pusher.sendGroupText(entry.text);
      if (r.ok) flushed++; else { entry.error = r.error; remaining.push(entry); failed.push(entry); }
    } else { remaining.push(entry); failed.push(entry); }
  }
  writeJson(OUTBOX_FILE, remaining);
  return { flushed, failed: failed.map(f => ({ kind: f.kind, key: f.key || f.resultId, error: f.error })) };
}

module.exports = {
  checkAll, checkHighSeverity, checkReminders, flushOutbox,
  outbox, notifyState, resolveUsers, sendToUsers,
  _internal: { parseMD, daysUntil, ownerName, userIdOf, teamOwnerUserIds, sevOf }
};