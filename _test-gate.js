/* 权限门禁 + 资源注册表 e2e（M1 Step 3 验收）：
   - AUTH_REQUIRED=1：未登录 401、dev 写 403、pm 写放行、伪造 Cookie 401
   - 模块资源自动注册：PREFIX_RESOURCE 已删除，模块 resource 由
     modules/<id>/routes.js 声明（缺省取 id），module-loader 注册表统一管理
   - 内置路由（/api/platform、/api/archive）仍按资源名校验
   子进程起服务（临时数据目录），跑完自动清理。风格与 _test-server.js 一致。 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8795;
const DATA = path.join(os.tmpdir(), 'wbtest-gate-' + process.pid);
/* 必须在任何 require 之前指向临时目录：
   ml.loadAll() 会连带加载 auth 模块 → require('../../db')，
   db.js 在模块顶层读 DATA_DIR env，晚设就会绑到项目真实 data/ 目录。 */
process.env.DATA_DIR = DATA;
fs.mkdirSync(DATA, { recursive: true });
let pass = 0, fail = 0;
function ck(n, c, extra) {
  if (c) { pass++; console.log('  PASS ' + n); }
  else { fail++; console.log('  FAIL ' + n, extra !== undefined ? JSON.stringify(extra) : ''); }
}

function req(method, p, body, cookie) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: 'localhost', port: PORT, path: p, method, headers },
      resp => {
        let b = '';
        resp.on('data', c => b += c);
        resp.on('end', () => {
          let j = null; try { j = JSON.parse(b); } catch (e) {}
          const sc = (resp.headers['set-cookie'] || []).find(c => c.startsWith('wb_session='));
          res({ code: resp.statusCode, body: j, cookie: sc ? sc.split(';')[0] : null, setCookieRaw: sc || null });
        });
      });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 进程内：resourceOf 注册表断言（模拟 server.js 的启动环境） ---------- */

function testResourceOf() {
  console.log('\n[0] moduleLoader.resourceOf（资源注册表）');
  /* 与 server.js 相同的 config 注入（calc/iteration 模块依赖 global.TEAMS） */
  const src = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
  Object.assign(global, new Function(src + '\nreturn { TEAMS, PRODUCT_LINES, OTHER_CATEGORIES, LOCK_ROLES, LOCK_ROLE_TO_TEAM, OWNER_LINES, DEVIATION_TOLERANCE, IGNORED_TEAM_PATTERNS, RECONCILE_TOLERANCE };')());
  const ml = require('./module-loader');
  ml.loadAll();
  const mods = ml.list();
  ck('核心模块已注册（存在性断言：iteration/pradapter/skill，不再写死总数）',
    mods.some(m => m.id === 'iteration') && mods.some(m => m.id === 'pradapter')
    && mods.some(m => m.id === 'skill'),
    mods.map(m => m.id).join(','));
  ck('pradapter 模块 resource 归属', ml.resourceOf('/api/pradapter/state') === 'pradapter', ml.resourceOf('/api/pradapter/state'));
  ck('两段路径 → 模块 resource', ml.resourceOf('/api/plan/xxx') === 'plan', ml.resourceOf('/api/plan/xxx'));
  ck('单段路径 → 模块 resource', ml.resourceOf('/api/iteration') === 'iteration');
  ck('tb 模块自动注册', ml.resourceOf('/api/tb/abc') === 'tb');
  ck('settings 模块自动注册（不再靠 server.js 手工表）', ml.resourceOf('/api/settings') === 'settings');
  ck('auth 模块自动注册', ml.resourceOf('/api/auth/login') === 'auth');
  ck('内置路由 /api/platform 不在模块注册表（由 server.js BUILTIN_RESOURCE 接管）',
    ml.resourceOf('/api/platform/config') === '');
  ck('未知路径 → 空（门禁放行静态资源）', ml.resourceOf('/api/no-such') === '');
}

/* ---------- 子进程：AUTH_REQUIRED=1 门禁 e2e ---------- */

function startServer() {
  return spawn(process.execPath, [path.join(__dirname, 'server.js'), String(PORT)], {
    env: Object.assign({}, process.env, {
      DATA_DIR: DATA, PORT: String(PORT), AUTH_REQUIRED: '1', ACCESS_TOKEN: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitReady(timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await req('GET', '/api/auth/me');
      if (r.code === 200) return;
    } catch (e) { /* 未就绪 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('服务未在时限内就绪');
    await sleep(300);
  }
}

async function testGate() {
  console.log('\n[1] AUTH_REQUIRED=1 门禁');

  let r = await req('GET', '/api/plan/state');
  ck('未登录读 → 401', r.code === 401, r.code);
  r = await req('GET', '/api/platform/audit');
  ck('未登录读审计 → 401', r.code === 401, r.code);
  r = await req('GET', '/no-such.html');
  ck('未登录页面请求 → 302 跳登录页（带回跳地址）', r.code === 302, r.code);
  r = await req('GET', '/api/no-such-page');
  ck('未登录 API 请求 → 401 JSON', r.code === 401, r.code);

  /* 登录 */
  r = await req('POST', '/api/auth/login', { id: 'pm', password: 'wrong-pass' });
  ck('错误密码 → 401', r.code === 401, r.code);
  r = await req('POST', '/api/auth/login', { id: 'dev', password: 'dev-pass-123' });
  const devCookie = r.cookie;
  ck('reader 账号登录成功并种 HttpOnly Cookie', r.code === 200 && !!devCookie && /HttpOnly/i.test(r.setCookieRaw || ''), r.body);
  r = await req('POST', '/api/auth/login', { id: 'pm', password: 'pm-pass-123' });
  const pmCookie = r.cookie;
  ck('editor 账号登录成功', r.code === 200 && !!pmCookie);

  /* 角色差异：读放行，写分权 */
  r = await req('GET', '/api/plan/state', null, devCookie);
  ck('reader 读 plan → 放行（200）', r.code === 200, r.code);
  r = await req('POST', '/api/plan/definitely-not-exist', { x: 1 }, devCookie);
  ck('reader 写 plan → 403（无 plan:write）', r.code === 403, r.code);
  r = await req('POST', '/api/plan/definitely-not-exist', { x: 1 }, pmCookie);
  ck('editor 写 plan → 门禁放行（落到路由层，非 403）', r.code !== 403 && r.code !== 401, r.code);
  r = await req('POST', '/api/tb/definitely-not-exist', { x: 1 }, pmCookie);
  ck('editor 写 tb → 403（默认矩阵无 tb:write）', r.code === 403, r.code);
  r = await req('GET', '/api/platform/config', null, pmCookie);
  ck('editor 读 platform → 403（默认矩阵无 platform:read，维持 step 2 行为）', r.code === 403, r.code);

  /* Cookie 校验 */
  r = await req('GET', '/api/plan/state', null, 'wb_session=forged-token-123');
  ck('伪造 Cookie → 401', r.code === 401, r.code);

  /* 审计留痕：登录事件已进 audit_log（追加写） */
  const db = require('./db');
  const rows = db.getAudit(50).map(x => x.action);
  ck('登录/登出已写入 SQLite 审计', rows.indexOf('登录') >= 0, rows);
}

/* ---------- 子进程：登录节流 ---------- */

async function testThrottle() {
  console.log('\n[2] 登录节流（连错锁定）');

  /* 用一个独立账号，别污染上面 pm/dev 的会话 */
  /* 第 1~4 次错：普通 401，和平时一样 */
  let last = null;
  for (let i = 1; i <= 4; i++) {
    last = await req('POST', '/api/auth/login', { id: 'lockme', password: 'nope-' + i });
  }
  ck('连错 4 次仍是普通 401（还没到阈值）', last.code === 401 && /账号或密码不正确/.test(last.body.error || ''), last);

  /* 第 5 次错：触发锁定，必须换文案 */
  last = await req('POST', '/api/auth/login', { id: 'lockme', password: 'nope-5' });
  ck('第 5 次错 → 429 且明说「临时锁定」', last.code === 429 && /锁定/.test(last.body.error || ''), last);

  /* 锁定期内，即使密码正确也进不来 —— 否则锁形同虚设 */
  const afterLock = await req('POST', '/api/auth/login', { id: 'lockme', password: 'lock-pass-123' });
  ck('锁定期内正确密码也进不来（429）', afterLock.code === 429, afterLock.code);

  /* 换个没试过的账号不受影响 —— 锁的粒度是账号，不是一刀切 */
  const other = await req('POST', '/api/auth/login', { id: 'dev', password: 'dev-pass-123' });
  ck('锁定期内别的账号照常登录（不是全局封锁）', other.code === 200, other.code);
}

/* ---------- 子进程：权限矩阵 + 新建用户（2026-10-14 新增） ---------- */

async function testMatrix(adminCookie, editorCookie) {
  console.log('\n[3] 权限矩阵');

  let r = await req('GET', '/api/auth/permissions/matrix', null, editorCookie);
  ck('非 admin 读矩阵 → 403', r.code === 403, r.code);
  r = await req('POST', '/api/auth/permissions', { role: 'editor', resource: 'plan', read: true, write: true }, editorCookie);
  ck('非 admin 改矩阵 → 403', r.code === 403, r.code);

  r = await req('GET', '/api/auth/permissions/matrix', null, adminCookie);
  const m = r.body || {};
  ck('admin 读矩阵 → 200', r.code === 200 && Array.isArray(m.resources), r.code);
  ck('矩阵列出模块（含 plan）', (m.resources || []).some(x => x.resource === 'plan' && x.kind === 'rw'));
  ck('矩阵含 AI 能力组', (m.resources || []).some(x => x.resource === 'ai:finance' && x.kind === 'point'));
  ck('可编辑角色只有 editor', m.editableRole === 'editor', m.editableRole);
  ck('reader 在角色列表里且不可编辑',
    (m.roles || []).some(x => x.role === 'reader' && x.editable === false));
  ck('矩阵带两档 allowed 状态',
    !!(m.allowed && m.allowed.reader && m.allowed.editor));

  /* 把 plan 对 editor 改成「只读」：读放行、写必须立刻 403 */
  r = await req('POST', '/api/auth/permissions',
    { role: 'editor', resource: 'plan', read: true, write: false }, adminCookie);
  ck('admin 把 plan 设为只读 → 200', r.code === 200, r.body);
  r = await req('POST', '/api/plan/definitely-not-exist', { x: 1 }, editorCookie);
  ck('设只读后 editor 写 plan → 403', r.code === 403, r.code);
  r = await req('GET', '/api/plan/state', null, editorCookie);
  ck('设只读后 editor 读 plan 仍 200', r.code === 200, r.code);

  /* 改回去，别污染后面的用例 */
  r = await req('POST', '/api/auth/permissions',
    { role: 'editor', resource: 'plan', read: true, write: true }, adminCookie);
  ck('恢复 plan 读写 → 200', r.code === 200);
  r = await req('POST', '/api/plan/definitely-not-exist', { x: 1 }, editorCookie);
  ck('恢复后 editor 写 plan → 非 403', r.code !== 403 && r.code !== 401, r.code);

  /* 服务端硬边界：只配「可读写」一档 */
  r = await req('POST', '/api/auth/permissions',
    { role: 'reader', resource: 'plan', read: true, write: true }, adminCookie);
  ck('改「仅可读」档 → 400（固定只读基线，不可配）', r.code === 400, r.body && r.body.error);
  r = await req('POST', '/api/auth/permissions',
    { role: 'editor', resource: 'no-such-module', read: true, write: true }, adminCookie);
  ck('未知资源 → 400', r.code === 400, r.body && r.body.error);
}

async function testNewUser(adminCookie) {
  console.log('\n[4] 新建用户（含外包密码公式）');

  /* 外包：账号 = 姓名拼音，密码 = 缩写首字母大写 + outsourcedPasswordSuffix */
  let r = await req('POST', '/api/auth/users',
    { id: 'zhangsan', name: '张三', prefix: 'zs', role: 'reader', kind: 'outsourced' }, adminCookie);
  ck('建外包号 → 200 且一次性返回密码', r.code === 200 && r.body && !!r.body.password, r.body);
  ck('外包密码 = Zs20261024', r.body && r.body.password === 'Zs20261024', r.body && r.body.password);

  /* 拿这个密码真登一遍 —— 公式对不对，登录接口说了算 */
  r = await req('POST', '/api/auth/login', { id: 'zhangsan', password: 'Zs20261024' });
  ck('外包号能用生成的密码登录', r.code === 200, r.code);

  /* 内部：密码 = 缩写首字母大写 + 年份 + 工号后 4 位 */
  r = await req('POST', '/api/auth/users',
    { id: '10017968', name: '陈丹萍', prefix: 'cdp', role: 'editor', kind: 'internal' }, adminCookie);
  ck('建内部号 → 密码 = Cdp20267968', r.body && r.body.password === 'Cdp20267968', r.body && r.body.password);
  ck('内部号角色落到 editor', r.body && r.body.user && r.body.user.role === 'editor');

  /* 缩写大小写不敏感：LS / ls / Ls 都规范成 Ls。
     工号取【后 4 位】—— 10017001 的末四位是 7001，不是 0001。 */
  r = await req('POST', '/api/auth/users',
    { id: '10017001', name: '李四', prefix: 'LS', role: 'reader', kind: 'internal' }, adminCookie);
  ck('缩写大小写归一（LS → Ls）', r.body && r.body.password === 'Ls20267001', r.body && r.body.password);

  /* 服务端校验：前端是浏览器里的东西，绕过它直接 POST 一样能建号 */
  r = await req('POST', '/api/auth/users',
    { id: 'noprefix', name: '无缩写', role: 'reader', kind: 'outsourced' }, adminCookie);
  ck('缺姓名缩写 → 400', r.code === 400, r.body && r.body.error);
  r = await req('POST', '/api/auth/users',
    { id: 'badrole', name: '拼错角色', prefix: 'br', role: 'viewer', kind: 'outsourced' }, adminCookie);
  ck('旧角色值 viewer → 400', r.code === 400, r.body && r.body.error);
  r = await req('POST', '/api/auth/users',
    { id: 'abc', name: '内部短工号', prefix: 'ab', role: 'reader', kind: 'internal' }, adminCookie);
  ck('内部号工号不足 4 位 → 400（拼不出后 4 位）', r.code === 400, r.body && r.body.error);
  r = await req('POST', '/api/auth/users',
    { id: 'zhangsan', name: '张三', prefix: 'zs', role: 'reader', kind: 'outsourced' }, adminCookie);
  ck('账号重复 → 400', r.code === 400, r.body && r.body.error);

  /* ★ 审计里绝不能出现密码：操作记录区块是全平台可见的 */
  const db2 = require('./db');
  const newUserLogs = db2.getAudit(50).filter(x => x.action === '新建用户');
  ck('建号写了审计', newUserLogs.length >= 3, newUserLogs.length);
  ck('审计不含密码明文',
    newUserLogs.every(x => !/Zs20261024|Cdp20267968|Ls20267001/.test(
      String(x.details || '') + String(x.user_name || ''))),
    newUserLogs.map(x => x.details));
}

(async () => {
  testResourceOf();

  /* 先在测试进程建用户（与子进程服务共享同一个 DATA 下的 platform.db，WAL 多进程可共读）
     账号名仍是 pm/dev（历史沿用），但角色已按 2026-10-14 的模型收敛为 editor/reader ——
     这一对承担的正是「有 plan:write / 无 plan:write」的差异，改名后语义完全对应。 */
  const db = require('./db');
  db.createUser({ id: 'pm', name: '测试可读写', role: 'editor', password: 'pm-pass-123' });
  db.createUser({ id: 'dev', name: '测试仅可读', role: 'reader', password: 'dev-pass-123' });
  db.createUser({ id: 'lockme', name: '节流测试号', role: 'reader', password: 'lock-pass-123' });
  /* admin 是首次建库时随机密码造的，这里改成一个已知值才能登进去测矩阵。
     注意：改的是临时 DATA 下的副本库，不碰仓库的 data/platform.db。 */
  db.setPassword('admin', 'admin-pass-123');

  const srv = startServer();
  let srvOut = '';
  srv.stdout.on('data', d => srvOut += d);
  srv.stderr.on('data', d => srvOut += d);
  try {
    await waitReady(15000);
    await testGate();
    await testThrottle();

    /* 矩阵与建号要 admin 会话。放在节流测试【之后】：
       节流那组会把 lockme 锁住，顺序换了不影响结论，但先跑完干净的更易读。 */
    const admin = await req('POST', '/api/auth/login', { id: 'admin', password: 'admin-pass-123' });
    ck('admin 登录成功（临时库里已把随机密码改成已知值）', admin.code === 200, admin.code);
    const editor = await req('POST', '/api/auth/login', { id: 'pm', password: 'pm-pass-123' });
    if (admin.cookie) {
      await testMatrix(admin.cookie, editor.cookie);
      await testNewUser(admin.cookie);
    }
  } finally {
    try { srv.kill(); } catch (e) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  if (fail > 0) process.exit(1);
})().catch(e => {
  console.error('测试异常：', e && e.message);
  process.exit(1);
});
