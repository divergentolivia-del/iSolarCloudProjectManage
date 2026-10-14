/* _db-test.js — db.js / audit.js 的回归测试
   运行：node --test _db-test.js

   覆盖点：
   1) 建表 + 默认权限种子
   2) 用户 CRUD、密码哈希与校验
   3) 会话签发/校验/过期/注销
   4) 权限判定（admin 放行、默认拒绝）
   5) 审计追加写不截断、按条件查询
   6) 旧 audit-log.json 迁移的幂等性
   7) 真实 200 条历史日志能完整迁进来（在临时目录里跑，不动 data/）
*/

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('./db');

/* 每个用例都用全新的内存库，互不干扰 */
function fresh() {
  db.useMemory();
  return db;
}

test('建表与默认权限种子', () => {
  fresh();
  const editor = db.listPermissions('editor');
  assert.ok(editor.includes('plan:write'), 'editor 应能写计划');
  assert.ok(!editor.includes('budget:write'), 'editor 不应能改预算基准');
  assert.ok(editor.includes('ai:doc'), 'editor 应能调文档 Agent');
  assert.ok(!editor.includes('ai:finance'), 'editor 不应能调财务 Agent');

  const reader = db.listPermissions('reader');
  assert.ok(reader.includes('plan:read'), 'reader 应能读计划');
  assert.ok(!reader.includes('plan:write'), 'reader 不应能写计划');
  assert.ok(!reader.includes('iteration:write'), 'reader 不应能写迭代');

  /* admin 不在权限表里，靠 hasPermission 特判 */
  assert.strictEqual(db.listPermissions('admin').length, 0);

  /* 旧角色名不该再有默认权限行 —— 留着会让权限矩阵凭空多出两列 */
  ['pm', 'dev', 'viewer'].forEach(r => {
    assert.strictEqual(db.listPermissions(r).length, 0, '旧角色 ' + r + ' 不应再有权限行');
  });
});

test('用户 CRUD 与密码哈希', () => {
  fresh();
  const u = db.createUser({ id: 'zhang', name: '张三', password: 'pw123456', role: 'editor' });
  assert.strictEqual(u.role, 'editor');
  assert.ok(u.password_hash.startsWith('scrypt$'), '应为加盐 scrypt 格式');
  assert.ok(!u.password_hash.includes('pw123456'), '明文绝不能出现在库里');

  assert.strictEqual(db.verifyPassword('pw123456', u.password_hash), true);
  assert.strictEqual(db.verifyPassword('pw123457', u.password_hash), false);
  assert.strictEqual(db.verifyPassword('pw123456', null), false);
  assert.strictEqual(db.verifyPassword('', 'garbage'), false);

  assert.throws(() => db.createUser({ id: 'zhang', name: '张三2' }), /已存在/);

  db.setPassword('zhang', 'newpw888');
  assert.strictEqual(db.verifyPassword('newpw888', db.findUser('zhang').password_hash), true);
  assert.strictEqual(db.verifyPassword('pw123456', db.findUser('zhang').password_hash), false);

  db.setRole('zhang', 'reader');
  assert.strictEqual(db.findUser('zhang').role, 'reader');
  assert.strictEqual(db.listUsers().length, 2, 'admin + zhang');

  /* 角色兜底为 reader，且非法角色直接拒绝 —— 静默写个拼错的值会让那人处处 403 */
  assert.strictEqual(db.createUser({ id: 'nobody', name: '无角色' }).role, 'reader');
  assert.throws(() => db.createUser({ id: 'typo', name: '拼错', role: 'editro' }), /角色非法/);
  assert.throws(() => db.createUser({ id: 'old', name: '旧值', role: 'viewer' }), /角色非法/);
});

test('会话签发 / 校验 / 注销 / 过期', () => {
  fresh();
  const { token, expiresAt } = db.createSession('admin');
  assert.ok(token.length > 20);
  assert.ok(new Date(expiresAt).getTime() > Date.now());

  const who = db.sessionUser(token);
  assert.strictEqual(who.id, 'admin');
  assert.strictEqual(who.role, 'admin');

  assert.strictEqual(db.sessionUser('不存在的token'), null);
  assert.strictEqual(db.sessionUser(''), null);
  assert.strictEqual(db.sessionUser(null), null);

  db.destroySession(token);
  assert.strictEqual(db.sessionUser(token), null, '注销后应失效');

  /* 手工塞一条已过期的会话 */
  db.get().prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)')
    .run('expired-token', 'admin', '2020-01-01', '2020-01-02');
  assert.strictEqual(db.sessionUser('expired-token'), null, '过期会话应拒绝');
  assert.strictEqual(
    db.get().prepare('SELECT COUNT(*) AS n FROM sessions WHERE token = ?').get('expired-token').n,
    0, '过期会话应被顺手清掉');

  /* 停用用户后，其已有会话立即失效 */
  const t2 = db.createSession('admin').token;
  db.get().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run('admin');
  assert.strictEqual(db.sessionUser(t2), null, '用户被停用后会话应失效');
});

test('权限判定：admin 放行，其余默认拒绝', () => {
  fresh();
  assert.strictEqual(db.hasPermission('admin', 'plan:write'), true);
  assert.strictEqual(db.hasPermission('admin', '随便什么资源'), true);

  assert.strictEqual(db.hasPermission('editor', 'plan:write'), true);
  assert.strictEqual(db.hasPermission('editor', 'budget:write'), false);
  assert.strictEqual(db.hasPermission('reader', 'plan:write'), false);
  assert.strictEqual(db.hasPermission('不存在的角色', 'plan:read'), false);
  assert.strictEqual(db.hasPermission(null, 'plan:read'), false);

  /* 改一条权限后立即生效 */
  db.setPermission('reader', 'plan:write', true);
  assert.strictEqual(db.hasPermission('reader', 'plan:write'), true);
  db.setPermission('reader', 'plan:write', false);
  assert.strictEqual(db.hasPermission('reader', 'plan:write'), false);
});

test('权限矩阵读得出 allowed 状态', () => {
  fresh();
  /* listPermissions 只回资源名；矩阵要的是 resource + allowed */
  const rows = db.getPermissions('editor');
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => typeof r.resource === 'string' && (r.allowed === 0 || r.allowed === 1)));
  assert.strictEqual(rows.find(r => r.resource === 'plan:read').allowed, 1);
  assert.strictEqual(rows.find(r => r.resource === 'plan:write').allowed, 1);

  /* 关掉一条后，getPermissions 应读出 0，而 listPermissions 仍会把它列出来
     （它不筛 allowed，是「这个角色定义过哪些权限点」的口径，不是「现在开着哪些」） */
  db.setPermission('editor', 'plan:write', false);
  assert.strictEqual(db.getPermissions('editor').find(r => r.resource === 'plan:write').allowed, 0);
  assert.strictEqual(db.hasPermission('editor', 'plan:write'), false);
  assert.ok(db.listPermissions('editor').includes('plan:write'));
});

test('角色模型迁移 v2：旧角色值改写 + 权限行清理 + 幂等', () => {
  fresh();
  /* 造出四种旧角色，外加一个不认识的，看迁移认不认它 */
  db.get().prepare('DELETE FROM users').run();
  const now = new Date().toISOString();
  const ins = db.get().prepare(
    'INSERT INTO users(id, name, role, enabled, created_at, updated_at) VALUES(?,?,?,1,?,?)');
  ins.run('a1', '甲', 'admin', now, now);
  ins.run('p1', '乙', 'pm', now, now);
  ins.run('d1', '丙', 'dev', now, now);
  ins.run('v1', '丁', 'viewer', now, now);
  ins.run('x1', '戊', 'weird-role', now, now);

  /* 清掉版本标记并重跑迁移，模拟「升级到新版后第一次启动」 */
  db.setMeta('role_model', '');
  db.open();
  db.migrateRoles();

  assert.strictEqual(db.findUser('a1').role, 'admin', 'admin 不动');
  assert.strictEqual(db.findUser('p1').role, 'editor', 'pm → editor');
  assert.strictEqual(db.findUser('d1').role, 'reader', 'dev → reader（旧矩阵里 dev 零写权限，不能提权给 editor）');
  assert.strictEqual(db.findUser('v1').role, 'reader', 'viewer → reader');
  assert.strictEqual(db.findUser('x1').role, 'weird-role', '不认识的角值原样保留，不猜');

  /* 旧角色的权限行应被清干净 */
  ['pm', 'dev', 'viewer'].forEach(r => {
    assert.strictEqual(
      db.get().prepare('SELECT COUNT(*) AS n FROM permissions WHERE role = ?').get(r).n, 0,
      '旧角色 ' + r + ' 的权限行应被清掉');
  });

  /* 幂等：再跑一次，人工改过的角色不能被冲掉 */
  db.setRole('v1', 'editor');
  db.migrateRoles();
  assert.strictEqual(db.findUser('v1').role, 'editor', '迁移必须只跑一次，否则会覆盖管理员的手工调整');
});

test('审计：追加写不截断，可按人/模块过滤', () => {
  fresh();
  const old = require('./audit');

  /* 连写 260 条，越过旧版的 200 上限 */
  for (let i = 0; i < 260; i++) {
    old.log({ user: i % 2 ? '陈丹萍' : '张三', module: 'plan', action: '更新数据', details: 'rev ' + i });
  }
  assert.strictEqual(old.count(), 260, '不能再有 200 条上限');

  const recent = old.getRecent(5);
  assert.strictEqual(recent.length, 5);
  assert.strictEqual(recent[0].details, 'rev 259', '应按写入顺序倒序');
  assert.strictEqual(recent[0].module, 'plan');
  assert.strictEqual(recent[0].user, '陈丹萍', '字段名应仍是 user，兼容旧调用方');

  assert.strictEqual(old.getRecent(1000, { user: '陈丹萍' }).length, 130);
  assert.strictEqual(old.getRecent(1000, { module: 'plan' }).length, 260);
  assert.strictEqual(old.getRecent(1000, { module: '不存在' }).length, 0);

  /* AI 字段默认不填 */
  assert.strictEqual(recent[0].ai_triggered, false);
  assert.strictEqual(recent[0].ai_adopted, null);
  old.log({ user: '张三', module: 'ai', action: '生成周报', ai_triggered: true, ai_adopted: true });
  const ai = old.getRecent(1)[0];
  assert.strictEqual(ai.ai_triggered, true);
  assert.strictEqual(ai.ai_adopted, true);
});

test('旧 audit-log.json 迁移：幂等 + 真实 200 条不丢', () => {
  const real = path.join(__dirname, 'data', 'audit-log.json');
  const hasReal = fs.existsSync(real);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-db-test-'));
  try {
    /* 用副本当 DATA_DIR，绝不碰仓库里的 data/ */
    if (hasReal) fs.copyFileSync(real, path.join(tmp, 'audit-log.json'));

    /* 重新加载 db/audit，让它们读到临时 DATA_DIR */
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./audit')];
    process.env.DATA_DIR = tmp;
    const d2 = require('./db');
    const a2 = require('./audit');
    d2.open();

    const r1 = a2.migrateLegacy();
    if (hasReal) {
      assert.strictEqual(r1.migrated, 200, '真实历史日志应 200 条全迁进来');
      assert.strictEqual(a2.count(), 200);
      /* 迁移后仍能按旧字段名读出来 */
      const one = a2.getRecent(200).find(x => x.details === 'rev 387');
      assert.ok(one, '应能查到已知的那条历史记录');
      assert.strictEqual(one.user, '陈丹萍');
      assert.strictEqual(one.timestamp, '2026/9/16 16:55:56', '本地时间字符串应原样保留');

      /* 顺序必须保住：旧文件首条（最新）现在还得排第一 */
      const newest = a2.getRecent(1)[0];
      assert.strictEqual(newest.details, 'rev 387', '迁移后最新的记录仍应排在最前');
      const oldest = a2.getRecent(200)[199];
      assert.strictEqual(oldest.details, 'rev 238', '最旧的一条应排在最后');

      assert.ok(fs.existsSync(path.join(tmp, 'audit-log.json.migrated')), '旧文件应被改名留档');
    }

    /* 再跑一次：不应重复导入 */
    const r2 = a2.migrateLegacy();
    assert.strictEqual(r2.migrated, 0);
    assert.ok(r2.skipped, '第二次应被跳过');
    if (hasReal) assert.strictEqual(a2.count(), 200, '重复迁移不能翻倍');

    d2.get().close();
  } finally {
    delete process.env.DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
