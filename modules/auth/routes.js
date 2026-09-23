/* modules/auth/routes.js — 账号 / 会话 / 权限
   服务端身份的唯一来源。会话存在 SQLite（见 db.js），
   浏览器只拿一个不透明的 token 放在 HttpOnly Cookie 里。

   端点：
     POST /api/auth/login    {账号, 密码}          → 种 Cookie，返回用户信息
     POST /api/auth/logout                          → 清 Cookie + 删会话
     GET  /api/auth/me                              → 当前用户（未登录返回 {user:null}）
     POST /api/auth/password {旧密码, 新密码}       → 改自己的密码
     GET  /api/auth/users                           → 用户列表（仅 admin）
     POST /api/auth/users    {id,name,role,password}→ 建用户（仅 admin）
     POST /api/auth/users/role    {id, role}        → 改角色（仅 admin）
     POST /api/auth/users/enable  {id, enabled}     → 启用/停用（仅 admin）
     GET  /api/auth/permissions?role=pm             → 角色权限（admin 可查任意角色）

   ★ 与 ACCESS_TOKEN 的关系：两者并存，不冲突。
     ACCESS_TOKEN 是「整个平台进不来」的粗门禁，先于本模块执行；
     本模块解决的是「进来了之后你是谁、你能干什么」。 */

'use strict';

const db = require('../../db');

const COOKIE = 'wb_session';

/* ---------- 小工具 ---------- */

function readBody(req, limit) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > (limit || 65536)) req.destroy();
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

/** 从 Cookie 头里取会话 token */
function tokenOf(req) {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

/** 种会话 Cookie。HttpOnly 防脚本读取；SameSite=Lax 防跨站带票 */
function setCookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie',
    COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/* ---------- 身份解析（server.js 也用它做权限门禁）---------- */

/**
 * 从请求解析当前用户。
 * @returns {{id:string,name:string,role:string}|null}
 */
function currentUser(req) {
  try {
    return db.sessionUser(tokenOf(req));
  } catch (e) {
    return null;
  }
}

/** 该用户是否拥有某资源权限（admin 恒真） */
function can(user, resource) {
  if (!user) return false;
  try { return db.hasPermission(user.role, resource); } catch (e) { return false; }
}

/* ---------- 登录节流（纯内存，不落库） ----------

   为什么要有：批量建号的初始密码是【同一批次规则相同】的，而登录接口原本
   无限次可试。scryptSync 单次 69ms（实测），单核约 14.5 次/秒 —— 6 位纯数字
   密码单核跑 19 小时就能撞开，成本太低。

   为什么放内存而不是 SQLite 表：
     1. 这是瞬时限流，不是业务数据，重启即清空是可以接受的（甚至更好：重启后
        管理员本来就该能立刻登录）；
     2. 加表要改 schema + 写迁移，为一个限流器不划算。

   锁定的粒度是【账号】，不是 IP：本平台跑在内网、多半前面还有 NAT，按 IP 锁
   会一个人试错就把整间办公室锁在门外。账号锁定 + 下面那层全局熔断足够。 */
const LOCK_STEPS = [
  { after: 5, ms: 60 * 1000 },        // 连错 5 次 → 锁 1 分钟
  { after: 10, ms: 5 * 60 * 1000 },   // 10 次 → 锁 5 分钟
  { after: 15, ms: 30 * 60 * 1000 }   // 15 次 → 锁 30 分钟
];
const LOCK_MAX_MS = 30 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;   // 超过这个时间没再失败，计数清零
const MAX_ENTRIES = 500;                 // 上限，防内存被灌爆
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_MAX_FAILS = 50;             // 全站 1 分钟内失败上限（挡「换账号名扫」）

/** key → { fails, firstFailAt, lastFailAt, lockedUntil } */
const _fails = new Map();
let _globalFails = [];   // 最近 1 分钟内失败的时间戳

/** 到这个账号下次能试为止还要等多少毫秒；0 表示没锁 */
function lockRemaining(key) {
  const e = _fails.get(key);
  if (!e || !e.lockedUntil) return 0;
  const left = e.lockedUntil - Date.now();
  if (left <= 0) { e.lockedUntil = 0; return 0; }
  return left;
}

/** 记一次失败，必要时上锁 */
function recordFail(key) {
  const now = Date.now();
  let e = _fails.get(key);
  /* 距上次失败已经过了窗口期 → 当作新一轮，从 0 开始 */
  if (!e || now - e.lastFailAt > FAIL_WINDOW_MS) e = { fails: 0, firstFailAt: now, lastFailAt: 0, lockedUntil: 0 };
  e.fails += 1;
  e.lastFailAt = now;

  for (const s of LOCK_STEPS) {
    if (e.fails >= s.after) e.lockedUntil = now + Math.min(s.ms, LOCK_MAX_MS);
  }
  _fails.set(key, e);

  /* 顺手扫掉过期条目。只在失败时扫，登录成功路径上没有额外开销。 */
  if (_fails.size > MAX_ENTRIES) {
    for (const [k, v] of _fails) {
      if (now - v.lastFailAt > FAIL_WINDOW_MS && !lockRemaining(k)) _fails.delete(k);
    }
  }
  _globalFails.push(now);
}

/** 登录成功 → 清掉这个账号的失败记录 */
function clearFails(key) {
  _fails.delete(key);
}

/** 全站熔断：1 分钟内失败次数超上限就暂时拒绝所有登录尝试 */
function globalBlocked() {
  const now = Date.now();
  _globalFails = _globalFails.filter(t => now - t < GLOBAL_WINDOW_MS);
  return _globalFails.length >= GLOBAL_MAX_FAILS;
}

/* ---------- 路由 ---------- */

async function handle(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  /* ---- 登录 ---- */
  if (p === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const id = String(b.id || b.name || '').trim();
    const pwd = String(b.password || '');
    if (!id || !pwd) return sendJson(res, 400, { error: '请填写账号和密码' });

    /* 节流先于任何查库/验密码的动作 —— 被锁时一个字符都不该再算 */
    const left = lockRemaining(id);
    if (left > 0) {
      return sendJson(res, 429, {
        error: '尝试过于频繁，请 ' + Math.ceil(left / 60000) + ' 分钟后再试'
      });
    }
    if (globalBlocked()) {
      return sendJson(res, 429, { error: '登录尝试过于频繁，请稍后再试' });
    }

    const u = db.findUser(id);
    /* 用户不存在 / 密码错 / 被停用，统一回同一句话，不泄露哪个环节错 */
    if (!u || !u.enabled || !db.verifyPassword(pwd, u.password_hash)) {
      recordFail(id);
      /* 这一次失败刚好触发了锁定 —— 必须明说「等一会」，不能照旧回
         「账号或密码不正确」。否则用户以为自己记错了密码，会在这个 60 秒
         里反复重试，每次都撞在同一堵墙上，只会更困惑。
         这不算账号枚举：走到这一句的人，必然是已经把这个 id 试错过 5 次的人，
         而在此之前任何 id 的返回都是一模一样的。 */
      const nowLeft = lockRemaining(id);
      if (nowLeft > 0) {
        return sendJson(res, 429, {
          error: '密码连续输错，账号已临时锁定，请 ' + Math.ceil(nowLeft / 60000) + ' 分钟后再试'
        });
      }
      return sendJson(res, 401, { error: '账号或密码不正确' });
    }

    /* 登录成功 → 清掉这个账号的失败记录，不给「再错几次就被锁」留隐患 */
    clearFails(id);

    const { token } = db.createSession(u.id);
    setCookie(res, token, 30 * 86400);
    db.logAudit({
      user_id: u.id, user: u.name, module: 'auth', action: '登录',
      details: '角色 ' + u.role
    });
    return sendJson(res, 200, {
      ok: true,
      user: { id: u.id, name: u.name, role: u.role },
      isInitialPwd: !!u.pwd_is_initial,   // 还在用批量建号发的初始密码 → 前端给可关闭的提示条
      permissions: db.listPermissions(u.role)
    });
  }

  /* ---- 登出 ---- */
  if (p === '/api/auth/logout' && method === 'POST') {
    const me = currentUser(req);
    db.destroySession(tokenOf(req));
    clearCookie(res);
    if (me) db.logAudit({ user_id: me.id, user: me.name, module: 'auth', action: '登出' });
    return sendJson(res, 200, { ok: true });
  }

  /* ---- 当前用户 ---- */
  if (p === '/api/auth/me' && method === 'GET') {
    const me = currentUser(req);
    if (!me) return sendJson(res, 200, { user: null });
    const u = db.findUser(me.id);
    return sendJson(res, 200, {
      user: me,
      isInitialPwd: !!(u && u.pwd_is_initial),
      permissions: db.listPermissions(me.role),
      isAdmin: me.role === 'admin'
    });
  }

  /* ---- 改自己的密码 ---- */
  if (p === '/api/auth/password' && method === 'POST') {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const b = await readBody(req);
    const u = db.findUser(me.id);
    if (!db.verifyPassword(String(b.oldPassword || ''), u.password_hash)) {
      return sendJson(res, 400, { error: '原密码不正确' });
    }
    const np = String(b.newPassword || '');
    if (np.length < 6) return sendJson(res, 400, { error: '新密码至少 6 位' });
    db.setPassword(me.id, np);
    db.logAudit({ user_id: me.id, user: me.name, module: 'auth', action: '改密码' });
    return sendJson(res, 200, { ok: true });
  }

  /* ---- 以下仅管理员 ---- */
  const needAdmin = p === '/api/auth/users' || p.startsWith('/api/auth/users/');
  if (needAdmin) {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    if (me.role !== 'admin') return sendJson(res, 403, { error: '仅管理员可操作' });

    if (p === '/api/auth/users' && method === 'GET') {
      return sendJson(res, 200, db.listUsers());
    }

    if (p === '/api/auth/users' && method === 'POST') {
      const b = await readBody(req);
      try {
        const u = db.createUser({
          id: String(b.id || '').trim(),
          name: String(b.name || '').trim(),
          password: String(b.password || ''),
          role: String(b.role || 'viewer')
        });
        db.logAudit({
          user_id: me.id, user: me.name, module: 'auth', action: '新建用户',
          details: u.id + '（' + u.role + '）'
        });
        return sendJson(res, 200, { ok: true, user: { id: u.id, name: u.name, role: u.role } });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (p === '/api/auth/users/role' && method === 'POST') {
      const b = await readBody(req);
      const target = String(b.id || '');
      if (target === me.id) return sendJson(res, 400, { error: '不能改自己的角色' });
      if (!db.findUser(target)) return sendJson(res, 404, { error: '用户不存在' });
      db.setRole(target, String(b.role || 'viewer'));
      db.logAudit({
        user_id: me.id, user: me.name, module: 'auth', action: '改角色',
        details: target + ' → ' + b.role
      });
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/auth/users/enable' && method === 'POST') {
      const b = await readBody(req);
      const target = String(b.id || '');
      if (target === me.id) return sendJson(res, 400, { error: '不能停用自己' });
      if (!db.findUser(target)) return sendJson(res, 404, { error: '用户不存在' });
      const on = b.enabled ? 1 : 0;
      db.get().prepare('UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?')
        .run(on, new Date().toISOString(), target);
      db.logAudit({
        user_id: me.id, user: me.name, module: 'auth',
        action: on ? '启用用户' : '停用用户', details: target
      });
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/auth/users/password' && method === 'POST') {
      const b = await readBody(req);
      const target = String(b.id || '');
      if (!db.findUser(target)) return sendJson(res, 404, { error: '用户不存在' });
      const np = String(b.password || '');
      if (np.length < 6) return sendJson(res, 400, { error: '密码至少 6 位' });
      db.setPassword(target, np);
      db.logAudit({
        user_id: me.id, user: me.name, module: 'auth', action: '重置密码', details: target
      });
      return sendJson(res, 200, { ok: true });
    }
  }

  /* ---- 查权限（管理员可查任意角色，其他人只能查自己）---- */
  if (p === '/api/auth/permissions' && method === 'GET') {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const role = String(url.query.role || me.role);
    if (role !== me.role && me.role !== 'admin') {
      return sendJson(res, 403, { error: '只能查看自己角色的权限' });
    }
    return sendJson(res, 200, { role, resources: db.listPermissions(role) });
  }

  return sendJson(res, 404, { error: 'Not Found' });
}

/** 首启时确保库已就绪（建表 + 默认权限 + 默认管理员） */
function ensureData() {
  db.open();
}

module.exports = {
  id: 'auth',
  prefix: '/api/auth',
  handle,
  ensureData,
  /* 供 server.js 的门禁使用 */
  currentUser,
  can
};
