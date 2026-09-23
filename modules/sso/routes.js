/* modules/sso/routes.js — 公司 SSO 登录（OAuth2 授权码模式）
 *
 * 为什么不用密码登录凑合：密码是「一次发出去、长期有效」的凭证，
 * 员工离职、密码外泄都要人工追。SSO 把这件事交回公司统一认证 ——
 * 离职即失效，登录必然实名，操作可追溯到人。
 *
 * ── 与现有密码登录的关系 ──────────────────────────────────────────
 * 并存，不是替换。两条路最后都落到同一张 users 表、同一个 wb_session 会话，
 * 所以「谁登录的、谁操作的」在审计日志里完全一致。
 * SSO 没批下来或临时故障时，管理员账号仍可用密码登录兜底。
 *
 * ── 流程 ─────────────────────────────────────────────────────────
 *   ① GET /sso/login?next=/plan
 *        → 生成 state 随机串，写进一次性 nonce 表（10 分钟过期）
 *        → 302 到 sso.sungrow.cn/sso/login?response_type=code&client_id=…&redirect_uri=…&state=…
 *   ② 用户在 SSO 页面认证（密码只给 SSO，我们永远看不到）
 *   ③ SSO 跳回 GET /sso/callback?code=xxx&state=yyy
 *        → 校验 state：不在表里 / 已用过 / 过期 → 直接拒绝
 *        → 后端拿 code + client_secret 去换【工号】
 *        → 工号匹配 users.id → 建会话 → 种 wb_session Cookie → 302 回 next
 *
 * ── 安全要点（每一条都对应一种真实攻击）───────────────────────────
 *   · state 一次性 + 10 分钟过期 → 防 CSRF、防重放
 *   · client_secret 只存服务端 data/sso/secret.json（已 gitignore），
 *     绝不下发浏览器、绝不写进代码、绝不进聊天和截图
 *   · code 只能配合我们的密钥兑换，且一次性、短时效 → 地址栏被偷也没用
 *   · redirect_uri 与登记值比对 → 防「拿我们的 client_id 把用户骗到别的站收 code」
 *   · 未在 users 表里开户的工号 → 明确拒绝并记审计，不静默建号
 *     （静默建号等于「公司任何人登录一次就能进平台」，权限体系会直接失控）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const url = require('url');
const crypto = require('crypto');

const db = require('../../db');

/* ---------- 配置 ---------- */

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');
const SSO_DIR = path.join(DATA_DIR, 'sso');
const SECRET_FILE = path.join(SSO_DIR, 'secret.json');

/* 默认值：授权端点从内部「评优材料评审系统」已跑通的实现照抄而来。
   若流程数字化中心给的是别的路径，改 secret.json 覆盖即可，不用改代码。 */
const DEFAULTS = {
  authorizeUrl: 'https://sso.sungrow.cn/sso/login',
  /* ⚠ 下面两项内部文档里没有写明，必须向流程数字化中心确认后填进 secret.json：
       tokenUrl   —— 用 code 换工号的接口地址
       idField    —— 返回体里工号所在的字段名（empNo / jobNumber / account …） */
  tokenUrl: '',
  idField: '',
  responseType: 'code',
  scope: '',
  /* 姓名与工号可能不在同一个返回体里（有的实现要再调一次 userinfo） */
  userInfoUrl: '',
  nameField: 'name',
  /* 回调地址必须与申请时登记的一字不差，见 docs/plan-identity-and-dingtalk.md */
  redirectUri: 'http://10.63.139.103:9680/sso/callback',
  /* 只读诊断模式：拿到 code 后不换工号建会话，只把结果打日志/页面。
     联调期用来定位接口问题，避免用错配置把人放进平台。 */
  debug: false
};

const CONFIG = (function load() {
  const env = process.env;
  const file = (function () {
    try { return JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')); } catch (e) { return {}; }
  })();
  /* 文件里的值先铺上（DEFAULTS 打底），再由环境变量覆盖 ——
     方便临时改配置而不用动文件，也方便测试时注入。 */
  const cfg = Object.assign({}, DEFAULTS, file);
  const ENV_MAP = {
    clientId: 'SSO_CLIENT_ID',
    clientSecret: 'SSO_CLIENT_SECRET',
    authorizeUrl: 'SSO_AUTHORIZE_URL',
    tokenUrl: 'SSO_TOKEN_URL',
    redirectUri: 'SSO_REDIRECT_URI',
    idField: 'SSO_ID_FIELD',
    userInfoUrl: 'SSO_USER_INFO_URL',
    nameField: 'SSO_NAME_FIELD',
    responseType: 'SSO_RESPONSE_TYPE',
    scope: 'SSO_SCOPE'
  };
  Object.keys(ENV_MAP).forEach(k => {
    const v = env[ENV_MAP[k]];
    if (v) cfg[k] = v;
  });
  if (env.SSO_DEBUG) cfg.debug = env.SSO_DEBUG === '1';
  return cfg;
})();

/** 配置是否齐全到能发起登录 */
function isConfigured() {
  return !!(CONFIG.clientId && CONFIG.tokenUrl && CONFIG.idField);
}

/** 缺哪个就明说哪个。联调期这比一句「配置错误」有用得多。 */
function missingConfig() {
  const miss = [];
  if (!CONFIG.clientId) miss.push('clientId（申请后由流程数字化中心提供）');
  if (!CONFIG.clientSecret) miss.push('clientSecret（同上）');
  if (!CONFIG.tokenUrl) miss.push('tokenUrl（换工号的接口地址，待确认）');
  if (!CONFIG.idField) miss.push('idField（返回体里工号所在的字段名，待确认）');
  return miss;
}

/* ---------- 小工具 ---------- */

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** HTML 页面（登录跳转失败时给用户看的，不返 JSON） */
function sendText(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>登录</title><style>body{margin:0;height:100vh;display:flex;align-items:center;'
    + 'justify-content:center;background:#f3f5f9;font:14px/1.7 -apple-system,"Segoe UI",'
    + '"Microsoft YaHei",sans-serif;color:#1f2937}.c{max-width:480px;padding:28px 32px;'
    + 'background:#fff;border-radius:14px;box-shadow:0 6px 28px rgba(15,23,42,.10)}'
    + 'h1{margin:0 0 10px;font-size:17px}p{margin:0 0 8px;color:#4b5563}'
    + 'code{background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:13px;'
    + 'word-break:break-all}.d{color:#9ca3af;font-size:12px}'
    + 'a{color:#2f6fed;text-decoration:none}a:hover{text-decoration:underline}'
    + '</style></head><body><div class="c">' + html + '</div></body></html>');
}

/** 只允许站内相对路径回跳，防开放重定向 */
function safeNext(next) {
  const n = String(next || '');
  if (!n || n.charAt(0) !== '/' || n.charAt(1) === '/') return '/';
  return n;
}

/* ---------- state 一次性 nonce ----------
 *
 * 为什么放内存而不是 SQLite：
 *   它是「10 分钟内的瞬时状态」，不是业务数据。重启即清空，代价只是
 *   正在登录的那个人重来一次 —— 可接受。加表要改 schema + 写迁移，
 *   为一个短时效随机串不划算。（与 auth 模块的登录节流同一个取舍。）
 *
 * 为什么必须一次性：state 若可重复使用，攻击者拿到一次登录链接就能反复重放。
 */
const NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_NONCES = 2000;
const _nonces = new Map();   // state → { next, createdAt }

function newNonce(next) {
  const now = Date.now();
  /* 顺手清理：只在发起登录时扫，校验路径上没有额外开销 */
  if (_nonces.size > MAX_NONCES) {
    for (const [k, v] of _nonces) {
      if (now - v.createdAt > NONCE_TTL_MS) _nonces.delete(k);
    }
  }
  const state = crypto.randomBytes(24).toString('base64url');
  _nonces.set(state, { next: safeNext(next), createdAt: now });
  return state;
}

/**
 * 校验并消费 state。返回 { ok, next, reason }。
 * 无论成功失败都把它删掉 —— 失败的那些也必须一次性，否则给了爆破空间。
 */
function consumeNonce(state) {
  const s = String(state || '');
  if (!s) return { ok: false, reason: 'missing' };
  const rec = _nonces.get(s);
  if (!rec) return { ok: false, reason: 'unknown' };
  _nonces.delete(s);
  if (Date.now() - rec.createdAt > NONCE_TTL_MS) return { ok: false, reason: 'expired' };
  return { ok: true, next: rec.next };
}

/* ---------- HTTP 请求（零依赖，Node 内置）---------- */

/**
 * 发一个请求并把返回体当 JSON 解析。
 * @returns {Promise<{status:number, json:object|null, raw:string}>}
 */
function httpJson(method, targetUrl, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new url.URL(targetUrl); }
    catch (e) { return reject(new Error('接口地址不是合法 URL：' + targetUrl)); }
    const lib = u.protocol === 'http:' ? http : https;
    const body = o.body || '';
    const headers = Object.assign({ 'Accept': 'application/json' }, o.headers || {});
    if (body) {
      headers['Content-Type'] = o.contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: method,
      headers: headers,
      timeout: o.timeout || 10000
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 非 JSON（SSO 可能回 HTML 错误页）*/ }
        resolve({ status: res.statusCode, json: json, raw: raw });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时（' + (o.timeout || 10000) + 'ms）')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ---------- 拿 code 换工号 ---------- */

/** 从返回体的任意层级里按字段名找值。有的实现把工号包在 data.result.empNo 里。 */
function dig(obj, field, depth) {
  if (!obj || depth > 4) return undefined;
  if (typeof obj !== 'object') return undefined;
  if (obj[field] !== undefined && obj[field] !== null && obj[field] !== '') return obj[field];
  for (const k of Object.keys(obj)) {
    const v = dig(obj[k], field, (depth || 0) + 1);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * 用授权码换工号。
 *
 * 内部文档没写这个接口长什么样，所以这里按两种常见形态都试：
 *   A. 返回体直接带工号（老系统常见）
 *   B. 标准 OAuth2：返回 access_token，再拿 token 调 userinfo 才拿到工号
 * 拿到后按配置的 idField 深度查找。定位不到就把原始返回体报出来 ——
 * 联调期一眼能看出是「字段名猜错了」还是「接口根本不对」。
 *
 * @returns {Promise<{empNo:string, name:string, raw:object}>}
 */
async function exchangeCode(code) {
  const q = [
    'grant_type=authorization_code',
    'code=' + encodeURIComponent(code),
    'client_id=' + encodeURIComponent(CONFIG.clientId),
    'client_secret=' + encodeURIComponent(CONFIG.clientSecret),
    'redirect_uri=' + encodeURIComponent(CONFIG.redirectUri)
  ].join('&');

  /* 先试 POST（标准），不成立再试 GET（部分内部实现只认 GET） */
  let r = await httpJson('POST', CONFIG.tokenUrl, {
    body: q, contentType: 'application/x-www-form-urlencoded'
  });
  if (r.status >= 400 || !r.json) {
    const sep = CONFIG.tokenUrl.indexOf('?') >= 0 ? '&' : '?';
    const r2 = await httpJson('GET', CONFIG.tokenUrl + sep + q, {});
    if (r2.status < 400 && r2.json) r = r2;
  }

  if (r.status >= 400 || !r.json) {
    const err = new Error('换工号接口返回 HTTP ' + r.status);
    err.step = 'token';
    err.status = r.status;
    err.body = String(r.raw || '').slice(0, 500);
    throw err;
  }

  /* 形态 B：拿到 access_token，再问一次 userinfo */
  let payload = r.json;
  const at = dig(r.json, 'access_token', 0) || dig(r.json, 'accessToken', 0);
  if (at && CONFIG.userInfoUrl) {
    const ui = await httpJson('GET', CONFIG.userInfoUrl, {
      headers: { 'Authorization': 'Bearer ' + at }
    });
    if (ui.json) payload = Object.assign({}, r.json, ui.json);
  }

  const empNo = dig(payload, CONFIG.idField, 0);
  if (empNo === undefined) {
    const err = new Error('返回体里找不到工号字段「' + CONFIG.idField + '」');
    err.step = 'field';
    err.body = JSON.stringify(payload).slice(0, 500);
    throw err;
  }
  const nm = dig(payload, CONFIG.nameField, 0);
  return {
    empNo: String(empNo).trim(),
    name: nm === undefined ? '' : String(nm).trim(),
    raw: payload
  };
}

/* ---------- 种会话 Cookie ----------
 *
 * 与 auth 模块保持完全一致：同名（wb_session）、同属性、同 30 天有效期。
 * 两处各写一份是刻意的取舍 —— 提取公共函数要跨模块依赖，
 * 而这两个属性值一旦不一致会出很隐蔽的 bug（例：SSO 登录后改密码接口读不到会话）。
 * 若将来 Cookie 属性要改，**两处必须同时改**（另一处见 modules/auth/routes.js）。 */
const COOKIE = 'wb_session';

function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie',
    COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec);
}

/* ---------- 路由 ---------- */

/** GET /sso/login —— 生成 state，跳去 SSO */
function handleLogin(req, res, u) {
  const miss = missingConfig();
  if (miss.length) {
    return sendText(res, 503,
      '<h1>SSO 还没配好</h1>'
      + '<p>缺少以下配置，请补到 <code>data/sso/secret.json</code>：</p>'
      + '<p>' + miss.map(m => '· ' + esc(m)).join('<br>') + '</p>'
      + '<p><a href="/login.html">← 用账号密码登录</a></p>'
      + '<p class="d">详见 docs/plan-identity-and-dingtalk.md</p>');
  }

  const next = safeNext(u.query.next);
  const state = newNonce(next);
  const qs = [
    'response_type=' + encodeURIComponent(CONFIG.responseType || 'code'),
    'client_id=' + encodeURIComponent(CONFIG.clientId),
    'redirect_uri=' + encodeURIComponent(CONFIG.redirectUri),
    'state=' + encodeURIComponent(state)
  ];
  if (CONFIG.scope) qs.push('scope=' + encodeURIComponent(CONFIG.scope));

  const sep = CONFIG.authorizeUrl.indexOf('?') >= 0 ? '&' : '?';
  res.writeHead(302, {
    Location: CONFIG.authorizeUrl + sep + qs.join('&'),
    'Cache-Control': 'no-store'
  });
  res.end();
}

/** GET /sso/callback —— 校验 state → 换工号 → 建会话 → 回跳 */
async function handleCallback(req, res, u) {
  const deny = (title, detail) => sendText(res, 403,
    '<h1>' + esc(title) + '</h1><p>' + detail + '</p>'
    + '<p><a href="/login.html">← 用账号密码登录</a></p>');

  /* 用户在 SSO 页面点了「取消」或认证失败，SSO 会带 error 跳回来 */
  if (u.query.error) {
    return deny('SSO 认证未通过',
      '认证服务返回：<code>' + esc(String(u.query.error)) + '</code>'
      + (u.query.error_description ? '<br>' + esc(String(u.query.error_description)) : ''));
  }

  const state = String(u.query.state || '');
  const code = String(u.query.code || '');
  if (!code) return deny('缺少授权码', '这次跳转没有带 <code>code</code>，无法确认身份。');

  const chk = consumeNonce(state);
  if (!chk.ok) {
    /* 三种失败分开提示：用户的动作不同（重试 vs 联系管理员），
       混成一句「校验失败」反而难排查。 */
    const why = chk.reason === 'expired' ? '登录链接已过期（超过 10 分钟）'
      : chk.reason === 'missing' ? '这次跳转没有带校验参数'
        : '校验参数无效或已被使用过';
    db.logAudit({ user: '(未登录)', module: 'auth', action: 'SSO登录被拒', details: 'state ' + chk.reason });
    return deny('登录校验未通过', esc(why) + '。<br>请回到平台重新发起登录。');
  }

  /* 换工号。任何一步失败都要把「错在哪一步」写清楚 —— 联调期全靠它。 */
  let exchanged;
  try {
    exchanged = await exchangeCode(code);
  } catch (e) {
    const stepText = e.step === 'field' ? '已连上换工号接口，但返回体里找不到工号字段'
      : e.step === 'token' ? '换工号接口调用失败' : '换工号过程出错';
    console.error('[sso] ' + stepText + '：' + e.message + (e.body ? ' | ' + e.body : ''));
    db.logAudit({
      user: '(未登录)', module: 'auth', action: 'SSO换取工号失败',
      details: stepText + '：' + e.message
    });
    return deny('登录失败：' + stepText,
      esc(e.message)
      + (e.body ? '<p class="d">原始返回：<code>' + esc(e.body) + '</code></p>' : '')
      + '<p class="d">这是配置问题，请联系管理员核对 <code>data/sso/secret.json</code>。</p>');
  }

  /* 联调模式：只把结果打日志，不建会话 —— 避免用错配置把人放进平台 */
  if (CONFIG.debug) {
    console.log('[sso][debug] 换到工号 = ' + exchanged.empNo + '，姓名 = ' + (exchanged.name || '-'));
    console.log('[sso][debug] 返回体字段 = ' + JSON.stringify(Object.keys(exchanged.raw || {})));
    return sendText(res, 200,
      '<h1>联调模式（未登录）</h1>'
      + '<p>工号：<code>' + esc(exchanged.empNo) + '</code></p>'
      + '<p>姓名：<code>' + esc(exchanged.name || '（返回体里没有）') + '</code></p>'
      + '<p class="d">debug 模式不建会话。确认工号无误后把 <code>data/sso/secret.json</code> '
      + '里的 <code>debug</code> 改回 false 再正式启用。</p>');
  }

  /* 工号必须已经在 users 表里 —— 不静默建号。
     静默建号等于「公司任何人登录一次就能进平台」，权限体系直接失控。
     批量开号走 user-import.js，由管理员控制。 */
  const user = db.findUser(exchanged.empNo);
  if (!user) {
    db.logAudit({
      user: '(未登录)', module: 'auth', action: 'SSO登录被拒',
      details: '工号未开户：' + exchanged.empNo + (exchanged.name ? '（' + exchanged.name + '）' : '')
    });
    return deny('账号未开通',
      '你的工号 <code>' + esc(exchanged.empNo) + '</code> 还没有在平台开户。<br>'
      + '请联系管理员导入员工名单后再试。');
  }
  if (!user.enabled) {
    db.logAudit({
      user: user.id, user_name: user.name, module: 'auth',
      action: 'SSO登录被拒', details: '账号已停用'
    });
    return deny('账号已停用', '你的账号已被管理员停用，请联系管理员。');
  }

  const { token } = db.createSession(user.id);
  setSessionCookie(res, token, 30 * 86400);
  db.logAudit({
    user_id: user.id, user: user.name, module: 'auth', action: '登录',
    details: 'SSO（角色 ' + user.role + '）'
  });

  res.writeHead(302, { Location: chk.next, 'Cache-Control': 'no-store' });
  res.end();
}

/** GET /sso/status —— 供登录页判断要不要显示「公司统一认证登录」按钮 */
function handleStatus(req, res) {
  return sendJson(res, 200, {
    configured: isConfigured(),
    missing: missingConfig(),
    redirectUri: CONFIG.redirectUri,
    debug: !!CONFIG.debug
  });
}

/**
 * 模块入口。
 * 注意前缀不是 /api/sso —— SSO 是页面级 302 跳转，挂在站点根路径下，
 * 由 server.js 作为内置路由分发（不走 module-loader 的 /api 前缀机制）。
 */
function handle(req, res, u) {
  const p = u.pathname;
  if (p === '/sso/login') return handleLogin(req, res, u);
  if (p === '/sso/callback') return handleCallback(req, res, u);
  if (p === '/sso/status') return handleStatus(req, res, u);
  sendJson(res, 404, { error: 'Not Found' });
  return undefined;
}

module.exports = {
  id: 'sso',
  paths: ['/sso/login', '/sso/callback', '/sso/status'],
  handle,
  /* 供测试与运维使用 */
  CONFIG: CONFIG,
  SECRET_FILE: SECRET_FILE,
  isConfigured: isConfigured,
  missingConfig: missingConfig,
  /* 暴露内部 nonce 表只为测试：过期分支没法靠等 10 分钟来验，
     测试直接改表里的 createdAt 把它老化。生产代码不要读它。 */
  _nonces: _nonces,
  newNonce: newNonce,
  consumeNonce: consumeNonce,
  safeNext: safeNext,
  dig: dig
};
