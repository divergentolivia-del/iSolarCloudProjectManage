/* modules/tb/client.js — Teambition 开放接口客户端
   零依赖，仅用 Node 内置 https。

   两种认证模式（自动选择，应用凭据优先）：
     1) 应用凭据（推荐）：用 appId/appSecret 换 appToken（JWT，30 分钟），
        再带 X-Tenant-Id / X-Tenant-Type / X-Operator-Id 四件套调用业务接口。
     2) User Token（兜底）：直接 Bearer 个人令牌，不带 oapi 头。

   已验证可用的接口：
     - GET v2/all-task/search?tql=...&pageSize=...&pageToken=...
         按 TQL 查任务 id 列表，返回 { result:[任务id字符串], nextPageToken }
     - GET v3/task/query?taskId=id1,id2&fields=customfields
         批量查任务详情（customfields）
     - GET v3/project/{projectId}/sprint/search?pageSize=...&pageToken=...
         迭代列表
     - GET v3/project/query?projectIds=id1,id2 / ?name=关键字 / ?pageSize=...
         项目列表与详情（⚠️ v3/project/search 与 v3/project/{id} 都不存在，实测 421）
     - GET v3/project/{projectId}/application/list
   ⚠️ TB 恒返回 HTTP 200，业务错误在响应体 code 字段（200=ok，0=部分接口成功，
      421=MisdirectedRequest/url not found）。必须校验业务码，不能只看 HTTP 状态。
*/

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { TB_API_BASE } = require('../../tb-config');

/* 每批查详情的任务数上限（TB 对 taskId 拼接长度有限制，取保守值） */
const TASK_QUERY_BATCH = 50;
/* 任务列表分页大小 */
const SEARCH_PAGE_SIZE = 200;
/* 分页安全上限，防止意外死循环 */
const MAX_PAGES = 200;

/* 密钥文件位置（与 modules/tb/routes.js 保持一致） */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');
const SECRET_FILE = path.join(DATA_DIR, 'tb', 'secret.json');

/* ---------- 凭据读取 ---------- */

/**
 * 读取 TB 凭据。环境变量优先，其次 data/tb/secret.json。
 * 应用凭据（appId/appSecret/tenantId/operatorId）齐全时返回 app 模式，否则回退 User Token。
 */
function readCredentials() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')) || {};
  } catch (e) {
    file = {}; // 文件不存在或损坏时只依赖环境变量
  }
  const pick = (envKey, fileKey) => String(process.env[envKey] || file[fileKey] || '').trim();

  const appId = pick('TB_APP_ID', 'appId');
  const appSecret = pick('TB_APP_SECRET', 'appSecret');
  const tenantId = pick('TB_TENANT_ID', 'tenantId');
  const operatorId = pick('TB_OPERATOR_ID', 'operatorId');
  const userToken = pick('TB_TOKEN', 'token');

  if (appId && appSecret && tenantId && operatorId) {
    return { mode: 'app', appId, appSecret, tenantId, operatorId, userToken };
  }
  if (userToken) {
    return { mode: 'user', userToken, appId, appSecret, tenantId, operatorId };
  }
  return { mode: 'none' };
}

/* ---------- appToken 缓存（JWT 30 分钟有效，提前 60 秒刷新）---------- */

const TOKEN_REFRESH_MARGIN = 60; // 秒
let _cachedToken = null;         // { appId, token, expiresAt }
let _inflight = null;            // 并发去重：同时多个请求只换一次 token

/** 换 appToken。返回 { token, expire }（expire 单位秒） */
function fetchAppToken(cred) {
  return new Promise((resolve, reject) => {
    let full;
    try {
      full = new URL(TB_API_BASE.replace(/\/$/, '') + '/appToken');
    } catch (e) {
      return reject(new Error('URL 构造失败: ' + e.message));
    }
    const payload = JSON.stringify({ appId: cred.appId, appSecret: cred.appSecret });
    const opts = {
      method: 'POST',
      hostname: full.hostname,
      path: full.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'application/json'
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json;
        try { json = data ? JSON.parse(data) : {}; }
        catch (e) { return reject(new Error('appToken 响应非 JSON (HTTP ' + res.statusCode + '): ' + data.slice(0, 200))); }
        // ⚠️ token 在响应体顶层 appToken 字段，不在 result 里
        const token = json.appToken || json.appAccessToken || json.accessToken || json.token || '';
        if (!token) {
          const err = new Error('应用凭据换取 appToken 失败: ' +
            (json.errorMessage || json.message || json.errorCode || JSON.stringify(json).slice(0, 200)));
          err.statusCode = res.statusCode;
          err.body = json;
          return reject(err);
        }
        resolve({ token: token, expire: Number(json.expire || json.expiresIn || 1800) });
      });
    });
    req.on('error', (e) => reject(new Error('appToken 请求失败: ' + e.message)));
    req.setTimeout(30000, () => { req.destroy(new Error('appToken 请求超时(30s)')); });
    req.write(payload);
    req.end();
  });
}

/** 取可用 appToken（带缓存与并发去重） */
async function getAppToken(cred) {
  const now = Date.now();
  if (_cachedToken && _cachedToken.appId === cred.appId && _cachedToken.expiresAt > now) {
    return _cachedToken.token;
  }
  if (_inflight && _inflight.appId === cred.appId) return _inflight.promise;

  const promise = (async () => {
    const r = await fetchAppToken(cred);
    _cachedToken = {
      appId: cred.appId,
      token: r.token,
      expiresAt: Date.now() + Math.max(0, r.expire - TOKEN_REFRESH_MARGIN) * 1000
    };
    return r.token;
  })();
  _inflight = { appId: cred.appId, promise };
  try {
    return await promise;
  } finally {
    _inflight = null;
  }
}

/** 构造请求头。cred 为 null 时用传入的 token（兼容旧调用方式） */
async function buildHeaders(credOrToken) {
  if (typeof credOrToken === 'string' && credOrToken) {
    // 兼容：直接传令牌字符串（旧调用方式）
    return { 'Authorization': 'Bearer ' + credOrToken, 'Accept': 'application/json' };
  }
  const cred = credOrToken || readCredentials();
  if (cred.mode === 'app') {
    const token = await getAppToken(cred);
    return {
      'Authorization': 'Bearer ' + token,
      'X-Tenant-Id': cred.tenantId,
      'X-Tenant-Type': 'organization',
      'X-Operator-Id': cred.operatorId,
      'Accept': 'application/json'
    };
  }
  if (cred.mode === 'user') {
    return { 'Authorization': 'Bearer ' + cred.userToken, 'Accept': 'application/json' };
  }
  throw new Error('未配置 TB 凭据。请在 data/tb/secret.json 填 appId/appSecret/tenantId/operatorId，或设置环境变量 TB_APP_ID 等。');
}

/* ---------- 请求 ---------- */

/**
 * 发起一次 GET 请求，返回解析后的 JSON。
 * @param {string} pathAndQuery 相对 TB_API_BASE 的路径（含 query）
 * @param {object|string} [credOrToken] 凭据对象、令牌字符串；缺省则内部读取
 */
async function tbGet(pathAndQuery, credOrToken) {
  const headers = await buildHeaders(credOrToken);

  return new Promise((resolve, reject) => {
    let full;
    try {
      full = new URL(TB_API_BASE.replace(/\/$/, '') + '/' + pathAndQuery.replace(/^\//, ''));
    } catch (e) {
      return reject(new Error('URL 构造失败: ' + e.message));
    }

    const opts = {
      method: 'GET',
      hostname: full.hostname,
      path: full.pathname + full.search,
      headers: headers
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json;
        try { json = data ? JSON.parse(data) : {}; }
        catch (e) { return reject(new Error('响应非 JSON (HTTP ' + res.statusCode + '): ' + data.slice(0, 200))); }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = (json && (json.errorMessage || json.message || json.error || json.code)) || ('HTTP ' + res.statusCode);
          const err = new Error('TB 接口错误: ' + msg);
          err.statusCode = res.statusCode;
          err.body = json;
          return reject(err);
        }

        // ⚠️ TB 恒返回 HTTP 200，业务错误在响应体 code。0 在部分接口表示成功。
        const code = json && json.code;
        if (code !== undefined && code !== 200 && code !== 0) {
          const err = new Error('TB 业务错误 [' + code + '] ' + pathAndQuery.split('?')[0] + ': ' +
            (json.errorMessage || json.message || json.errorCode || ''));
          err.statusCode = res.statusCode;
          err.bizCode = code;
          err.body = json;
          return reject(err);
        }

        resolve(json);
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('TB 接口请求超时(30s)')); });
    req.end();
  });
}

/**
 * 按 TQL 分页拉取全部任务 id。
 * @param {string} tql
 * @param {object|string} [credOrToken]
 * @returns {Promise<string[]>} 任务 id 数组
 */
async function searchAllTaskIds(tql, credOrToken) {
  const ids = [];
  let pageToken = '';
  let pages = 0;

  do {
    const qs = new URLSearchParams({
      tql: tql,
      pageSize: String(SEARCH_PAGE_SIZE)
    });
    if (pageToken) qs.set('pageToken', pageToken);

    const resp = await tbGet('v2/all-task/search?' + qs.toString(), credOrToken);
    const list = resp.result || resp.tasks || resp.data || [];
    for (const t of list) {
      // v2/all-task/search 的 result 是「任务 id 字符串数组」
      const id = (typeof t === 'string') ? t : (t.id || t._id || t.taskId);
      if (id) ids.push(id);
    }
    pageToken = resp.nextPageToken || '';
    pages++;
    if (pages >= MAX_PAGES) break;
  } while (pageToken);

  return ids;
}

/**
 * 批量查任务详情（customfields）。
 * @param {string[]} taskIds
 * @param {object|string} [credOrToken]
 * @returns {Promise<Array>} 任务详情数组
 */
async function queryTaskDetails(taskIds, credOrToken) {
  const out = [];
  for (let i = 0; i < taskIds.length; i += TASK_QUERY_BATCH) {
    const batch = taskIds.slice(i, i + TASK_QUERY_BATCH);
    const qs = new URLSearchParams({
      taskId: batch.join(','),
      fields: 'customfields'
    });
    const resp = await tbGet('v3/task/query?' + qs.toString(), credOrToken);
    const list = resp.result || resp.tasks || resp.data || (Array.isArray(resp) ? resp : []);
    for (const t of list) out.push(t);
  }
  return out;
}

/**
 * 分页拉取项目下的迭代列表。
 * @param {string} projectId
 * @param {object} [opts] { status?: 'future'|'active'|'complete', pageSize?: number }
 * @returns {Promise<Array>} 迭代对象数组
 */
async function listSprints(projectId, opts, credOrToken) {
  const o = opts || {};
  const out = [];
  let pageToken = '';
  let pages = 0;

  do {
    const qs = new URLSearchParams({ pageSize: String(o.pageSize || 100) });
    if (pageToken) qs.set('pageToken', pageToken);

    const resp = await tbGet('v3/project/' + encodeURIComponent(projectId) + '/sprint/search?' + qs.toString(), credOrToken);
    const list = resp.result || [];
    for (const s of list) out.push(s);
    pageToken = resp.nextPageToken || '';
    pages++;
    if (pages >= MAX_PAGES) break;
  } while (pageToken);

  if (o.status) return out.filter(s => s.status === o.status);
  return out;
}

/**
 * 只取任务总数，不拉明细。
 * v2/all-task/search 的响应信封里带 count（全量匹配数，与分页无关），
 * 所以 pageSize=1 一次请求即可拿到总数 —— 用于算完成率时避免全量翻页。
 * @param {string} tql
 * @returns {Promise<number>}
 */
async function countTasks(tql, credOrToken) {
  const qs = new URLSearchParams({ tql: tql, pageSize: '1' });
  const resp = await tbGet('v2/all-task/search?' + qs.toString(), credOrToken);
  const n = Number(resp.count);
  return isFinite(n) ? n : 0;
}

/**
 * 查询项目列表 / 项目详情。
 * ⚠️ 实测结论（别改成 search）：
 *   - v3/project/search        → 421 url not found（不存在）
 *   - v3/project/{projectId}   → 421 url not found（不存在）
 *   - 参数是 projectIds（复数）。写成 projectId 会被**静默忽略**，
 *     返回一批无关项目 —— 这是最坑的"错得像对"的情况。
 * @param {object} [opts] { ids?: string[], name?: string, pageSize?: number, maxPages?: number }
 * @returns {Promise<Array>} 项目对象数组
 */
async function queryProjects(opts, credOrToken) {
  const o = opts || {};
  const out = [];
  let pageToken = '';
  let pages = 0;
  const limitPages = Math.min(o.maxPages || MAX_PAGES, MAX_PAGES);

  do {
    const qs = new URLSearchParams({ pageSize: String(o.pageSize || 100) });
    if (o.ids && o.ids.length) qs.set('projectIds', o.ids.join(','));
    if (o.name) qs.set('name', o.name);
    if (pageToken) qs.set('pageToken', pageToken);

    const resp = await tbGet('v3/project/query?' + qs.toString(), credOrToken);
    const list = resp.result || [];
    for (const p of list) out.push(p);
    pageToken = resp.nextPageToken || '';
    pages++;
    // 指定 ids 时只需一页；name 模糊搜索由 TB 侧限量，也不必翻太多页
    if (o.ids && o.ids.length) break;
    if (pages >= limitPages) break;
  } while (pageToken);

  return out;
}

module.exports = {
  tbGet,
  searchAllTaskIds,
  queryTaskDetails,
  countTasks,
  listSprints,
  queryProjects,
  readCredentials,
  getAppToken,
  TASK_QUERY_BATCH,
  SEARCH_PAGE_SIZE
};
