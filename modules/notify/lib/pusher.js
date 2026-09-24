/* modules/notify/lib/pusher.js — 钉钉主动推送（发送层）
 *
 * 与 modules/dingtalk/client.js 的分工：
 *   client.js 是【只读】通讯录层，注释明确"写操作一律不在这里做"；
 *   本文件是【写操作】的唯一入口 —— 发群消息 / 发工作通知。
 *
 * 两套接口（沿用 client.js 的域名约定，别混）：
 *   群消息    POST https://api.dingtalk.com/v1.0/robot/groupMessages/send
 *             token 放请求头 x-acs-dingtalk-access-token
 *   工作通知  POST https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2
 *             token 放 query ?access_token=xxx
 *
 * 配置：
 *   data/notify/config.json   — groupChatId / agentId / enabled
 *   data/dingtalk/secret.json — appKey / appSecret（复用 client.js 的 getToken）
 *
 * 所有发送失败都【不抛异常】，返回 { ok:false, error } 由调用方决定
 * 是否入待发队列 —— 推送是锦上添花，绝不能因为推送故障拖垮主流程。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const dt = require('../../dingtalk/client');

const API = 'https://api.dingtalk.com';
const OAPI = 'https://oapi.dingtalk.com';

const CONFIG_FILE = path.join(__dirname, '..', '..', '..', 'data', 'notify', 'config.json');
const SECRET_FILE = path.join(__dirname, '..', '..', '..', 'data', 'dingtalk', 'secret.json');

const TEXT_MAX = 1800; // 钉钉单条文本消息上限约 2000 字符，留余量按行切段

const BATCH_MAX = 100; // 机器人单聊单次最多 100 个 userId

/* ---------- 配置 ---------- */

function readConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { /* 缺省 */ }
  const def = {
    enabled: true,
    groupChatId: '',
    agentId: '',
    highSeverity: { on: true, severities: ['high'], maxPerRun: 8 },
    reminders: { on: true, sealDays: [7, 3, 1], onlineDays: [3, 1], dueDays: [3, 1] },
    schedule: { intervalMinutes: 60, startupDelaySeconds: 45 }
  };
  return {
    enabled: file.enabled !== false,
    groupChatId: String(file.groupChatId || '').trim(),
    agentId: String(file.agentId || '').trim(),
    highSeverity: Object.assign({}, def.highSeverity, file.highSeverity || {}),
    reminders: Object.assign({}, def.reminders, file.reminders || {}),
    schedule: Object.assign({}, def.schedule, file.schedule || {})
  };
}

function readSecret() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')); } catch (e) { /* 只走环境变量 */ }
  return file;
}

/** 机器人 RobotCode：secret 里的 robotCode > appKey（钉钉默认两者相同） */
function robotCode() {
  const secret = readSecret();
  return secret.robotCode || secret.appKey || '';
}

/** 目标群是否已配置（能真正发群消息） */
function groupReady() {
  const cfg = readConfig();
  return cfg.enabled && !!cfg.groupChatId;
}

/** 工作通知是否已配置（有 agentId 才发责任人单聊） */
function workNoticeReady() {
  const cfg = readConfig();
  return cfg.enabled && !!cfg.agentId;
}

/* ---------- 文本处理 ---------- */

/** 长文本按行切段，每段不超过 TEXT_MAX 字符（钉钉文本消息长度限制）；单行超长时硬切 */
function splitText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const parts = [];
  let cur = '';
  for (const line of lines) {
    if (line.length > TEXT_MAX) {
      if (cur) { parts.push(cur); cur = ''; }
      for (let i = 0; i < line.length; i += TEXT_MAX) parts.push(line.slice(i, i + TEXT_MAX));
      continue;
    }
    if (cur && cur.length + line.length + 1 > TEXT_MAX) {
      parts.push(cur);
      cur = line;
    } else {
      cur = cur ? cur + '\n' + line : line;
    }
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [''];
}

/* ---------- 发送 ---------- */

/**
 * 发群消息（企业内部应用机器人 → 群）。
 * @returns {Promise<{ok:boolean, error?:string, detail?:object}>}
 */
async function sendGroupText(text) {
  const cfg = readConfig();
  if (!cfg.enabled) return { ok: false, error: '推送未启用（config.enabled=false）' };
  if (!cfg.groupChatId) return { ok: false, error: '未配置 groupChatId，已跳过推送' };

  let token;
  try {
    token = await dt.getToken();
  } catch (e) {
    return { ok: false, error: '取 token 失败：' + (e && e.message || e) };
  }

  const code = robotCode();

  const parts = splitText(text);
  const sent = [];
  for (const part of parts) {
    const r = await dt.req('POST', API + '/v1.0/robot/groupMessages/send', {
      token,
      body: {
        robotCode: code,
        openConversationId: cfg.groupChatId,
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: part })
      }
    });
    if (r.status >= 200 && r.status < 300 && r.json && !r.json.errorCode) {
      sent.push(r.json);
    } else {
      return {
        ok: false,
        error: '群消息发送失败（HTTP ' + r.status + '）：' + JSON.stringify(r.json || r.text).slice(0, 300),
        sent: sent.length
      };
    }
  }
  return { ok: true, sent: sent.length, detail: sent };
}

/**
 * 机器人单聊（企业内部应用机器人 → 指定员工）。
 * 走新版接口 /v1.0/robot/oToMessages/batchSend，只需 robotCode（=appKey），
 * 不需要 agentId —— 「给单点某个人发消息」的默认通道。
 * @returns {Promise<{ok:boolean, error?:string, detail?:object}>}
 */
async function sendUserText(userIds, text) {
  const cfg = readConfig();
  if (!cfg.enabled) return { ok: false, error: '推送未启用（config.enabled=false）' };
  const ids = (userIds || []).filter(Boolean);
  if (!ids.length) return { ok: false, error: '没有可发送的 userId' };

  let token;
  try {
    token = await dt.getToken();
  } catch (e) {
    return { ok: false, error: '取 token 失败：' + (e && e.message || e) };
  }

  const code = robotCode();
  if (!code) return { ok: false, error: '缺少 robotCode / appKey' };

  const sent = [];
  for (let i = 0; i < ids.length; i += BATCH_MAX) {
    const batch = ids.slice(i, i + BATCH_MAX);
    const parts = splitText(text);
    for (const part of parts) {
      const r = await dt.req('POST', API + '/v1.0/robot/oToMessages/batchSend', {
        token,
        body: {
          robotCode: code,
          userIds: batch,
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content: part })
        }
      });
      if (r.status >= 200 && r.status < 300 && r.json && !r.json.errorCode) {
        sent.push(r.json);
      } else {
        return {
          ok: false,
          error: '单聊发送失败（HTTP ' + r.status + '）：' + JSON.stringify(r.json || r.text).slice(0, 300),
          sent: sent.length
        };
      }
    }
  }
  return { ok: true, sent: sent.length, detail: sent };
}

/**
 * 发工作通知（企业内部应用 → 指定员工单聊，需 agentId）。
 * @returns {Promise<{ok:boolean, error?:string, detail?:object}>}
 */
async function sendWorkNotice(userIds, text) {
  const cfg = readConfig();
  if (!cfg.enabled) return { ok: false, error: '推送未启用（config.enabled=false）' };
  if (!cfg.agentId) return { ok: false, error: '未配置 agentId，已跳过工作通知' };
  const ids = (userIds || []).filter(Boolean);
  if (!ids.length) return { ok: false, error: '没有可通知的 userId' };

  let token;
  try {
    token = await dt.getToken();
  } catch (e) {
    return { ok: false, error: '取 token 失败：' + (e && e.message || e) };
  }

  const parts = splitText(text);
  const sent = [];
  for (const part of parts) {
    const r = await dt.req('POST', OAPI + '/topapi/message/corpconversation/asyncsend_v2?access_token=' + encodeURIComponent(token), {
      body: {
        agent_id: Number(cfg.agentId) || cfg.agentId,
        userid_list: ids.join(','),
        msg: { msgtype: 'text', text: { content: part } }
      }
    });
    const body = r.json || {};
    if (r.status >= 200 && r.status < 300 && body.errcode === 0) {
      sent.push(body);
    } else {
      return {
        ok: false,
        error: '工作通知发送失败（HTTP ' + r.status + '，errcode=' + body.errcode + '）：' + (body.errmsg || JSON.stringify(body).slice(0, 300)),
        sent: sent.length
      };
    }
  }
  return { ok: true, sent: sent.length, detail: sent };
}

module.exports = {
  readConfig, groupReady, workNoticeReady, splitText,
  sendGroupText, sendUserText, sendWorkNotice
};