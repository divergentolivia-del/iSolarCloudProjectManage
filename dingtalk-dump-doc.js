#!/usr/bin/env node
/* dingtalk-dump-doc.js — 把钉钉文档的 14 张表原样导成 JSON
 *
 * 用法：node dingtalk-dump-doc.js <nodeId>
 * 输出：JSON 数组，每张表一个对象 {id, name, fields, records}
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const SECRET_FILE = path.join(__dirname, 'data', 'dingtalk', 'secret.json');
const API = 'https://api.dingtalk.com';
const TIMEOUT_MS = 15000;

function missing(v) {
  return !v || (typeof v === 'string' && v.trim().length === 0);
}

function loadCred() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
  } catch (e) { /* 环境变量兜底 */ }
  const env = process.env;
  const doc = file['_文档定位_二选一'] || {};
  return {
    appKey: env.DINGTALK_APP_KEY || file.appKey,
    appSecret: env.DINGTALK_APP_SECRET || file.appSecret,
    operatorId: env.DINGTALK_OPERATOR_ID || file.operatorId,
    nodeId: env.DINGTALK_NODE_ID || doc.nodeId || null
  };
}

function req(method, url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const token = opts && opts.token;
    const body = opts && opts.body ? JSON.stringify(opts.body) : null;
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token || ''
    };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const r = https.request({
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method, headers, timeout: TIMEOUT_MS
    }, resp => {
      let raw = '';
      resp.on('data', c => raw += c);
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: resp.statusCode, json, text: raw });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const nodeId = process.argv[2];
  if (!nodeId) {
    console.error('用法: node dingtalk-dump-doc.js <nodeId>');
    process.exit(1);
  }

  const cred = loadCred();
  if (!cred.appKey || !cred.appSecret || !cred.operatorId) {
    console.error('缺凭据（appKey/appSecret/operatorId）');
    process.exit(1);
  }

  /* 1. 换 token */
  const tr = await req('POST', API + '/v1.0/oauth2/accessToken', {
    body: { appKey: cred.appKey, appSecret: cred.appSecret }
  });
  if (tr.status !== 200 || !tr.json || !tr.json.accessToken) {
    console.error('换 token 失败：', tr.status, tr.json);
    process.exit(1);
  }
  const token = tr.json.accessToken;

  /* 2. 列表格 */
  const lr = await req('GET', API + '/v1.0/notable/bases/' + nodeId + '/sheets?operatorId=' + cred.operatorId, { token });
  if (lr.status !== 200 || !lr.json || !Array.isArray(lr.json.value)) {
    console.error('列表格失败：', lr.status, lr.json);
    process.exit(1);
  }
  const tables = lr.json.value;

  /* 3. 逐表读 records + fields
     ★ 两个接口的响应结构【不一样】，别按同一个形状读：
       records → 记录直接挂在顶层 .records
       fields  → 字段定义挂在 .value（和 /sheets 一样是 value 包装）
     踩过:两处都写成 .fields / 都写成 .value，各静默拿到空数组，
     表现为「表清单读到了、记录全是空」，看着像没权限其实是读错字段。
     ★ records 接口 maxResults 上限 100，需要分页。 */
  const output = [];
  for (const t of tables) {
    const sid = encodeURIComponent(t.id || t.name);
    const q = '?operatorId=' + encodeURIComponent(cred.operatorId);

    /* 字段定义 */
    const fr = await req('GET', API + '/v1.0/notable/bases/' + nodeId + '/sheets/' + sid + '/fields' + q, { token });

    /* 记录分页 */
    const allRecords = [];
    let nextToken = null;
    for (let page = 0; page < 500; page++) {
      const rq = q + '&maxResults=100' + (nextToken ? '&nextToken=' + encodeURIComponent(nextToken) : '');
      const dr = await req('GET', API + '/v1.0/notable/bases/' + nodeId + '/sheets/' + sid + '/records' + rq, { token });
      if (dr.status !== 200 || !dr.json) {
        output.push({
          id: t.id, name: t.name,
          fields: (fr.json && fr.json.value) || [],
          records: [],
          _recordsErr: dr.json || { status: dr.status, text: dr.text.slice(0, 200) }
        });
        break;
      }
      allRecords.push(...(dr.json.records || []));
      if (!dr.json.hasMore) break;
      nextToken = dr.json.nextToken || null;
      if (!nextToken) break;
    }

    if (allRecords.length > 0 || nextToken === null) {
      output.push({
        id: t.id,
        name: t.name,
        fields: (fr.json && fr.json.value) || [],
        records: allRecords
      });
    }
  }

  console.log(JSON.stringify(output, null, 2));
})().catch(e => {
  console.error('失败:', e.message, e.stack);
  process.exit(1);
});
