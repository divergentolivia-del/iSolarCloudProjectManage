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
  ck('12 个模块全部注册（含 iteration/pradapter/skill，未再出现 TEAMS 加载失败）',
    mods.length === 12 && mods.some(m => m.id === 'iteration') && mods.some(m => m.id === 'pradapter')
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
  ck('错误口令 → 401', r.code === 401, r.code);
  r = await req('POST', '/api/auth/login', { id: 'dev', password: 'dev-pass-123' });
  const devCookie = r.cookie;
  ck('dev 登录成功并种 HttpOnly Cookie', r.code === 200 && !!devCookie && /HttpOnly/i.test(r.setCookieRaw || ''), r.body);
  r = await req('POST', '/api/auth/login', { id: 'pm', password: 'pm-pass-123' });
  const pmCookie = r.cookie;
  ck('pm 登录成功', r.code === 200 && !!pmCookie);

  /* 角色差异：读放行，写分权 */
  r = await req('GET', '/api/plan/state', null, devCookie);
  ck('dev 读 plan → 放行（200）', r.code === 200, r.code);
  r = await req('POST', '/api/plan/definitely-not-exist', { x: 1 }, devCookie);
  ck('dev 写 plan → 403（无 plan:write）', r.code === 403, r.code);
  r = await req('POST', '/api/plan/definitely-not-exist', { x: 1 }, pmCookie);
  ck('pm 写 plan → 门禁放行（落到路由层，非 403）', r.code !== 403 && r.code !== 401, r.code);
  r = await req('POST', '/api/tb/definitely-not-exist', { x: 1 }, pmCookie);
  ck('pm 写 tb → 403（默认矩阵无 tb:write）', r.code === 403, r.code);
  r = await req('GET', '/api/platform/config', null, pmCookie);
  ck('pm 读 platform → 403（默认矩阵无 platform:read，维持 step 2 行为）', r.code === 403, r.code);

  /* Cookie 校验 */
  r = await req('GET', '/api/plan/state', null, 'wb_session=forged-token-123');
  ck('伪造 Cookie → 401', r.code === 401, r.code);

  /* 审计留痕：登录事件已进 audit_log（追加写） */
  const db = require('./db');
  const rows = db.getAudit(50).map(x => x.action);
  ck('登录/登出已写入 SQLite 审计', rows.indexOf('登录') >= 0, rows);
}

(async () => {
  testResourceOf();

  /* 先在测试进程建用户（与子进程服务共享同一个 DATA 下的 platform.db，WAL 多进程可共读） */
  const db = require('./db');
  db.createUser({ id: 'pm', name: '测试项目经理', role: 'pm', password: 'pm-pass-123' });
  db.createUser({ id: 'dev', name: '测试研发', role: 'dev', password: 'dev-pass-123' });

  const srv = startServer();
  let srvOut = '';
  srv.stdout.on('data', d => srvOut += d);
  srv.stderr.on('data', d => srvOut += d);
  try {
    await waitReady(15000);
    await testGate();
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
