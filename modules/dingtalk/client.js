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
    operatorId: env.DINGTALK_OPERATOR_ID || file.operatorId,
    /* corpId 只有【登录】用得上（换用户身份、给前端 JSAPI 传参），通讯录不需要。
       所以它不影响 isConfigured()，否则没填 corpId 会把已跑通的通讯录同步也一起关掉。 */
    corpId: env.DINGTALK_CORP_ID || file.corpId
  };
}

/** 配置是否齐全到能调通讯录接口 */
function isConfigured() {
  const c = loadConfig();
  return !missing(c.appKey) && !missing(c.appSecret);
}

/** 配置是否齐全到能走钉钉登录（比通讯录多要一个 corpId） */
function isLoginConfigured() {
  const c = loadConfig();
  return !missing(c.appKey) && !missing(c.appSecret) && !missing(c.corpId);
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

/* ---------- 钉钉身份（登录用）----------------------------------
 *
 * ── 两条路，能力完全不同，别混 ────────────────────────────────────
 *
 *  ① 免登（JSAPI）：用户在钉钉客户端里打开平台 → 前端 dd.runtime.permission
 *     .requestAuthCode({ corpId }) 拿到 authCode → POST 给后端。
 *     ★ 钉钉服务器【不访问】平台 —— 没有回调域名白名单这回事，
 *       所以纯内网 IP（10.63.139.103:9680）直接能用。
 *
 *  ② 扫码（OAuth2）：浏览器 → login.dingtalk.com → 【回调到平台】。
 *     需要钉钉侧登记回调地址，纯内网 IP 登记不了。本文件不实现②。
 *
 * ── 为什么先取 userid 再取 token，而不是反过来 ──────────────────────
 * 身份（userid）是【能不能登录】的闸门，用户级 token 只是【能不能调钉钉接口】。
 * 顺序反过来的话：先换 token 成功、再取 userid 失败 → 谁也别想登录。
 * 现在这个顺序最坏也只是「登进来了，但文档接口暂时用不了」，
 * 用户能干活，且提示明确可查。
 *
 * ── authCode 能不能用两次 ─────────────────────────────────────────
 * 钉钉的 authCode 是一次性的（用完即废）。所以这里必须：
 *   先 getuserinfo（决定成败）→ 再换 userAccessToken（锦上添花）。
 * 若实测发现二者不能共用同一个 code，正确做法是让前端调两次
 * requestAuthCode 各拿一个 code，而不是把顺序调回来。
 */

/**
 * 用 authCode 换【钉钉身份】（userid / 姓名）。
 * 走老版 oapi —— 这个接口只有老版有，且 token 要放 query（放请求头会 400）。
 * @param {string} code 前端 requestAuthCode 拿到的 authCode
 * @returns {Promise<{userId:string, name:string}>}
 */
async function getUserInfoByCode(code) {
  if (missing(code)) {
    const err = new Error('缺少 authCode');
    err.step = 'param';
    throw err;
  }
  const token = await getToken();
  const r = await req('POST', oapiUrl('/topapi/v2/user/getuserinfo', { access_token: token }), {
    body: { code: String(code) }
  });
  const j = unwrap(r, '用 authCode 换钉钉身份');
  const res = j.result || {};
  const userId = String(res.userid || res.userId || '');
  if (!userId) {
    /* 返回体里没有 userid 只有一种常见成因：调用方不是本企业成员，
       或者应用的可见范围没覆盖到这个人。两者处置方式不同，所以把体打出来。 */
    const err = new Error('钉钉返回体里没有 userid（可能不在应用可见范围内）');
    err.step = 'field';
    err.body = JSON.stringify(j).slice(0, 300);
    throw err;
  }
  return { userId: userId, name: String(res.name || '') };
}

/**
 * 按 userid 取通讯录详情 —— 关键是为了拿【工号 job_number】。
 * 工号是平台的主键（users.id），也是唯一能与 SSO 对齐的口径。
 * @param {string} userId
 * @returns {Promise<{userId:string,name:string,jobNumber:string,mobile:string,active:boolean|null}>}
 */
async function getUserDetail(userId) {
  const token = await getToken();
  const r = await req('POST', oapiUrl('/topapi/v2/user/get', { access_token: token }), {
    body: { userid: String(userId) }
  });
  const j = unwrap(r, '取钉钉用户详情（' + userId + '）');
  const u = j.result || {};
  return {
    userId: String(u.userid || userId),
    name: String(u.name || ''),
    jobNumber: String(u.job_number || ''),
    mobile: String(u.mobile || ''),
    active: u.active !== undefined ? !!u.active : null
  };
}

/* ---------- 用户级 token（权限透传）------------------------------
 *
 * ★ 这是「权限透传」的技术实质：
 *   企业 token（getToken）代表【应用】—— 能看到的取决于应用被授了哪些权限点。
 *   用户 token（这里）代表【这个自然人】—— 钉钉按【他本人】的可见范围鉴权。
 *   拿用户 token 去调文档接口，他在钉钉看得到的，平台上就调得到；
 *   看不到的，钉钉直接拒 —— 平台【不需要自己维护一套文档权限表】。
 *
 * ⚠ 只存内存，不落盘。理由同上面的企业 token：多落一个盘就多一个要
 *   gitignore 的密钥文件，而重启后让用户重新登录一次的代价可以接受。
 *   代价：服务重启后已登录的人要重新点一次登录，才能用文档类功能。
 */
const _userTokens = new Map();   // userId → { accessToken, refreshToken, expireAt }

/**
 * 用 authCode 换【用户级 access_token】。
 * @returns {Promise<{accessToken:string, refreshToken:string, expireIn:number}>}
 */
async function exchangeUserToken(code) {
  const cfg = loadConfig();
  if (missing(cfg.appKey) || missing(cfg.appSecret)) {
    const err = new Error('缺少 appKey / appSecret');
    err.step = 'config';
    throw err;
  }
  const r = await req('POST', API + '/v1.0/oauth2/userAccessToken', {
    body: {
      clientId: cfg.appKey,
      clientSecret: cfg.appSecret,
      code: String(code),
      grantType: 'authorization_code'
    }
  });
  if (r.status !== 200 || !r.json || !r.json.accessToken) {
    const err = new Error('换用户 token 失败：HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200));
    err.step = 'userToken';
    throw err;
  }
  return {
    accessToken: r.json.accessToken,
    refreshToken: r.json.refreshToken || '',
    expireIn: Number(r.json.expireIn) > 0 ? Number(r.json.expireIn) : 7200
  };
}

/**
 * 用 refreshToken 续期。用户 token 有效期约 2 小时，
 * 过期后不续期就得让用户重新登录一次 —— 体验断崖，所以必须实现续期。
 */
async function refreshUserToken(refreshToken) {
  const cfg = loadConfig();
  const r = await req('POST', API + '/v1.0/oauth2/userAccessToken', {
    body: {
      clientId: cfg.appKey,
      clientSecret: cfg.appSecret,
      refreshToken: String(refreshToken),
      grantType: 'refresh_token'
    }
  });
  if (r.status !== 200 || !r.json || !r.json.accessToken) {
    const err = new Error('续期用户 token 失败：HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200));
    err.step = 'userTokenRefresh';
    throw err;
  }
  return {
    accessToken: r.json.accessToken,
    refreshToken: r.json.refreshToken || refreshToken,
    expireIn: Number(r.json.expireIn) > 0 ? Number(r.json.expireIn) : 7200
  };
}

/** 存下某人的用户 token。提前 5 分钟算过期，避免边界上打出 401。 */
function putUserToken(userId, t) {
  _userTokens.set(String(userId), {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken || '',
    expireAt: Date.now() + (t.expireIn - 300) * 1000
  });
}

function getUserToken(userId) {
  const t = _userTokens.get(String(userId));
  if (!t) return null;
  if (t.expireAt <= Date.now()) return null;   // 过期即视为没有，由调用方决定要不要续
  return t;
}

function clearUserToken(userId) { _userTokens.delete(String(userId)); }

/**
 * 取某人的可用用户 token，必要时自动续期。
 * 拿不到（从没登录过 / 刷新也失败）返回 null，由调用方降级，
 * 【不要抛错】—— 文档类功能用不了不该把整个页面打挂。
 * @returns {Promise<string|null>}
 */
async function userTokenOf(userId) {
  const t = _userTokens.get(String(userId));
  if (!t) return null;
  if (t.expireAt > Date.now()) return t.accessToken;
  if (!t.refreshToken) { _userTokens.delete(String(userId)); return null; }
  try {
    const fresh = await refreshUserToken(t.refreshToken);
    putUserToken(userId, fresh);
    return fresh.accessToken;
  } catch (e) {
    /* 续期失败的常见成因是 refreshToken 也过期了（有效期比 access 长得多，
       但不是无限）。清掉，让前端引导用户重新登录一次。 */
    _userTokens.delete(String(userId));
    return null;
  }
}

/** 当前有多少人持有可用的用户 token —— 只给 /dingtalk/status 做观测用 */
function userTokenStats() {
  let alive = 0;
  const now = Date.now();
  for (const t of _userTokens.values()) if (t.expireAt > now) alive++;
  return { cached: _userTokens.size, alive: alive };
}

module.exports = {
  API, OAPI, SECRET_FILE,
  missing, loadConfig, isConfigured, isLoginConfigured,
  req, maskToken, maskDeep,
  getToken, clearToken,
  listSubDepartments, listDepartmentUsers,
  fetchOrg,
  /* 用户身份 / 权限透传 */
  getUserInfoByCode, getUserDetail, exchangeUserToken, refreshUserToken,
  putUserToken, getUserToken, userTokenOf, clearUserToken, userTokenStats
};
