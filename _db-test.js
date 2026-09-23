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
  const pm = db.listPermissions('pm');
  assert.ok(pm.includes('plan:write'), 'pm 应能写计划');
  assert.ok(!pm.includes('budget:write'), 'pm 不应能改预算基准');
  assert.ok(pm.includes('ai:doc'), 'pm 应能调文档 Agent');

  const dev = db.listPermissions('dev');
  assert.ok(dev.includes('plan:read'), 'dev 应能读计划');
  assert.ok(!dev.includes('plan:write'), 'dev 不应能直接写计划');

  /* admin 不在权限表里，靠 hasPermission 特判 */
  assert.strictEqual(db.listPermissions('admin').length, 0);
});

test('用户 CRUD 与密码哈希', () => {
  fresh();
  const u = db.createUser({ id: 'zhang', name: '张三', password: 'pw123456', role: 'pm' });
  assert.strictEqual(u.role, 'pm');
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

  db.setRole('zhang', 'dev');
  assert.strictEqual(db.findUser('zhang').role, 'dev');
  assert.strictEqual(db.listUsers().length, 2, 'admin + zhang');
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

  assert.strictEqual(db.hasPermission('pm', 'plan:write'), true);
  assert.strictEqual(db.hasPermission('pm', 'budget:write'), false);
  assert.strictEqual(db.hasPermission('dev', 'plan:write'), false);
  assert.strictEqual(db.hasPermission('viewer', 'plan:write'), false);
  assert.strictEqual(db.hasPermission('不存在的角色', 'plan:read'), false);
  assert.strictEqual(db.hasPermission(null, 'plan:read'), false);

  /* 改一条权限后立即生效 */
  db.setPermission('dev', 'plan:write', true);
  assert.strictEqual(db.hasPermission('dev', 'plan:write'), true);
  db.setPermission('dev', 'plan:write', false);
  assert.strictEqual(db.hasPermission('dev', 'plan:write'), false);
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
