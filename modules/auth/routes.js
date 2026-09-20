/* modules/auth/routes.js — 账号 / 会话 / 权限
   服务端身份的唯一来源。会话存在 SQLite（见 db.js），
   浏览器只拿一个不透明的 token 放在 HttpOnly Cookie 里。

   端点：
     POST /api/auth/login    {账号, 口令}          → 种 Cookie，返回用户信息
     POST /api/auth/logout                          → 清 Cookie + 删会话
     GET  /api/auth/me                              → 当前用户（未登录返回 {user:null}）
     POST /api/auth/password {旧口令, 新口令}       → 改自己的口令
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

/* ---------- 路由 ---------- */

async function handle(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  /* ---- 登录 ---- */
  if (p === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const id = String(b.id || b.name || '').trim();
    const pwd = String(b.password || '');
    if (!id || !pwd) return sendJson(res, 400, { error: '请填写账号和口令' });

    const u = db.findUser(id);
    /* 用户不存在 / 口令错 / 被停用，统一回同一句话，不泄露哪个环节错 */
    if (!u || !u.enabled || !db.verifyPassword(pwd, u.password_hash)) {
      return sendJson(res, 401, { error: '账号或口令不正确' });
    }

    const { token } = db.createSession(u.id);
    setCookie(res, token, 30 * 86400);
    db.logAudit({
      user_id: u.id, user: u.name, module: 'auth', action: '登录',
      details: '角色 ' + u.role
    });
    return sendJson(res, 200, {
      ok: true,
      user: { id: u.id, name: u.name, role: u.role },
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
    return sendJson(res, 200, {
      user: me,
      permissions: db.listPermissions(me.role),
      isAdmin: me.role === 'admin'
    });
  }

  /* ---- 改自己的口令 ---- */
  if (p === '/api/auth/password' && method === 'POST') {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const b = await readBody(req);
    const u = db.findUser(me.id);
    if (!db.verifyPassword(String(b.oldPassword || ''), u.password_hash)) {
      return sendJson(res, 400, { error: '原口令不正确' });
    }
    const np = String(b.newPassword || '');
    if (np.length < 6) return sendJson(res, 400, { error: '新口令至少 6 位' });
    db.setPassword(me.id, np);
    db.logAudit({ user_id: me.id, user: me.name, module: 'auth', action: '改口令' });
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
      if (np.length < 6) return sendJson(res, 400, { error: '口令至少 6 位' });
      db.setPassword(target, np);
      db.logAudit({
        user_id: me.id, user: me.name, module: 'auth', action: '重置口令', details: target
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
