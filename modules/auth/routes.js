/* modules/auth/routes.js — 账号 / 会话 / 权限
   服务端身份的唯一来源。会话存在 SQLite（见 db.js），
   浏览器只拿一个不透明的 token 放在 HttpOnly Cookie 里。

   端点：
     POST /api/auth/login    {账号, 密码}          → 种 Cookie，返回用户信息
     POST /api/auth/logout                          → 清 Cookie + 删会话
     GET  /api/auth/me                              → 当前用户（未登录返回 {user:null}）
     POST /api/auth/password {旧密码, 新密码}       → 改自己的密码
     GET  /api/auth/users                           → 用户列表（仅 admin）
     POST /api/auth/users    {id,name,role,kind,prefix} → 建用户 + 一次性返回初始密码（仅 admin）
     POST /api/auth/users/role    {id, role}        → 改角色（仅 admin）
     POST /api/auth/users/enable  {id, enabled}     → 启用/停用（仅 admin）
     GET  /api/auth/permissions?role=editor         → 角色权限（admin 可查任意角色）
     GET  /api/auth/permissions/matrix              → 权限矩阵全量（仅 admin）
     POST /api/auth/permissions  {role,resource,allowed} → 改一格权限（仅 admin）

   ★ 与 ACCESS_TOKEN 的关系：两者并存，不冲突。
     ACCESS_TOKEN 是「整个平台进不来」的粗门禁，先于本模块执行；
     本模块解决的是「进来了之后你是谁、你能干什么」。 */

'use strict';

const db = require('../../db');
const teams = require('../../teams');
const passwordRule = require('../../password-rule');
/* ⚠ module-loader 不在这里顶层 require —— 会和它形成循环依赖：
     module-loader.loadAll() → require(modules/auth/routes.js) → require(module-loader)
   此时 module-loader 的 module.exports 还没赋值，拿到的是空对象，
   而它最后用的是 `module.exports = {...}`（换对象），不是往旧对象上挂属性，
   所以这个空对象永远不会被填充。表现是 matrixResources 里 moduleLoader.listResources
   不是函数 —— 且只在「先加载 auth 模块」的入口上复现，很难查。
   放到函数里惰性 require，此时缓存已是完整导出的，入口顺序怎么变都不会踩。 */
/* 资源名 → 界面上的中文名 / 分组。权限矩阵靠它把 plan 显示成「项目计划」。
   ⚠ 这张表【只影响显示】，不参与判定：没登记的模块照样能配、照样门禁生效，
   只是那一行显示的是原始 resource 名。判定口径永远只有 resourceOf() 一处，
   界面文案多一份、漏一份都不会影响谁能干什么。 */
const RESOURCE_LABELS = {
  plan: { name: '项目计划', group: '业务模块' },
  iteration: { name: '迭代管理', group: '业务模块' },
  project: { name: '项目管理', group: '业务模块' },
  csenergy: { name: '中盛能源', group: '业务模块' },
  budget: { name: '预算与工时', group: '业务模块' },
  token: { name: 'Token 用量', group: '业务模块' },
  dashboard: { name: '数据看板', group: '业务模块' },
  archive: { name: '归档', group: '业务模块' },
  pradapter: { name: 'PR 适配器', group: '业务模块' },
  skill: { name: 'AI 技能', group: '业务模块' },
  inbox: { name: '今日待确认', group: '业务模块' },
  notify: { name: '钉钉推送', group: '业务模块' },
  dingtalk: { name: '钉钉身份', group: '业务模块' },
  tb: { name: 'TB 数据源', group: '业务模块' },
  platform: { name: '平台配置', group: '平台管理' },
  settings: { name: '系统设置', group: '平台管理' },
  help: { name: '使用说明', group: '平台管理' },
  auth: { name: '账号与会话', group: '平台管理' },
  sso: { name: '单点登录', group: '平台管理' }
};

/* AI 能力不是「模块」，门禁不看路径而是看调用点（skill 模块内部判定），
   所以在 module-loader 注册表里找不到。矩阵要单独列出来 —— 否则
   「可读写」这档的 ai:finance（调财务 Agent）在界面上无处可配。 */
const AI_CAPABILITIES = [
  { resource: 'ai:doc', name: '文档 Agent' },
  { resource: 'ai:risk', name: '风险 Agent' },
  { resource: 'ai:report', name: '周报 Agent' },
  { resource: 'ai:finance', name: '财务 Agent' }
];

/* 资源清单 → 矩阵要显示的行。
   行的两种形态：
     kind='rw'    —— 模块。一对权限点（x:read / x:write），界面给三态选择。
     kind='point' —— AI 能力。单个权限点，界面给开/关。
   清单【不硬编码模块表】：来自 module-loader 注册表（模块自声明 resource）
   + 内置路由表，与门禁 resourceOf() 同一批数据 —— 界面配得出的项，门禁必然认得。 */
function matrixResources() {
  const moduleLoader = require('../../module-loader');   // 惰性，见文件头循环依赖说明
  const rows = moduleLoader.listResources().map(m => {
    const label = RESOURCE_LABELS[m.resource] || {};
    return {
      kind: 'rw',
      resource: m.resource,
      name: label.name || m.resource,
      group: label.group || '其它模块',
      prefix: m.prefix
    };
  });
  AI_CAPABILITIES.forEach(a => {
    rows.push({ kind: 'point', resource: a.resource, name: a.name, group: 'AI 能力', prefix: '' });
  });
  /* 分组内按名字排，组间按固定顺序 —— 免得每次刷新矩阵行都在跳 */
  const order = ['业务模块', '平台管理', 'AI 能力', '其它模块'];
  rows.sort((a, b) => {
    const ga = order.indexOf(a.group), gb = order.indexOf(b.group);
    return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb)
      || String(a.resource).localeCompare(String(b.resource));
  });
  return rows;
}

/** 权限点 → allowed 的查表函数（1 / 0） */
function allowedMap(role) {
  const m = {};
  db.getPermissions(role).forEach(r => { m[r.resource] = r.allowed ? 1 : 0; });
  return m;
}

const COOKIE = 'wb_session';
/* 登录来源标记，与 modules/sso/routes.js 里同名同属性。取值 sso | local。
   前端退出时据此判断要不要通知 SSO 登出 —— 两处常量必须一致。 */
const SRC_COOKIE = 'wb_auth_src';

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
  res.setHeader('Set-Cookie', [
    COOKIE + '=' + encodeURIComponent(token) +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec,
    /* 显式声明「本次是本地账号登录」。SSO 模块登录时会把同一个 Cookie 写成 sso，
       退出时前端据此决定要不要通知 SSO 登出 —— 本地登录的人不该被扔去 SSO 登出页，
       否则会把他【其他系统】的登录态一起退掉。 */
    SRC_COOKIE + '=local; Path=/; SameSite=Lax; Max-Age=' + maxAgeSec
  ]);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', [
    COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    /* 标记必须跟着一起清。否则：SSO 登录 → 退出（标记残留）→ 本地登录 → 再退出，
       第二次退出会误判成 SSO 登录，把用户扔去 SSO 登出页。 */
    SRC_COOKIE + '=; Path=/; SameSite=Lax; Max-Age=0'
  ]);
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
  const needAdmin = p === '/api/auth/users' || p.startsWith('/api/auth/users/')
                    || p === '/api/auth/teams'
                    || p === '/api/auth/permissions/matrix'
                    || (p === '/api/auth/permissions' && method === 'POST');
  if (needAdmin) {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    if (me.role !== 'admin') return sendJson(res, 403, { error: '仅管理员可操作' });

    /* 团队分类清单 + 实际人数。
       给前端下拉用，同时把「声明人数 vs 实际人数」的差当场暴露出来 ——
       差不为 0 就说明库里有人没归到团队（新入职还没来得及入名单），
       这种偏差不该等到对账报告才发现。 */
    if (p === '/api/auth/teams' && method === 'GET') {
      const users = db.listUsers();
      const actual = {};
      let unassigned = 0;
      for (const u of users) {
        const t = teams.teamOf(u.name);
        if (!t) { unassigned++; continue; }
        actual[t] = (actual[t] || 0) + 1;
      }
      const list = teams.all().map(t => ({
        team: t.team,
        declared: t.declared,          // 名单里声明的人数
        count: actual[t.team] || 0     // 库里实际归到该团队的人数
      }));
      /* 名单里有、但库里一个号都没有的团队 —— 也要列出来，不能凭空消失 */
      for (const [t, n] of Object.entries(actual)) {
        if (!list.some(x => x.team === t)) list.push({ team: t, declared: null, count: n });
      }
      return sendJson(res, 200, {
        ready: teams.ready(),
        meta: teams.meta(),
        total: users.length,
        unassigned: unassigned,        // 没有团队分类的用户数（管理员等）
        teams: list
      });
    }

    if (p === '/api/auth/users' && method === 'GET') {
      /* 按团队分类筛选 + 按姓名/工号模糊搜索。
         ★ 团队分类来自 teams.json 的姓名反查，不是 users.department
           （后者是钉钉叶子部门名，68 个值，与本处的 19 个团队不是一个维度）。
         url 是 url.parse(req.url, true) 的旧式对象：只能读 url.query，没有 searchParams。 */
      const dept = String(url.query.dept || '').trim();
      const q = String(url.query.q || '').trim().toLowerCase();

      let rows = db.listUsers().map(u => Object.assign({}, u, { team: teams.teamOf(u.name) }));

      if (dept) rows = rows.filter(u => u.team === dept);
      if (q) {
        rows = rows.filter(u =>
          String(u.name || '').toLowerCase().indexOf(q) >= 0 ||
          String(u.id || '').toLowerCase().indexOf(q) >= 0);
      }

      /* 传 ?plain=1 时直接回数组（兼容老调用方），默认回带统计的对象 */
      if (url.query.plain === '1') return sendJson(res, 200, rows);
      return sendJson(res, 200, {
        users: rows,
        total: rows.length,
        teamsReady: teams.ready()
      });
    }

    if (p === '/api/auth/users' && method === 'POST') {
      const b = await readBody(req);
      try {
        const id = String(b.id || '').trim();
        const name = String(b.name || '').trim();
        const role = String(b.role || db.ROLES.READER);

        /* 服务端生成初始密码（或收下人工指定的一条），不再接受前端传任意密码。
           为什么要改成「服务端算」：
             ① 密码公式是同一份规则，前端算会让规则散到浏览器里，改一次要动两处；
             ② 一次性返回后不落库明文、不回显第二次，比让管理员手抄 CSV 安全。 */
        const chk = passwordRule.validateNewUser({ id, name, prefix: b.prefix, kind: b.kind });
        if (!chk.ok) return sendJson(res, 400, { error: chk.error });
        if (db.ROLE_LIST.indexOf(role) < 0) {
          return sendJson(res, 400, { error: '角色非法，可选：' + db.ROLE_LIST.join(' / ') });
        }

        const cfg = passwordRule.loadConfig({ strict: true });
        /* 显式传了 password 就用它（兼容脚本/联调），否则按公式算。
           外包没有工号，工号段留空 —— buildPassword 走独立分支不加后4位。 */
        const password = b.password
          ? String(b.password)
          : passwordRule.buildPassword(b.prefix, id, cfg, chk.kind);
        if (password.length < 6) {
          return sendJson(res, 400, { error: '按当前规则拼出的密码不足 6 位（' + password + '），请检查姓名缩写与工号' });
        }

        const u = db.createUser({
          id, name, password, role,
          department: b.department ? String(b.department).trim() : null,
          /* 标成初始密码：用户列表要能一眼看出「谁还没改过」，否则这个数只能靠数库 */
          initialPassword: true
        });
        /* ★ 审计【不记密码】。审计日志在界面上给所有人看（操作记录区块），
           把初始密码写进去等于把密码贴到公告栏。只记账号、角色、类型。 */
        db.logAudit({
          user_id: me.id, user: me.name, module: 'auth', action: '新建用户',
          details: u.id + '（' + u.name + '，' + u.role + '，' + chk.kind + '）'
        });
        return sendJson(res, 200, {
          ok: true,
          user: { id: u.id, name: u.name, role: u.role, pwdIsInitial: 1 },
          /* 明文密码只在这里出现一次，前端弹窗给管理员抄；刷新即不可再取。 */
          password
        });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (p === '/api/auth/users/role' && method === 'POST') {
      const b = await readBody(req);
      const target = String(b.id || '');
      if (target === me.id) return sendJson(res, 400, { error: '不能改自己的角色' });
      if (!db.findUser(target)) return sendJson(res, 404, { error: '用户不存在' });
      /* 角色必须落在白名单内。旧代码是 String(b.role || 'viewer')，
         传个拼错的值会静默写库，那人此后 hasPermission 全部查不到记录 = 处处 403，
         而库里的 role 看着又「有个值」，极难查。宁可 400。 */
      const role = String(b.role || '');
      if (db.ROLE_LIST.indexOf(role) < 0) {
        return sendJson(res, 400, { error: '角色非法，可选：' + db.ROLE_LIST.join(' / ') });
      }
      db.setRole(target, role);
      db.logAudit({
        user_id: me.id, user: me.name, module: 'auth', action: '改角色',
        details: target + ' → ' + role
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

    /* ---- 权限矩阵（全量读）----
       与下面 role-scoped 的 GET /api/auth/permissions 不是一回事：
       那个是「我这个角色有哪些权限点」，这个给管理员看【所有模块 × 两档角色】。
       两档里只有「可读写」可编辑，所以 editableRole 直接给前端，
       免得前端再硬编码一次「只配 editor」这条规则。 */
    if (p === '/api/auth/permissions/matrix' && method === 'GET') {
      return sendJson(res, 200, {
        resources: matrixResources(),
        editableRole: db.ROLES.EDITOR,
        roles: [
          { role: db.ROLES.READER, label: db.ROLE_LABELS[db.ROLES.READER], editable: false },
          { role: db.ROLES.EDITOR, label: db.ROLE_LABELS[db.ROLES.EDITOR], editable: true }
        ],
        allowed: {
          [db.ROLES.READER]: allowedMap(db.ROLES.READER),
          [db.ROLES.EDITOR]: allowedMap(db.ROLES.EDITOR)
        }
      });
    }

    /* ---- 权限矩阵（改一格）----
       请求体两种形态：
         kind='rw'    → { role, resource, read, write }   读写/只读/无 三态
         kind='point' → { role, resource, allowed }        AI 能力开关
       服务端的硬边界：role 只接受「可读写」。仅可读那一档是全平台只读的基线，
       允许在界面上改它，就会出现「把 reader 的 plan:read 关掉、某人登录后
       首页都打不开」这种自伤配置。这里拦在服务端，不只是前端不给点。 */
    if (p === '/api/auth/permissions' && method === 'POST') {
      const b = await readBody(req);
      const role = String(b.role || '');
      const resource = String(b.resource || '').trim();
      if (role !== db.ROLES.EDITOR) {
        return sendJson(res, 400, {
          error: '「' + (db.ROLE_LABELS[db.ROLES.READER] || db.ROLES.READER)
            + '」是固定只读基线，不可配置；权限矩阵只配「'
            + (db.ROLE_LABELS[db.ROLES.EDITOR] || db.ROLES.EDITOR) + '」'
        });
      }
      if (!resource) return sendJson(res, 400, { error: '缺少 resource' });

      /* 只允许配【清单里存在】的资源。放任意字符串进来会让 permissions 表
         长出垃圾行 —— 门禁查不到它们，但下次有人翻表会以为规则生效了。 */
      const known = matrixResources().some(r => r.resource === resource
        || r.resource + ':read' === resource || r.resource + ':write' === resource);
      if (!known) return sendJson(res, 400, { error: '未知资源：' + resource });

      const hasWrite = Object.prototype.hasOwnProperty.call(b, 'write');
      const read = b.read ? 1 : 0, write = b.write ? 1 : 0;
      try {
        /* read / write 是一对，必须一起落地。分两条 UPDATE 中间失败会留下
           「read=1、write=0」的半截状态 —— 看着像「只读」，实际是配坏了。
           node:sqlite 没有事务辅助函数，手工 BEGIN/COMMIT 兜住。 */
        const conn = db.get();
        conn.exec('BEGIN');
        try {
          if (hasWrite) {
            db.setPermission(role, resource + ':read', read);
            db.setPermission(role, resource + ':write', write);
          } else {
            db.setPermission(role, resource, b.allowed ? 1 : 0);
          }
          conn.exec('COMMIT');
        } catch (e) {
          try { conn.exec('ROLLBACK'); } catch (e2) { /* 回滚失败就让异常冒出去 */ }
          throw e;
        }
      } catch (e) {
        return sendJson(res, 400, { error: '写入失败：' + e.message });
      }

      const detail = hasWrite
        ? resource + ' → ' + (read && write ? '读写' : (read ? '只读' : '无'))
        : resource + ' → ' + (b.allowed ? '开' : '关');
      db.logAudit({
        user_id: me.id, user: me.name, module: 'auth', action: '改权限',
        details: role + ' · ' + detail
      });
      return sendJson(res, 200, {
        ok: true,
        allowed: allowedMap(role)[hasWrite ? resource + ':read' : resource] || 0
      });
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
