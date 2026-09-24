/* modules/dingtalk/client.js — 钉钉服务端 API 客户端（只读）
 *
 * 定位：这是【只读】的通讯录/组织架构读取层。写操作（发消息、改通讯录）
 * 一律不在这里做 —— 平台对钉钉只取不推，避免误操作动到公司组织架构。
 *
 * ── 为什么先有 client 再有 sync ────────────────────────────────
 * 与 TB 同步同一条教训：不先实测就设计同步 = 空中楼阁。
 * dingtalk-ping.js 已经把换 token 这一跳跑通了，这里把那次验证的结论固化下来，
 * 而不是另起一套写法。
 *
 * ── 两套域名，别混 ─────────────────────────────────────────────
 *   api.dingtalk.com  —— 新版接口。token 放请求头 x-acs-dingtalk-access-token
 *   oapi.dingtalk.com —— 老版接口。token 放 query ?access_token=xxx
 * 通讯录接口（部门/员工）目前只有老版域名有，所以这个文件里两套并存。
 * 踩过的坑：老版接口把 token 放请求头会返回 400 而非 401，
 * 看起来像参数写错，其实是鉴权位置不对。
 *
 * 凭据来源：data/dingtalk/secret.json（已 gitignore）。
 *          环境变量 DINGTALK_APP_KEY / DINGTALK_APP_SECRET / DINGTALK_OPERATOR_ID 优先。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SECRET_FILE = path.join(__dirname, '..', '..', 'data', 'dingtalk', 'secret.json');
const API = 'https://api.dingtalk.com';
const OAPI = 'https://oapi.dingtalk.com';
const TIMEOUT_MS = 15000;

/* ---------- 配置 ---------- */

/** 占位值识别：说明文字、忘了填的空壳，都算「没填」 */
function missing(v) {
  if (v === undefined || v === null) return true;
  const s = String(v).trim();
  if (!s) return true;
  if (s === '待填' || s === '待填 ') return true;
  if (/^(「|请|填|your|xxx|TODO)/i.test(s)) return true;
  return false;
}

function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')); } catch (e) { /* 只走环境变量 */ }
  const env = process.env;
  return {
    appKey: env.DINGTALK_APP_KEY || file.appKey,
    appSecret: env.DINGTALK_APP_SECRET || file.appSecret,
    operatorId: env.DINGTALK_OPERATOR_ID || file.operatorId
  };
}

/** 配置是否齐全到能调通讯录接口 */
function isConfigured() {
  const c = loadConfig();
  return !missing(c.appKey) && !missing(c.appSecret);
}

/* ---------- 请求 ---------- */

/** 带超时的请求。json 解析失败不算错（钉钉故障时会回 HTML 网关页）。 */
async function req(method, url, opts) {
  const o = opts || {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeout || TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json' };
  if (o.token) headers['x-acs-dingtalk-access-token'] = o.token;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 遮蔽（日志里绝不出现明文密钥 / token）----------
 *
 * ⚠ 按【键名】判断，所以调用方必须用 token/secret/password 这类键名。
 *   踩过：写成 maskDeep({ t: token }).t，键名是 t 不匹配规则，token 明文打了出来。
 */
function maskToken(v) {
  const s = String(v || '');
  return s.length > 16 ? s.slice(0, 6) + '…(' + s.length + ' 位)…' + s.slice(-4) : s;
}

function maskDeep(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(maskDeep);
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (/token|secret|password/i.test(k) && typeof v === 'string') out[k] = maskToken(v);
    else out[k] = maskDeep(v);
  }
  return out;
}

/* ---------- token ----------
 *
 * 缓存在内存里，不落盘。理由：token 有效期 7200 秒，进程重启时重取一次
 * 的成本可以忽略，而落盘意味着又多一个需要 gitignore 的密钥文件。
 * 提前 5 分钟过期，避免「取到时还剩 1 秒」这种边界把请求打成 401。
 */
let _token = null;        // { value, expireAt }

/**
 * 取 access_token（带缓存）。
 * @returns {Promise<string>}
 */
async function getToken() {
  if (_token && _token.expireAt > Date.now()) return _token.value;

  const cfg = loadConfig();
  if (missing(cfg.appKey) || missing(cfg.appSecret)) {
    throw new Error('缺少 appKey / appSecret，请填 data/dingtalk/secret.json');
  }
  const r = await req('POST', API + '/v1.0/oauth2/accessToken', {
    body: { appKey: cfg.appKey, appSecret: cfg.appSecret }
  });
  if (r.status !== 200 || !r.json || !r.json.accessToken) {
    const err = new Error('换 token 失败：HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200));
    err.step = 'token';
    throw err;
  }
  const ttl = Number(r.json.expireIn) > 0 ? Number(r.json.expireIn) : 7200;
  _token = { value: r.json.accessToken, expireAt: Date.now() + (ttl - 300) * 1000 };
  return _token.value;
}

/** 只给测试/排障用：清掉缓存的 token */
function clearToken() { _token = null; }

/* ---------- 通讯录（老版 oapi 域名，token 走 query）---------- */

/**
 * 统一处理 oapi 的返回体。
 * oapi 的习惯是 HTTP 恒为 200，成功与否看 errcode。
 * 这一点与 TB 一致（TB 也恒回 200），所以判据必须看 body 不能看 status ——
 * 否则「没权限」会被当成「成功但返回空列表」，是静默失败。
 */
function unwrap(r, what) {
  const j = r.json;
  if (r.status !== 200 || !j) {
    const err = new Error(what + ' 失败：HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200));
    err.step = 'http';
    throw err;
  }
  if (j.errcode !== 0 && j.errcode !== undefined) {
    const err = new Error(what + ' 失败：errcode=' + j.errcode + ' ' + (j.errmsg || ''));
    err.errcode = j.errcode;
    err.errmsg = j.errmsg;
    /* 60011 = 无权限访问该部门；33001 = 无效的部门 id。
       分开标注是因为处置方式完全不同：前者要去开放平台加权限点，
       后者是配置写错了。 */
    err.step = j.errcode === 60011 ? 'permission' : 'api';
    throw err;
  }
  return j;
}

/** 老版接口的 query 拼装（含 access_token）*/
function oapiUrl(p, params) {
  const q = Object.keys(params || {})
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
  return OAPI + p + '?' + q;
}

/**
 * 取某部门的【直属子部门】列表（不递归）。
 * @param {string} deptId 部门 id。根部门固定为 1
 * @returns {Promise<Array<{id:string,name:string,parentId:string}>>}
 */
async function listSubDepartments(deptId) {
  const token = await getToken();
  const r = await req('POST', oapiUrl('/topapi/v2/department/listsub', { access_token: token }), {
    body: { dept_id: Number(deptId) || 1 }
  });
  const j = unwrap(r, '取子部门（dept ' + deptId + '）');
  return (j.result || []).map(d => ({
    id: String(d.dept_id),
    name: String(d.name || ''),
    parentId: String(d.parent_id || '')
  }));
}

/**
 * 取某部门的【直属员工】列表（不含子部门的人）。
 * @returns {Promise<Array>} 员工原始对象数组
 */
async function listDepartmentUsers(deptId) {
  const token = await getToken();
  /* 分页：单次上限 100，超过要用 offset 翻页。部门大了不分页会静默少人 ——
     这类「少了几个人」最难发现，因为不报错。 */
  const all = [];
  let cursor = 0;
  for (let guard = 0; guard < 200; guard++) {
    const r = await req('POST', oapiUrl('/topapi/v2/user/list', { access_token: token }), {
      body: { dept_id: Number(deptId) || 1, cursor: cursor, size: 100 }
    });
    const j = unwrap(r, '取部门员工（dept ' + deptId + '）');
    const page = j.result || {};
    all.push(...(page.list || []));
    if (!page.has_more) break;
    cursor = Number(page.next_cursor) || 0;
  }
  return all;
}

/**
 * 拉取组织架构树（可从指定部门开始）。
 *
 * ── 为什么能从中间开始，而不是永远从根拉 ────────────────────────
 * 实测这个组织有 4657+ 个部门、21340 人，是【全公司】的通讯录。
 * 而平台的受众是某一个部门。从根拉全量再筛，等于每次同步都要
 * 跑 2 万人的数据、花两分钟 —— 纯浪费，而且拿到的绝大多数数据
 * 永远用不上。所以 rootDeptId 是主参数，从哪个部门开始就从哪开始。
 *
 * 代价：拿不到父链上的部门名。要显示「智慧能源产品中心 / 研发中心」，
 * 得靠调用方自己记住根部门名。这是刻意的取舍 —— 父链对业务没用。
 *
 * ── 为什么是 BFS + 并发，而不是递归 ──────────────────────────────
 * 最初写成串行递归，全量耗时 6~7 分钟，长到看不出是在跑还是卡死。
 * 改成 BFS 后同一层可并发，配合 6 路并发约 1 分 50 秒（全量）。
 *
 * 为什么并发上限只给 6：钉钉通讯录接口有 QPS 限制，并发打太高会被限流
 * （表现为 errcode 90018 / 88xxx），而限流是【部分失败】——
 * 一部分成功一部分失败，比整体失败更难排查。宁可慢一点也不能触发限流。
 *
 * @param {object} [opts]
 * @param {string} [opts.rootDeptId='1'] 起始部门 id。默认 1（根）
 * @param {string} [opts.rootDeptName]   起始部门名，仅用于标注数据来源
 * @param {number} [opts.maxDepth=8]     从起始部门往下最多几层
 * @param {number} [opts.maxDepts=8000]  部门总数上限
 * @param {number} [opts.concurrency=6]  并发请求数
 * @param {function} [opts.onProgress]   进度回调 (name, {done, total})
 * @returns {Promise<{departments:Array, users:Array, errors:Array, truncated:boolean}>}
 *
 * ★ 采集失败必须可见：任何一步失败都进 errors 而不是被吞掉。
 *   2026-09-22 的 82 条待办误标事故，根因就是采集挂了下游却当成「没数据」。
 *   通讯录尤其不能静默 —— 少一个部门 = 少一批人 = 离职对账漏人。
 *   同理，触发上限截断时必须把 truncated 置为 true，让调用方能区分
 *   「组织就这么大」和「我没拉完」。
 */
async function fetchOrg(opts) {
  const o = opts || {};
  const rootDeptId = String(o.rootDeptId || '1');
  const maxDepth = o.maxDepth || 8;
  const maxDepts = o.maxDepts || 8000;
  const concurrency = Math.max(1, Math.min(o.concurrency || 6, 20));

  const departments = [];
  const users = [];
  const errors = [];
  const seen = new Set();
  let truncated = false;

  /* 并发池：把 items 分给 concurrency 条并行的 worker。
     注意失败必须被 worker 捕获 —— 一个部门出错不能让整批 reject。 */
  async function pool(items, worker) {
    let idx = 0;
    const runners = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
      runners.push((async function () {
        while (idx < items.length) {
          const cur = items[idx++];
          try { await worker(cur); } catch (e) { /* worker 内部已记 errors */ }
        }
      })());
    }
    await Promise.all(runners);
  }

  /** 处理一个部门：取直属员工 + 取子部门，返回子部门数组供下一层用 */
  async function handleDept(node) {
    const deptId = node.id;
    const deptName = node.name;
    if (seen.has(deptId)) return [];
    seen.add(deptId);

    if (departments.length >= maxDepts) {
      truncated = true;
      errors.push({ deptId: deptId, deptName: deptName, reason: '部门总数超过上限 ' + maxDepts + '，未展开' });
      return [];
    }

    /* 直属员工 */
    try {
      const list = await listDepartmentUsers(deptId);
      for (const u of list) {
        users.push({
          userId: String(u.userid || u.userId || ''),
          name: String(u.name || ''),
          deptId: String(deptId),
          deptName: deptName,
          active: u.active !== undefined ? !!u.active : null,
          title: u.title || '',
          mobile: u.mobile || '',      // 仅内存用于对账，落盘时由 sync 决定是否保留
          jobNumber: u.job_number || ''   // ← 与 SSO 工号对齐的关键字段
        });
      }
    } catch (e) {
      errors.push({ deptId: deptId, deptName: deptName, reason: '取员工失败：' + e.message });
    }

    /* 子部门 */
    try {
      return await listSubDepartments(deptId);
    } catch (e) {
      errors.push({ deptId: deptId, deptName: deptName, reason: '取子部门失败：' + e.message });
      return [];
    }
  }

  /* 进度打印：用 stderr + \r 原地刷新，避免几百行把错误信息冲出屏幕。
     用 stderr 是为了不与 stdout 的结果输出混在一起（脚本可能被重定向）。 */
  let timer = null;
  let done = 0;
  const tick = () => {
    if (o.onProgress) o.onProgress(null, { done: done, total: departments.length });
  };
  if (o.onProgress) timer = setInterval(tick, 500);

  try {
    /* 起始部门本身也算一个部门（它的直属员工要收）。
       名字优先用调用方给的 —— 从中间开始时我们没经父链拿不到它的名字。 */
    let level = await handleDept({ id: rootDeptId, name: o.rootDeptName || ('部门 ' + rootDeptId) });
    departments.push(...level);
    let depth = 1;
    while (level.length && depth <= maxDepth) {
      const next = [];
      await pool(level, async (d) => {
        const subs = await handleDept(d);
        next.push(...subs);
        done++;
      });
      departments.push(...next);
      level = next;
      depth++;
      tick();
    }
    if (level.length && depth > maxDepth) {
      truncated = true;
      errors.push({ reason: '达到最大层级 ' + maxDepth + '，其下部门未展开' });
    }
  } finally {
    if (timer) { clearInterval(timer); process.stderr.write('\r' + ' '.repeat(80) + '\r'); }
  }
  if (o.onProgress) o.onProgress(null, { done: done, total: departments.length });

  return { departments, users, errors, truncated };
}

module.exports = {
  API, OAPI, SECRET_FILE,
  missing, loadConfig, isConfigured,
  req, maskToken, maskDeep,
  getToken, clearToken,
  listSubDepartments, listDepartmentUsers,
  fetchOrg
};
