/* modules/tb/client.js — Teambition 开放接口客户端
   零依赖，仅用 Node 内置 https。
   已验证可用的接口：
     - GET v2/all-task/search?tql=...&pageSize=...&pageToken=...
         按 TQL 查任务 id 列表，返回 { result:[{id}], nextPageToken, totalCount }
     - GET v3/task/query?taskId=id1,id2&fields=customfields
         批量查任务详情（customfields）
*/

'use strict';

const https = require('https');
const { URL } = require('url');
const { TB_API_BASE } = require('../../tb-config');

/* 每批查详情的任务数上限（TB 对 taskId 拼接长度有限制，取保守值） */
const TASK_QUERY_BATCH = 50;
/* 任务列表分页大小 */
const SEARCH_PAGE_SIZE = 200;
/* 分页安全上限，防止意外死循环 */
const MAX_PAGES = 200;

/**
 * 发起一次 GET 请求，返回解析后的 JSON。
 * @param {string} pathAndQuery 相对 TB_API_BASE 的路径（含 query）
 * @param {string} token User Token
 */
function tbGet(pathAndQuery, token) {
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
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json'
      }
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json;
        try { json = data ? JSON.parse(data) : {}; }
        catch (e) { return reject(new Error('响应非 JSON (HTTP ' + res.statusCode + '): ' + data.slice(0, 200))); }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = (json && (json.message || json.error || json.code)) || ('HTTP ' + res.statusCode);
          const err = new Error('TB 接口错误: ' + msg);
          err.statusCode = res.statusCode;
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
 * @returns {Promise<string[]>} 任务 id 数组
 */
async function searchAllTaskIds(tql, token) {
  const ids = [];
  let pageToken = '';
  let pages = 0;

  do {
    const qs = new URLSearchParams({
      tql: tql,
      pageSize: String(SEARCH_PAGE_SIZE)
    });
    if (pageToken) qs.set('pageToken', pageToken);

    const resp = await tbGet('v2/all-task/search?' + qs.toString(), token);
    const list = resp.result || resp.tasks || resp.data || [];
    for (const t of list) {
      const id = t.id || t._id || t.taskId;
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
 * @returns {Promise<Array>} 任务详情数组
 */
async function queryTaskDetails(taskIds, token) {
  const out = [];
  for (let i = 0; i < taskIds.length; i += TASK_QUERY_BATCH) {
    const batch = taskIds.slice(i, i + TASK_QUERY_BATCH);
    const qs = new URLSearchParams({
      taskId: batch.join(','),
      fields: 'customfields'
    });
    const resp = await tbGet('v3/task/query?' + qs.toString(), token);
    const list = resp.result || resp.tasks || resp.data || (Array.isArray(resp) ? resp : []);
    for (const t of list) out.push(t);
  }
  return out;
}

module.exports = {
  tbGet,
  searchAllTaskIds,
  queryTaskDetails,
  TASK_QUERY_BATCH,
  SEARCH_PAGE_SIZE
};
