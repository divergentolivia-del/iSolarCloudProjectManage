/* inbox 模块自检：不启服务，直接打 routes.handle 的聚合与确认链路 */
'use strict';
const fs = require('fs');
const path = require('path');

/* 照 server.js 注入组织配置，否则 calc.js 拿不到全局 TEAMS，
   collectInputs 会静默返回 deviations=[] —— 本轮断言就全变成"空结果也算通过" */
const src = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
Object.assign(global, new Function(src +
  '\nreturn { TEAMS, PRODUCT_LINES, OTHER_CATEGORIES, LOCK_ROLES, LOCK_ROLE_TO_TEAM, OWNER_LINES, DEVIATION_TOLERANCE, IGNORED_TEAM_PATTERNS, RECONCILE_TOLERANCE };')());

const engine = require('./modules/skill/lib/engine');
const inbox = require('./modules/inbox/routes');

let pass = 0, fail = 0;
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* 极简 res 桩：把 handle 的输出抓下来 */
function call(req, pathname) {
  return new Promise(resolve => {
    const out = { code: null, body: null };
    const res = {
      headersSent: false,
      writeHead(c) { out.code = c; this.headersSent = true; return this; },
      end(s) { try { out.body = JSON.parse(s); } catch (e) { out.body = s; } resolve(out); },
      destroy() { resolve(out); }
    };
    req.method = req.method || 'GET';
    inbox.handle(req, res, { pathname: pathname });
    setTimeout(() => resolve(out), 200);   // 兜底，避免漏 resolve 时整个脚本挂住
  });
}

/* 简单 POST 桩：模拟 data/end 事件流 */
function post(pathname, obj) {
  const req = {
    method: 'POST',
    on(ev, fn) {
      if (ev === 'data') fn(Buffer.from(JSON.stringify(obj)));
      if (ev === 'end') setTimeout(fn, 0);
      return this;
    },
    destroy() {}
  };
  return call(req, pathname);
}

(async function main() {
  console.log('== 0) 先确保有数据：重跑三个 Skill ==');
  const inp = engine.collectInputs();
  ck('偏差输入非空（TEAMS 已注入）', inp.deviations.length > 0, inp.deviations.length);
  ['risk', 'variance', 'report'].forEach(id => engine.run(id));

  console.log('== 1) GET /api/inbox 聚合 ==');
  const r = await call({ method: 'GET' }, '/api/inbox');
  ck('HTTP 200', r.code === 200, r.code);
  const d = r.body || {};
  ck('total 与 items 长度一致', d.total === (d.items || []).length, { total: d.total, len: (d.items || []).length });
  ck('基础三个 Skill 都在 bySkill 里（存在性断言，不写死总数——新增 Skill 不应破坏本测试）',
  ['risk', 'variance', 'report'].every(id => (d.bySkill || []).some(x => x.id === id)),
  (d.bySkill || []).map(x => x.id));
  ck('bySkill 的 pendingCount 之和 == total',
    (d.bySkill || []).reduce((a, s) => a + s.pendingCount, 0) === d.total,
    { sum: (d.bySkill || []).reduce((a, s) => a + s.pendingCount, 0), total: d.total });
  ck('high 计数与实际条目一致',
    d.high === (d.items || []).filter(i => i.severity === 'high').length,
    { high: d.high });
  /* 2026-09-22 起风险 Skill 不再复述产能偏差，演示数据里没有强信号，
     所以这里不再断言「一定有高风险」（那是在断言数据，不是在断言代码）。
     改成断言口径自洽：high 计数必须等于列表里真正的 high 条数，且不为负。 */
  ck('high 计数不为负且不超过总数', d.high >= 0 && d.high <= d.total, { high: d.high, total: d.total });

  console.log('== 2) 严重度必须是 canonical 值（这是本轮修的 bug）==');
  const bad = (d.items || []).filter(i => ['high', 'medium', 'low'].indexOf(i.severity) < 0);
  ck('没有非 canonical 的 severity', bad.length === 0, bad.slice(0, 3).map(x => x.severity));
  const cns = (d.items || []).filter(i => /[一-龥]/.test(String(i.severity)));
  ck('没有中文 severity 混进来', cns.length === 0, cns.slice(0, 3).map(x => x.severity));

  console.log('== 3) 排序：high 必须在最前 ==');
  const sevs = (d.items || []).map(i => i.severity);
  const firstNonHigh = sevs.findIndex(s => s !== 'high');
  const lastHigh = sevs.lastIndexOf('high');
  ck('高风险项全部排在非高风险之前', lastHigh < 0 || firstNonHigh < 0 || lastHigh < firstNonHigh,
    { firstNonHigh, lastHigh });

  console.log('== 4) POST /api/inbox/confirm 采纳链路 ==');
  const target = (d.items || [])[0];
  ck('有可确认的项', !!target);
  if (target) {
    const before = d.total;
    const rc = await post('/api/inbox/confirm', { resultId: target.resultId, itemId: target.itemId, yes: true });
    ck('确认返回 200', rc.code === 200, { code: rc.code, body: rc.body });
    ck('确认 ok=true', rc.body && rc.body.ok === true, rc.body);

    const r2 = await call({ method: 'GET' }, '/api/inbox');
    ck('确认后 total 减 1', r2.body.total === before - 1, { before: before, after: r2.body.total });
    ck('被确认的项已不在列表里',
      !(r2.body.items || []).some(i => i.itemId === target.itemId), target.itemId);
    ck('确认后采纳数 +1',
      (r2.body.bySkill || []).find(s => s.id === target.skill).adopted > 0,
      (r2.body.bySkill || []).find(s => s.id === target.skill));
  }

  console.log('== 5) 重复确认同一项必须被拒 ==');
  if (target) {
    const again = await post('/api/inbox/confirm', { resultId: target.resultId, itemId: target.itemId, yes: true });
    ck('重复确认返回 404', again.code === 404, again.code);
    ck('报错文案说明已处理', /已处理/.test((again.body || {}).error || ''), again.body);
  }

  console.log('== 6) 参数缺失必须 400 ==');
  const bad1 = await post('/api/inbox/confirm', { itemId: 'x' });
  ck('缺 resultId → 400', bad1.code === 400, bad1.code);
  const bad2 = await post('/api/inbox/confirm', { resultId: 'x' });
  ck('缺 itemId → 400', bad2.code === 400, bad2.code);

  console.log('== 7) 未知路径 404 ==');
  const nf = await call({ method: 'GET' }, '/api/inbox/nope');
  ck('未知路径 → 404', nf.code === 404, nf.code);

  console.log('');
  console.log('inbox 自检：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
