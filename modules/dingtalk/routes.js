/* modules/dingtalk/routes.js — 钉钉身份打通（免登 + 权限透传）
 *
 * ── 这个模块干什么 ─────────────────────────────────────────────────
 * 「你在钉钉里能看的，平台上就能看」—— 拆成两件事，缺一不可：
 *
 *   ① 身份打通（免登）：证明「你是钉钉里的哪个人」→ 落到平台的 users 表
 *      同一个会话 wb_session，下游权限门禁/审计完全不用改。
 *
 *   ② 权限透传：换一张【用户级】钉钉 access_token，代表你本人。
 *      拿它去调钉钉接口，钉钉按【你的可见范围】鉴权。
 *      ⭐ 关键结论：平台【不需要自己维护文档权限表】——
 *         权限的真相在钉钉那边，平台只做转发与呈现。
 *         这也是为什么「打通」不等于「同步某份指定文档」。
 *
 * ── 为什么不走 302 回调（与 SSO 模块的最大区别）─────────────────────
 * SSO 那条路是：浏览器 → SSO 认证页 → 【SSO 跳回平台】。
 * 钉钉免登是：钉钉客户端内页面 → JSAPI 拿 authCode → 【前端 POST 给平台】。
 * 后者钉钉服务器从不访问平台，所以：
 *   · 不需要回调域名白名单
 *   · 纯内网 IP（10.63.139.103:9680）直接可用
 *   · 不用 state 防重放？—— 仍然要，见下
 * 这也是本模块【不注册 /dingtalk/callback】的原因：根本没有回跳这一步。
 * 因此它走 module-loader 的标准 /api/dingtalk 前缀，不需要 server.js 特判。
 *
 * ── authCode 一次性：顺序不能反 ────────────────────────────────────
 * 先用 code 换 userid（决定能不能登录），再用 code 换用户 token（锦上添花）。
 * 反过来的话：token 换成功、userid 换失败 → 谁都登不进来。
 * 现在的顺序最坏是「登进来了但文档功能暂不可用」，用户能干活且原因可查。
 * ⚠ 待实测：若钉钉不允许同一个 authCode 用两次，正确修法是让前端调两次
 *   requestAuthCode，【不是】把顺序调回来。
 *
 * ── 不静默建号（与 SSO 同一条铁律）────────────────────────────────
 * 钉钉里存在但平台没开户的人 → 明确拒绝 + 记审计。
 * 静默建号等于「公司两万人谁用钉钉点一下就能进平台」，权限体系直接失控。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const db = require('../../db');
const client = require('./client');

/* ---------- 会话 Cookie（与 auth / sso 模块同名同属性）----------
 * 三处各写一份是刻意的：不一致会出很隐蔽的 bug
 * （例：钉钉登录后改密码接口读不到会话）。改属性必须三处同时改。
 * 另两处：modules/auth/routes.js、modules/sso/routes.js */
const COOKIE = 'wb_session';
const SRC_COOKIE = 'wb_auth_src';

/* 钉钉会话给多久？
 * 比 SSO 的 8 小时长、比本地密码的 30 天短。
 * 理由：免登成本极低（在钉钉里点一下卡片就进来了），不需要靠长会话省事；
 * 但每次打开平台都重新授权又太烦。12 小时 = 一个工作日，次日重新点一下。 */
const SESSION_TTL_SEC = 12 * 3600;

/* ---------- 小工具（沿用 auth 模块的写法，保持一致）---------- */

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

/** 只允许站内相对路径，防开放重定向（与 SSO 模块 safeNext 同规则） */
function safeNext(next) {
  const s = String(next || '');
  if (s.charAt(0) !== '/' || s.charAt(1) === '/') return '/';
  return s;
}

function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie', [
    COOKIE + '=' + encodeURIComponent(token) +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec,
    /* src 取值 dingtalk —— 前端退出时据此决定要不要提示「也退钉钉」 */
    SRC_COOKIE + '=dingtalk; Path=/; SameSite=Lax; Max-Age=' + maxAgeSec
  ]);
}

/* 注意这里【没有】clearSessionCookie ——
   退出的会话清理统一归 /api/auth/logout，本模块只负责清用户级 token。 */

/* ---------- 工号快照（org.json）----------
 *
 * 为什么要有这一步：钉钉返回的是 userId（如 977186094），
 * 而平台主键是工号（如 10003646）。两者之间只隔一个 job_number。
 *
 * 取 job_number 有两条路：
 *   A. 实时调 /topapi/v2/user/get    —— 准，但每次登录多一次外网请求
 *   B. 读 data/dingtalk/org.json 快照 —— 快，但有滞后（要跑过一次同步才有）
 * 这里 A+B 都用：先查快照，查不到再实时调。
 * 快照是 dingtalk-sync.js 的产物，可能不存在（新部署、没跑过同步），
 * 所以读不到时必须优雅降级到 A，不能因此拒绝登录。
 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '../../data');
const ORG_FILE = path.join(DATA_DIR, 'dingtalk', 'org.json');

let _orgCache = null;    // { mtimeMs, byUserId: Map }
function orgByUserId() {
  try {
    const st = fs.statSync(ORG_FILE);
    if (_orgCache && _orgCache.mtimeMs === st.mtimeMs) return _orgCache.byUserId;
    const raw = JSON.parse(fs.readFileSync(ORG_FILE, 'utf8'));
    const m = new Map();
    for (const u of (raw.users || [])) {
      if (u.userId) m.set(String(u.userId), u);
    }
    _orgCache = { mtimeMs: st.mtimeMs, byUserId: m };
    return m;
  } catch (e) {
    return null;   // 没快照 = 正常情况，调用方会回退到实时查
  }
}

/* ---------- 身份匹配 ---------- */

/**
 * 把钉钉 userId 落到平台账号上。三道匹配，逐级降级。
 *
 * ① users.dingtalk_id —— 已经绑过的，最快最准
 * ② 工号 = users.id    —— 主口径。工号稳定、唯一，且与 SSO 的 idField 同口径
 * ③ 姓名              —— 【刻意不做】。重名会认错人，认错人比不让进更糟
 *
 * @returns {Promise<{user:object|null, dingtalkUserId:string, jobNumber:string, name:string, via:string}>}
 */
async function matchUser(dingtalkUserId) {
  const out = { user: null, dingtalkUserId: dingtalkUserId, jobNumber: '', name: '', via: '' };

  const bound = db.findUserByDingtalkId(dingtalkUserId);
  if (bound) {
    out.user = bound;
    out.via = 'dingtalk_id';
    return out;
  }

  /* 拿工号：先快照后实时 */
  let jobNumber = '';
  let name = '';
  const snap = orgByUserId();
  const hit = snap ? snap.get(String(dingtalkUserId)) : null;
  if (hit) {
    jobNumber = String(hit.jobNumber || '');
    name = String(hit.name || '');
  }
  if (!jobNumber) {
    /* 快照里没有（新人、或快照还没更新）→ 实时查一次。
       这一步失败不让登录整体失败：把原因带出去，由调用方决定怎么提示。 */
    try {
      const d = await client.getUserDetail(dingtalkUserId);
      jobNumber = d.jobNumber;
      name = d.name || name;
    } catch (e) {
      out.error = '取钉钉用户详情失败：' + e.message;
      return out;
    }
  }
  out.jobNumber = jobNumber;
  out.name = name;

  if (!jobNumber) {
    out.error = '钉钉里这个人的工号（job_number）是空的，无法与平台账号对应';
    return out;
  }

  const user = db.findUser(jobNumber);
  if (user) {
    out.user = user;
    out.via = 'jobNumber';
    return out;
  }
  out.error = '工号 ' + jobNumber + ' 未在平台开户';
  return out;
}

/* ---------- 路由 ---------- */

/** GET /api/dingtalk/status —— 登录页据此决定要不要显示钉钉入口 */
function handleStatus(req, res) {
  const cfg = client.loadConfig();
  const miss = [];
  if (client.missing(cfg.appKey)) miss.push('appKey');
  if (client.missing(cfg.appSecret)) miss.push('appSecret');
  if (client.missing(cfg.corpId)) miss.push('corpId');
  return sendJson(res, 200, {
    configured: miss.length === 0,
    missing: miss,
    /* corpId 要给前端 JSAPI 用（dd.runtime.permission.requestAuthCode({ corpId })）。
       它不是密钥 —— 企业 ID 在钉钉客户端里人人可见，所以可以下发。
       appSecret 绝不下发。 */
    corpId: client.missing(cfg.corpId) ? '' : cfg.corpId,
    tokenCache: client.userTokenStats()
  });
}

/**
 * POST /api/dingtalk/login —— 免登
 * body: { authCode, next }
 *
 * 前端在钉钉客户端里调 dd.runtime.permission.requestAuthCode({ corpId })
 * 拿到 authCode，POST 到这里。平台端完成：
 *   换身份 → 匹配账号 → 换用户 token（权限透传）→ 建会话
 */
async function handleLogin(req, res) {
  const body = await readBody(req);
  const authCode = String(body.authCode || body.code || '');
  const next = safeNext(body.next);

  if (!authCode) return sendJson(res, 400, { error: '缺少 authCode' });

  /* ① 换钉钉身份 —— 这一步决定能不能登录 */
  let info;
  try {
    info = await client.getUserInfoByCode(authCode);
  } catch (e) {
    console.error('[dingtalk] 换身份失败：' + e.message + (e.body ? ' | ' + e.body : ''));
    db.logAudit({
      user: '(未登录)', module: 'auth', action: '钉钉登录被拒',
      details: '换身份失败：' + e.message
    });
    return sendJson(res, 502, {
      error: '钉钉身份校验失败：' + e.message,
      step: e.step || 'userinfo'
    });
  }

  /* ② 匹配平台账号 */
  const m = await matchUser(info.userId);
  if (!m.user) {
    db.logAudit({
      user: '(未登录)', module: 'auth', action: '钉钉登录被拒',
      details: (m.error || '未匹配到账号') +
        '（钉钉 userId=' + info.userId + (info.name ? '，姓名 ' + info.name : '') + '）'
    });
    return sendJson(res, 403, {
      error: m.error || '钉钉身份未在平台开户',
      dingtalkUserId: info.userId,
      jobNumber: m.jobNumber,
      name: m.name || info.name,
      hint: '请联系管理员在「系统设置 → 用户管理」里核对工号'
    });
  }
  if (!m.user.enabled) {
    db.logAudit({
      user: m.user.id, user_name: m.user.name, module: 'auth',
      action: '钉钉登录被拒', details: '账号已停用'
    });
    return sendJson(res, 403, { error: '账号已停用，请联系管理员' });
  }

  /* ③ 记下绑定关系。首次登录通过后回填，下次走 ① 这条快路。
     只补空值，不覆盖已有的绑定（换人换号是可追溯的事，不该被静默改掉）。 */
  if (!m.user.dingtalk_id) {
    try { db.setDingtalkId(m.user.id, info.userId); } catch (e) { /* 记不上不影响本次登录 */ }
  }

  /* ④ 换用户级 token（权限透传）。
     ★ 失败【不阻断登录】：身份已确认，权限透传是增强。
       把 passthrough 状态返回给前端，让用户知道「文档类功能暂不可用」，
       而不是整个登不进来 —— 那才是把好事做成坏事。 */
  let passthrough = false, passErr = '';
  let plainToken = null;
  try {
    const t = await client.exchangeUserToken(authCode);
    client.putUserToken(m.user.id, t);
    passthrough = true;
    plainToken = t.accessToken;
  } catch (e) {
    passErr = e.message;
    console.warn('[dingtalk] 权限透传 token 换取失败（不影响登录）：' + e.message);
  }

  /* ⑤ 建会话 */
  const { token } = db.createSession(m.user.id, SESSION_TTL_SEC);
  setSessionCookie(res, token, SESSION_TTL_SEC);

  db.logAudit({
    user_id: m.user.id, user: m.user.name, module: 'auth', action: '登录',
    details: '钉钉免登（角色 ' + m.user.role + '，匹配方式 ' + m.via +
      '，权限透传 ' + (passthrough ? '已建立' : '未建立：' + passErr) + '）'
  });

  /* ⚠ 这里绝不返回 token 本身。会话凭证只走 HttpOnly Cookie，
     不进 JSON 体 —— 否则前端一旦把它存进 localStorage，
     XSS 就能直接偷走。plainToken 只用来判断是否拿到了，用完即弃。 */
  void plainToken;

  return sendJson(res, 200, {
    ok: true,
    next: next,
    user: { id: m.user.id, name: m.user.name, role: m.user.role },
    matchedBy: m.via,
    passthrough: passthrough,
    passthroughError: passthrough ? '' : passErr
  });
}

/**
 * POST /api/dingtalk/logout —— 退出时清掉用户级 token（权限透传凭证）。
 *
 * ★ 职责边界：这里【不】删会话、【不】清 Cookie，那两件事归 /api/auth/logout。
 *   所以调用顺序必须是【先这里、后 auth】——
 *   本端点靠 Cookie 认人，auth 那边一执行 Cookie 就没了，顺序反了就清不掉 token。
 *
 * token 只在内存里，进程重启也会没，为什么还要专门清一次？
 * 因为不清的话，退出登录后【同一台机器上下一个人登录前】，
 * 前一个人的用户 token 还挂在内存里，能继续以他的身份调钉钉接口。
 * 共用电脑的场景下这是实打实的越权。 */
async function handleLogout(req, res) {
  const me = require('../auth/routes').currentUser(req);
  if (me) client.clearUserToken(me.id);
  db.logAudit({
    user_id: me ? me.id : null, user: me ? me.name : '(未登录)',
    module: 'auth', action: '钉钉登出',
    details: me ? '已清除用户级 token（权限透传）' : '会话已失效，无 token 可清'
  });
  return sendJson(res, 200, { ok: true, cleared: !!me });
}

/**
 * GET /api/dingtalk/me —— 我当前绑定的钉钉身份与透传状态。
 * 这是「权限透传确实通了」的自证点：前端拿它显示「已绑定 张三(钉钉)」。
 */
function handleMe(req, res) {
  const me = require('../auth/routes').currentUser(req);
  if (!me) return sendJson(res, 401, { error: '未登录' });
  const u = db.findUser(me.id) || {};
  const t = client.getUserToken(me.id);
  return sendJson(res, 200, {
    id: me.id,
    name: me.name,
    department: u.department || '',
    dingtalkId: u.dingtalk_id || '',
    bound: !!u.dingtalk_id,
    /* 有 token = 现在就能用你本人的身份调钉钉接口（权限透传可用） */
    passthrough: !!t,
    passthroughExpiresIn: t ? Math.max(0, Math.round((t.expireAt - Date.now()) / 1000)) : 0,
    loginConfigured: client.isLoginConfigured()
  });
}

/* ---------- 模块导出 ---------- */

function handle(req, res, u) {
  const p = u.pathname;
  const method = req.method;

  if (p === '/api/dingtalk/status' && method === 'GET') return handleStatus(req, res);
  if (p === '/api/dingtalk/login' && method === 'POST') return handleLogin(req, res);
  if (p === '/api/dingtalk/logout' && method === 'POST') return handleLogout(req, res);
  if (p === '/api/dingtalk/me' && method === 'GET') return handleMe(req, res);

  return sendJson(res, 404, { error: 'Not Found' });
}

module.exports = {
  id: 'dingtalk',
  prefix: '/api/dingtalk',
  resource: 'dingtalk',
  handle,
  /* 供测试 */
  safeNext: safeNext,
  matchUser: matchUser,
  orgByUserId: orgByUserId,
  SESSION_TTL_SEC: SESSION_TTL_SEC
};
